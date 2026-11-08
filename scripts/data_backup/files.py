"""Private copies reject links and never interpret operator setup codes."""
import hashlib
import os
from pathlib import Path
import shutil
import stat

OPAQUE_NAMES = {'operator-setup-code'}


def open_regular(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        os.close(fd)
        raise ValueError('Only regular files can be copied')
    return fd, info


def same_file(path, info):
    current = os.lstat(path)
    if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
        raise ValueError('A source file changed identity during backup')
    return current


def hash_file(path):
    fd, info = open_regular(path)
    try:
        hasher = hashlib.sha256()
        while True:
            block = os.read(fd, 1024 * 1024)
            if not block:
                break
            hasher.update(block)
        same_file(path, info)
        return hasher.hexdigest()
    finally:
        os.close(fd)


def copy_file(source, target):
    fd, before = open_regular(source)
    mode = 0o700 if before.st_mode & stat.S_IXUSR else 0o600
    out = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        # Raw copying deliberately does not decode, inspect, or hash setup codes.
        with os.fdopen(os.dup(fd), 'rb') as reader, os.fdopen(os.dup(out), 'wb') as writer:
            shutil.copyfileobj(reader, writer, 1024 * 1024)
            writer.flush()
        os.fsync(out)
        after = same_file(source, before)
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError('A source file changed during backup; quiesce writers and retry')
    finally:
        os.close(fd)
        os.close(out)
    return mode


def record(path, relative, kind, mode):
    value = {'path': str(relative), 'size': path.stat().st_size, 'mode': mode, 'kind': kind}
    if path.name in OPAQUE_NAMES:
        value['opaque'] = True
    else:
        value['sha256'] = hash_file(path)
    return value


def regular_tree(root):
    files, skipped = [], []
    for directory, names, leaves in os.walk(root, followlinks=False):
        for name in list(names):
            path = Path(directory, name)
            if path.is_symlink():
                names.remove(name)
                skipped.append({'path': str(path.relative_to(root)), 'reason': 'symlink'})
        for name in leaves:
            path = Path(directory, name)
            info = path.lstat()
            if stat.S_ISREG(info.st_mode):
                files.append(path)
            else:
                skipped.append({'path': str(path.relative_to(root)), 'reason': 'symlink' if stat.S_ISLNK(info.st_mode) else 'special-file'})
    return sorted(files), skipped
