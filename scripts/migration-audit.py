#!/usr/bin/env python3
"""Compare an offline migrated copy with its backup without publishing row contents."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from data_backup.files import hash_file, OPAQUE_NAMES
from data_backup.sqlite_copy import fingerprint, quoted


def data_rows(path, table):
    database = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
    try:
        columns = {row[1] for row in database.execute('PRAGMA table_info(' + quoted(table) + ')')}
        if not {'id', 'data'} <= columns:
            return {}
        return {key: json.loads(value) for key, value in database.execute('SELECT id,data FROM ' + quoted(table))}
    finally:
        database.close()


def changed_fields(before, after):
    result = {}
    for key in before.keys() & after.keys():
        old, new = before[key], after[key]
        if not isinstance(old, dict) or not isinstance(new, dict):
            continue
        for field in old.keys() | new.keys():
            if old.get(field) != new.get(field):
                result[field] = result.get(field, 0) + 1
    return result


def baseline(snapshot):
    source = snapshot / 'platform-migration-baseline.json'
    if not source.exists():
        return None
    expected = json.loads(source.read_text())
    database = sqlite3.connect((snapshot/'openbot.sqlite').resolve().as_uri() + '?mode=ro', uri=True)
    result = {}
    try:
        for table, previous in expected.items():
            rows = [{'id': key, 'data': data} for key, data in database.execute('SELECT id,data FROM ' + quoted(table) + ' ORDER BY id')]
            digest = hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
            result[table] = {'count': len(rows), 'baselineCount': previous['count'], 'matches': digest == previous['sha256']}
    finally:
        database.close()
    return result


def audit(snapshot, migrated):
    snapshot, migrated = snapshot.resolve(), migrated.resolve()
    manifest = json.loads((snapshot/'.openbot-backup.json').read_text())
    marker = json.loads((migrated/'.openbot-migration-copy.json').read_text())
    if marker.get('manifestSha256') != hash_file(snapshot/'.openbot-backup.json') or Path(marker.get('backup','')).resolve() != snapshot:
        raise ValueError('The migrated copy does not belong to this verified snapshot')
    changes, preserved, files_changed, opaque = [], 0, [], 0
    for item in manifest['files']:
        relative = Path(item['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Unsafe snapshot entry')
        old, new = snapshot/relative, migrated/relative
        if item['kind'] == 'sqlite':
            before, after = item['tables'], fingerprint(new)
            altered = {}
            for table, original in before.items():
                current = after.get(table)
                if current == original:
                    preserved += 1
                    continue
                entry = {'beforeCount': original['count'], 'afterCount': current['count'] if current else None,
                         'primaryKeysUnchanged': current is not None and current['keysSha256'] == original['keysSha256']}
                old_rows, new_rows = data_rows(old,table), data_rows(new,table) if current else {}
                entry['changedFields'] = changed_fields(old_rows,new_rows)
                entry['addedRows'] = len(new_rows.keys()-old_rows.keys())
                entry['removedRows'] = len(old_rows.keys()-new_rows.keys())
                altered[table] = entry
            changes.append({'database': str(relative), 'changedTables': altered, 'newTables': sorted(after.keys()-before.keys())})
        elif relative.name in OPAQUE_NAMES:
            opaque += 1
            if new.stat().st_size != item['size']:
                files_changed.append(str(relative))
        elif not new.is_file() or new.is_symlink() or hash_file(new) != item['sha256']:
            files_changed.append(str(relative))
    return {'version': 1, 'baseline': baseline(snapshot), 'preservedTables': preserved,
            'databases': changes, 'changedOriginalFiles': files_changed, 'opaqueFilesNotDecoded': opaque,
            'sourceWasQuiesced': manifest['quiesced']}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot',required=True)
    parser.add_argument('--copy',required=True)
    parser.add_argument('--report',required=True)
    args=parser.parse_args()
    os.umask(0o077)
    report=audit(Path(args.snapshot),Path(args.copy))
    with os.fdopen(os.open(args.report,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as output:
        json.dump(report,output,ensure_ascii=False,indent=2)
    print(json.dumps({'databases':len(report['databases']),'preservedTables':report['preservedTables'],
                      'changedTables':sum(len(db['changedTables']) for db in report['databases']),
                      'changedOriginalFiles':len(report['changedOriginalFiles'])}))


if __name__=='__main__':
    main()
