#!/usr/bin/env python3
"""Back up private data, verify a snapshot, or restore into a new directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import sqlite3
import uuid
from data_backup.files import OPAQUE_NAMES, copy_file, hash_file, open_regular, record, regular_tree, same_file
from data_backup.sqlite_copy import copy_database, fingerprint

MANIFEST = '.openbot-backup.json'
REHEARSAL = '.openbot-migration-copy.json'


def write_private(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def directory(path):
    value = Path(path).absolute()
    if value.is_symlink() or not value.is_dir():
        raise ValueError('Source must be an existing directory, not a link')
    return value.resolve()


def destination(path, source):
    value = Path(path).absolute()
    parent = value.parent.resolve(strict=True)
    value = parent / value.name
    if value.exists() or value.is_symlink() or value == source or source in value.parents:
        raise ValueError('Destination must be new and outside the source directory')
    return value


def backup(source, target, quiesced=False):
    source = directory(source)
    target = destination(target, source)
    pending = target.with_name('.' + target.name + '.incomplete-' + uuid.uuid4().hex)
    pending.mkdir(mode=0o700)
    entries, skipped = regular_tree(source)
    databases = set()
    for path in entries:
        if path.name in OPAQUE_NAMES:
            continue
        fd, info = open_regular(path)
        try:
            if os.read(fd, 16) == b'SQLite format 3\0':
                databases.add(path)
            same_file(path, info)
        finally:
            os.close(fd)
    records = []
    for path in entries:
        relative = path.relative_to(source)
        if path.name in (MANIFEST, REHEARSAL):
            continue
        if any(path == Path(str(database) + suffix) for suffix in ('-wal', '-shm', '-journal') for database in databases):
            skipped.append({'path': str(relative), 'reason': 'sqlite-sidecar-in-online-backup'})
            continue
        output = pending / relative
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if path in databases:
            fd, info = open_regular(path)
            try:
                copy_database(path, output)
                same_file(path, info)
            finally:
                os.close(fd)
            os.chmod(output, 0o600)
            item = record(output, relative, 'sqlite', 0o600)
            item['tables'] = fingerprint(output)
        else:
            mode = copy_file(path, output)
            item = record(output, relative, 'file', mode)
        records.append(item)
    manifest = {'version': 1, 'source': str(source), 'quiesced': quiesced,
                'consistency': 'Per-database SQLite transaction. Whole-tree consistency requires all writers stopped.',
                'files': records, 'skipped': skipped}
    write_private(pending / MANIFEST, manifest)
    pending.rename(target)
    return {'files': len(records), 'databases': len(databases), 'skipped': len(skipped),
            'quiesced': quiesced, 'manifestSha256': hash_file(target / MANIFEST)}


def verify(source):
    source = directory(source)
    fd, _ = open_regular(source / MANIFEST)
    with os.fdopen(fd, 'r') as stream:
        manifest = json.load(stream)
    if manifest.get('version') != 1 or not isinstance(manifest.get('files'), list):
        raise ValueError('Invalid backup manifest')
    expected = set()
    for item in manifest['files']:
        relative = Path(item['path'])
        if relative.is_absolute() or '..' in relative.parts or str(relative) in expected:
            raise ValueError('Invalid backup entry')
        expected.add(str(relative))
        path = source / relative
        for parent in path.parents:
            if parent == source:
                break
            if parent.is_symlink():
                raise ValueError('Backup contains a linked directory')
        fd, info = open_regular(path)
        os.close(fd)
        if info.st_size != item['size'] or info.st_mode & 0o077:
            raise ValueError('Backup content or permissions changed')
        if item.get('opaque'):
            if path.name not in OPAQUE_NAMES or item.get('sha256'):
                raise ValueError('Invalid opaque entry')
        elif hash_file(path) != item['sha256']:
            raise ValueError('Backup digest mismatch')
        if item['kind'] == 'sqlite' and fingerprint(path) != item['tables']:
            raise ValueError('Backup SQLite fingerprint mismatch')
    actual, skipped = regular_tree(source)
    if skipped or {str(p.relative_to(source)) for p in actual} != expected | {MANIFEST}:
        raise ValueError('Unexpected files or links in backup')
    return manifest


def restore(source, target, rehearsal=False):
    source = directory(source)
    manifest = verify(source)
    target = destination(target, source)
    pending = target.with_name('.' + target.name + '.incomplete-' + uuid.uuid4().hex)
    pending.mkdir(mode=0o700)
    for item in manifest['files']:
        output = pending / item['path']
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        copy_file(source / item['path'], output)
    if rehearsal:
        write_private(pending / REHEARSAL, {'version': 1, 'purpose': 'offline-migration-rehearsal',
                      'backup': str(source), 'manifestSha256': hash_file(source / MANIFEST)})
    pending.rename(target)
    return {'files': len(manifest['files']), 'rehearsal': rehearsal}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['backup', 'verify', 'restore'])
    parser.add_argument('--source', required=True)
    parser.add_argument('--destination')
    parser.add_argument('--quiesced', action='store_true', help='Record that all writers have already been stopped by the operator')
    parser.add_argument('--rehearsal', action='store_true', help='Mark a restored copy for the offline Rust migration probe')
    args = parser.parse_args()
    if args.operation != 'verify' and not args.destination:
        parser.error('--destination is required')
    if sqlite3.sqlite_version_info < (3, 37, 0):
        print('SQLite 3.37 or newer is required to back up modern browser databases.', file=sys.stderr)
        return 1
    os.umask(0o077)
    try:
        if args.operation == 'backup':
            result = backup(args.source, args.destination, args.quiesced)
        elif args.operation == 'restore':
            result = restore(args.source, args.destination, args.rehearsal)
        else:
            manifest = verify(args.source)
            result = {'verified': True, 'files': len(manifest['files'])}
        print(json.dumps(result))
    except (OSError, ValueError, sqlite3.Error) as error:
        print('Backup operation failed (' + type(error).__name__ + '). Incomplete directories are not valid snapshots.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
