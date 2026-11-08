def prepare_workspace(rootfd, cfg, deadline):
    """Never follow links. Already task-owned venv links/hardlinks remain usable."""
    audit = os.open(CONTROL / 'ownership.jsonl', os.O_WRONLY | os.O_APPEND | os.O_CREAT |
                    os.O_NOFOLLOW, 0o600)
    try:
        audit_info = os.fstat(audit)
        require(stat.S_ISREG(audit_info.st_mode) and audit_info.st_uid == 0 and audit_info.st_nlink == 1 and
                audit_info.st_mode & 0o777 == 0o600 and audit_info.st_size < 8 * 1024 * 1024)
        count = 0

        def change(fd, relative):
            require(not CANCELLED)
            if time.monotonic() >= deadline:
                raise TaskDeadline()
            info = os.fstat(fd)
            require(info.st_uid in (0, cfg['uid']))
            require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode))
            if info.st_uid == 0:
                require(stat.S_ISDIR(info.st_mode) or info.st_nlink == 1)
                require(not info.st_mode & 0o6000)
                record = {'at': time.time(), 'path': relative, 'uid': info.st_uid,
                          'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
                          'device': info.st_dev, 'inode': info.st_ino}
                os.write(audit, (json.dumps(record) + '\n').encode())
                os.fsync(audit)
                os.fchown(fd, cfg['uid'], cfg['gid'])
                os.fchmod(fd, stat.S_IMODE(info.st_mode))

        def visit(fd, relative, depth):
            nonlocal count
            require(depth < 64)
            change(fd, relative)
            for name in os.listdir(fd):
                count += 1
                require(count <= 20000)
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                require(info.st_uid in (0, cfg['uid']))
                if stat.S_ISLNK(info.st_mode):
                    require(info.st_uid == cfg['uid'])
                    continue
                require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))
                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                if stat.S_ISDIR(info.st_mode):
                    flags |= os.O_DIRECTORY
                child = os.open(name, flags, dir_fd=fd)
                try:
                    opened = os.fstat(child)
                    require((opened.st_dev, opened.st_ino) == (info.st_dev, info.st_ino))
                    path = name if relative == '.' else relative + '/' + name
                    if stat.S_ISDIR(opened.st_mode):
                        visit(child, path, depth + 1)
                    else:
                        change(child, path)
                finally:
                    os.close(child)
        visit(rootfd, '.', 0)
    finally:
        os.close(audit)


def write_control(path, value):
    pathlib.Path(path).write_text(str(value))


def create_cgroup(cfg, jobid, device):
    root = validate_cgroup_root(cfg)
    path = root / jobid
    path.mkdir(mode=0o700)
    try:
        for field, value in [('memory.max', MEMORY), ('memory.swap.max', 0),
                             ('memory.oom.group', 1), ('pids.max', 64), ('cpu.max', '100000 100000')]:
            require((path / field).is_file())
            write_control(path / field, value)
            require(read_text(path / field) == str(value))
        require((path / 'cgroup.kill').is_file())
        if (path / 'io.max').exists() and os.major(device) != 0:
            write_control(path / 'io.max', '%d:%d wbps=8388608' % (os.major(device), os.minor(device)))
            require('wbps=8388608' in read_text(path / 'io.max'))
        return path
    except BaseException:
        path.rmdir()
        raise


def kill_cgroup(path):
    if path and path.exists():
        write_control(path / 'cgroup.kill', '1')


def populated(path):
    return 'populated 1' in read_text(path / 'cgroup.events').splitlines()


def mount(source, target, kind=None, flags=0, data=None):
    def raw(value):
        return os.fsencode(value) if value is not None else None
    if LIBC.mount(raw(source), raw(target), raw(kind), ctypes.c_ulong(flags), raw(data)) != 0:
        failure = IsolationError()
        failure.errno = ctypes.get_errno()
        raise failure


def bind_readonly(source, destination, device=False):
    if os.path.isdir(source):
        destination.mkdir(parents=True, exist_ok=True)
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.touch(exist_ok=True)
    mount(source, destination, flags=MS_BIND)
    mount(None, destination, flags=MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID |
          (0 if device else MS_NODEV))


def pdeath(sig, parent):
    require(parent > 1)
    require(LIBC.prctl(1, sig, 0, 0, 0) == 0)
    if os.getppid() != parent:
        os.kill(os.getpid(), sig)


