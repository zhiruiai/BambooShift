#!/usr/bin/env python3
"""Linux-only, root-controlled task supervisor. No caller-selected mounts or identities.

Node uses --probe (read only) and --run (one JSON request on stdin). Deployment
uses --verify; --recover explicitly removes abandoned jobs and verifies again.
Neither an HTTP service nor a general privileged command launcher.
"""
import ctypes
import codecs
import errno
import fcntl
import hashlib
import json
import os
import pathlib
import re
import resource
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import sysconfig
import time
import traceback
import uuid

CONTROL = pathlib.Path('/opt/openbot/shell')
CONFIG = CONTROL / 'config.json'
MAX_OUTPUT = 262144
MAX_TIME = 30000
MEMORY = 512 * 1024 * 1024
TMP_BYTES = 64 * 1024 * 1024
DISK_RESERVE = 96 * 1024 * 1024
INODE_RESERVE = 1024
CAPABILITY = 'isolated-shell-v1'
CLEAN_ENV = {'PATH': '/usr/local/bin:/opt/node/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8',
             'HOME': '/workspace', 'TMPDIR': '/tmp', 'PYTHONDONTWRITEBYTECODE': '1'}
MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC = 1, 2, 4, 8
MS_REMOUNT, MS_BIND, MS_REC, MS_PRIVATE = 32, 4096, 16384, 1 << 18
LIBC = ctypes.CDLL(None, use_errno=True)
CANCELLED = False


class IsolationError(Exception):
    pass


class TaskDeadline(Exception):
    pass


def require(value):
    if not value:
        raise IsolationError()


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def private_json(path, maximum=65536):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                info.st_nlink == 1 and info.st_mode & 0o777 == 0o600 and info.st_size <= maximum)
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return json.loads(stream.read(maximum + 1))
    finally:
        os.close(fd)


def private_write(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, json.dumps(value, separators=(',', ':')).encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, path)


def config():
    require(sys.platform == 'linux' and os.geteuid() == 0)
    for path in [pathlib.Path('/opt'), pathlib.Path('/opt/openbot'), CONTROL]:
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
    value = private_json(CONFIG)
    require(set(value) == {'version', 'workspace', 'uid', 'gid', 'cgroupRoot'})
    require(value['version'] == 1 and value['workspace'] == '/opt/openbot/workspace' and
            value['uid'] == 65532 and value['gid'] == 65532 and
            re.fullmatch(r'/sys/fs/cgroup/openbot-shell-[a-f0-9]{32}', value['cgroupRoot']))
    script = pathlib.Path(__file__).resolve()
    info = script.stat()
    require(info.st_uid == 0 and stat.S_ISREG(info.st_mode) and not info.st_mode & 0o022)
    return value


def binding(cfg):
    return {'script': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
            'config': hashlib.sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest()}


def read_text(path):
    return pathlib.Path(path).read_text().strip()


def validate_cgroup_root(cfg):
    root = pathlib.Path(cfg['cgroupRoot'])
    info = root.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
    require(read_text(root / 'cgroup.type') == 'domain')
    require({'cpu', 'memory', 'pids'} <= set(read_text(root / 'cgroup.subtree_control').split()))
    for field in ['cgroup.kill', 'cgroup.events', 'memory.max', 'pids.max', 'cpu.max']:
        require((root / field).is_file())
    return root


def process_identity(pid):
    try:
        # Field 22 is starttime. Parenthesized comm can itself contain spaces.
        return read_text('/proc/%d/stat' % pid).rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def stale_jobs():
    jobs = CONTROL / 'jobs'
    if not jobs.exists():
        return False, False
    busy = False
    for job in jobs.iterdir():
        require(re.fullmatch(r'[a-f0-9]{32}', job.name) and not job.is_symlink())
        try:
            record = private_json(job / 'job.json', 131072)
            alive = process_identity(record['supervisorPid']) == record['supervisorStart']
        except (OSError, ValueError, KeyError, IsolationError):
            alive = False
        if not alive:
            return True, busy
        busy = True
    return False, busy


def probe(cfg):
    validate_cgroup_root(cfg)
    require(private_json(CONTROL / 'verified.json')['binding'] == binding(cfg))
    for name in ['unshare', 'setpriv']:
        require(shutil.which(name) is not None)
    require(pathlib.Path('/proc/self/ns/pid').exists() and pathlib.Path('/proc/self/ns/net').exists())
    fd = workspace_fd(cfg)
    os.close(fd)
    stale, busy = stale_jobs()
    if stale:
        return {'version': 1, 'available': False, 'capability': CAPABILITY,
                'reason': 'RECOVERY_REQUIRED'}
    return {'version': 1, 'available': True, 'capability': CAPABILITY,
            'workspace': cfg['workspace'], 'busy': busy,
            'limits': {'timeoutMs': MAX_TIME, 'outputBytes': MAX_OUTPUT,
                       'memoryBytes': MEMORY, 'pids': 64, 'network': 'none'}}


def workspace_fd(cfg):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        parts = pathlib.PurePosixPath(cfg['workspace']).parts[1:]
        for index, part in enumerate(parts):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            require(info.st_uid in ({0, cfg['uid']} if index == len(parts) - 1 else {0}))
            require(not info.st_mode & 0o022)
        return fd
    except BaseException:
        os.close(fd)
        raise


