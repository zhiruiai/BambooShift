#!/usr/bin/env python3
"""Explicit, persistent, isolated Linux desktop sessions. No automatic resume."""
import ctypes
import fcntl
import hashlib
import json
import os
import pathlib
import re
import resource
import shutil
import signal
import stat
import struct
import subprocess
import sys
import time
import traceback
import uuid

BASE = pathlib.Path('/opt/openbot/desktop')
UID = GID = 65532
LIBC = ctypes.CDLL(None, use_errno=True)
STOP = False
ENV = {'PATH': '/usr/local/bin:/opt/node/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8',
       'HOME': '/home/openbot', 'DISPLAY': ':1', 'XAUTHORITY': '/run/openbot/Xauthority',
       'LD_LIBRARY_PATH': '/usr/lib/x86_64-linux-gnu:/usr/local/lib',
       'XDG_CONFIG_HOME': '/home/openbot/.config', 'XDG_CACHE_HOME': '/home/openbot/.cache',
       'XDG_RUNTIME_DIR': '/tmp/runtime-openbot', 'PYTHONDONTWRITEBYTECODE': '1'}
MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC = 1, 2, 4, 8
MS_REMOUNT, MS_BIND, MS_REC, MS_PRIVATE = 32, 4096, 16384, 1 << 18


def require(value):
    if not value:
        raise RuntimeError('DESKTOP_UNAVAILABLE')


def valid_id(value):
    require(str(uuid.UUID(value)) == value)
    return value


def private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and
                info.st_mode & 0o777 == 0o600 and info.st_size <= 65536)
        return json.loads(os.read(fd, 65537))
    finally:
        os.close(fd)


def write_private(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, separators=(',', ':'))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def identity(pid):
    try:
        fields = pathlib.Path('/proc/%d/stat' % pid).read_text().rsplit(')', 1)[1].split()
        return None if fields[0] == 'Z' else fields[19]
    except (OSError, IndexError):
        return None


def config():
    require(sys.platform == 'linux' and os.geteuid() == 0)
    for path in [BASE, BASE / 'sessions']:
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o777 == 0o700)
    cfg = private(BASE / 'config.json')
    require(cfg['version'] == 1 and cfg['workspace'] == '/opt/openbot/workspace' and
            cfg['runtime'] == str(BASE / 'runtime') and cfg['helper'] == '/opt/openbot/desktop-control.py' and
            re.fullmatch(r'/sys/fs/cgroup/openbot-desktop-[a-f0-9]{32}', cfg['cgroupRoot']))
    require(not pathlib.Path(cfg['workspace']).is_symlink())
    for path in [cfg['runtime'], cfg['helper'], os.path.abspath(__file__)]:
        info = os.lstat(path)
        require(info.st_uid == 0 and not info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode))
    return cfg


