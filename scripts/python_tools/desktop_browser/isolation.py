def browser_setns(fd):
    require(LIBC.setns(fd, 0) == 0)


def browser_prctl(option, value):
    require(LIBC.prctl(option, value, 0, 0, 0) == 0)


def loopback_listener():
    require(LIBC.unshare(0x40000000) == 0)  # CLONE_NEWNET
    control = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        request = struct.pack('16sH14x', b'lo', 0)
        flags = struct.unpack('16sH14x', fcntl.ioctl(control, 0x8913, request))[1]
        fcntl.ioctl(control, 0x8914, struct.pack('16sH14x', b'lo', flags | 1))
    finally:
        control.close()
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(('127.0.0.1', LOOPBACK_PORT))
    listener.listen(32)
    listener.setblocking(False)
    return listener


def browser_child(session, config, cgroup_handle, supervisor_handle):
    try:
        browser_prctl(1, signal.SIGKILL)
        with os.fdopen(os.open('cgroup.procs', os.O_WRONLY, dir_fd=cgroup_handle), 'w') as group:
            group.write(str(os.getpid()))
        os.fchdir(session.root)
        os.chroot('.')
        os.chdir('/home/openbot')
        # Browser processes never receive the host network/root/manifest handles.
        for name in os.listdir('/proc/self/fd'):
            fd = int(name)
            if fd >= 5 and fd != supervisor_handle:
                try:
                    os.close(fd)
                except OSError:
                    pass
        for fd in (3, 4):
            require(stat.S_ISFIFO(os.fstat(fd).st_mode) or stat.S_ISSOCK(os.fstat(fd).st_mode))
            os.set_inheritable(fd, True)
        os.setgroups([])
        for capability in range(64):
            if LIBC.prctl(24, capability, 0, 0, 0) != 0:
                require(ctypes.get_errno() == errno.EINVAL)
        os.setgid(TASK_GID)
        os.setuid(TASK_UID)
        browser_prctl(1, signal.SIGKILL)
        require(not select.select([supervisor_handle], [], [], 0)[0])
        os.close(supervisor_handle)
        browser_prctl(38, 1)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_NOFILE, (1024, 1024))
        resource.setrlimit(resource.RLIMIT_FSIZE, (128 * 1024 * 1024, 128 * 1024 * 1024))
        environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/home/openbot',
                       'DISPLAY': ':1', 'XAUTHORITY': '/run/openbot/Xauthority',
                       'XDG_RUNTIME_DIR': '/tmp/runtime-openbot',
                       'LD_LIBRARY_PATH': '/usr/lib/x86_64-linux-gnu:/usr/local/lib'}
        # No --no-sandbox fallback: an unsupported kernel/runtime fails launch.
        os.execve(config['executable'], chromium_args(config), environment)
    except BaseException:
        os._exit(78)


def launch_isolated(session, config, lease):
    session.current()
    cgroup = session.value['cgroupPath'] + '/browser-' + lease
    os.mkdir(cgroup, 0o700)
    host_namespaces = {name: os.open('/proc/self/ns/' + name, os.O_RDONLY)
                       for name in ('net', 'ipc', 'mnt', 'pid')}
    cgroup_handle = os.open(cgroup, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    supervisor_handle = os.pidfd_open(os.getpid(), 0)
    listener = None
    try:
        for field in ('ipc', 'mount', 'pid'):
            browser_setns(session.ns[field])
        listener = loopback_listener()
        require(os.readlink('/proc/self/ns/net') != session.value['namespaces']['network'])
        child = os.fork()
        if child == 0:
            browser_child(session, config, cgroup_handle, supervisor_handle)
        # Accepted sockets remain in the browser's empty network namespace. Only
        # this root relay returns to the host network to reach the fixed proxy.
        for name in ('pid', 'mnt', 'ipc', 'net'):
            browser_setns(host_namespaces[name])
        for fd in (3, 4):
            os.close(fd)
        return child, listener, cgroup
    except BaseException:
        if listener:
            listener.close()
        cleanup_browser(cgroup)
        raise
    finally:
        for fd in host_namespaces.values():
            os.close(fd)
        os.close(cgroup_handle)
        os.close(supervisor_handle)


def cleanup_browser(cgroup):
    path = pathlib.Path(cgroup)
    try:
        (path / 'cgroup.kill').write_text('1')
        until = time.monotonic() + 10
        while time.monotonic() < until:
            if 'populated 1' not in (path / 'cgroup.events').read_text().splitlines():
                path.rmdir()
                return True
            time.sleep(.025)
        return False
    except FileNotFoundError:
        # Session reset can remove this exact empty child first. The caller still
        # waits and reaps every browser descendant before writing its receipt.
        return not path.exists()
