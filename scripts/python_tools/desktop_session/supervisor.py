def cgroup(cfg, session_id):
    root = pathlib.Path(cfg['cgroupRoot'])
    require(root.is_dir() and root.stat().st_uid == 0)
    require({'cpu', 'memory', 'pids'} <= set((root / 'cgroup.subtree_control').read_text().split()))
    require((root / 'memory.max').read_text().strip() == str(768 * 1024 * 1024))
    path = root / session_id
    path.mkdir(mode=0o700)
    try:
        for field, value in [('memory.max', 384 * 1024 * 1024), ('memory.swap.max', 0),
                             ('memory.oom.group', 1), ('pids.max', 64), ('cpu.max', '100000 100000')]:
            (path / field).write_text(str(value))
            require((path / field).read_text().strip() == str(value))
    except BaseException:
        path.rmdir()
        raise
    return path


def clean_cgroup(path):
    try:
        if path.exists():
            (path / 'cgroup.kill').write_text('1')
            while 'populated 1' in (path / 'cgroup.events').read_text().splitlines():
                time.sleep(.05)
            for child in path.iterdir():
                try:
                    info = child.lstat()
                    if stat.S_ISDIR(info.st_mode):
                        require(re.fullmatch(r'browser-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', child.name) and
                                info.st_uid == 0 and not info.st_mode & 0o077)
                        require('populated 1' not in (child / 'cgroup.events').read_text().splitlines())
                        child.rmdir()
                    else:
                        require(stat.S_ISREG(info.st_mode))
                except FileNotFoundError:
                    # The external browser janitor can remove the same empty group.
                    pass
            path.rmdir()
    except FileNotFoundError:
        pass


def pdeath(parent):
    require(LIBC.prctl(1, signal.SIGKILL, 0, 0, 0) == 0)
    if os.getppid() != parent:
        os.kill(os.getpid(), signal.SIGKILL)


def host_pid(path, inner):
    for value in (path / 'cgroup.procs').read_text().split():
        try:
            text = pathlib.Path('/proc/%s/status' % value).read_text()
            line = next(line for line in text.splitlines() if line.startswith('NSpid:'))
            if int(line.split()[-1]) == inner:
                return int(value)
        except (OSError, StopIteration):
            pass
    raise RuntimeError('PROCESS_BINDING_FAILED')


def supervise(session_id, generation=None, gatefd=None):
    global STOP
    cfg = config()
    session = BASE / 'sessions' / valid_id(session_id)
    generation = valid_id(generation) if generation is not None else str(uuid.uuid4())
    control = {'sessionId': session_id, 'generation': generation, 'supervisor': {'pid': os.getpid(), 'startTime': identity(os.getpid())}}
    if gatefd is None:
        write_private(session / 'control.json', control)
    else:
        # The launcher must durably record this exact PID/generation before the
        # detached supervisor is allowed to create a namespace or cgroup.
        try:
            require(os.read(gatefd, 2) == b'1')
        finally:
            os.close(gatefd)
        require(private(session / 'control.json') == control)
    process = cg = None
    rfd = wfd = None
    stop_reason = 'requested'
    def stop(_signum, _frame):
        global STOP
        STOP = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        disk = os.statvfs(BASE)
        require(disk.f_bavail * disk.f_frsize >= 128 * 1024 * 1024 and disk.f_favail >= 1024)
        cg = cgroup(cfg, session_id)
        rfd, wfd = os.pipe()
        parent = os.getpid()
        process = subprocess.Popen(['/usr/bin/unshare', '--mount', '--pid', '--net', '--ipc', '--fork', '--kill-child=SIGKILL',
                   sys.executable, os.path.abspath(__file__), '--_keeper', session_id, str(wfd)],
                   stdin=subprocess.DEVNULL, env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'},
                   pass_fds=(wfd,), preexec_fn=lambda: pdeath(parent))
        os.close(wfd)
        wfd = None
        os.set_blocking(rfd, False)
        buffer = b''
        ready = None
        until = time.monotonic() + 18
        while time.monotonic() < until and not STOP:
            require(process.poll() is None)
            try:
                buffer += os.read(rfd, 8192)
            except BlockingIOError:
                pass
            require(len(buffer) < 32768)
            if b'\n' in buffer:
                ready = json.loads(buffer.split(b'\n', 1)[0])
                require(ready.get('ready'))
                break
            time.sleep(.05)
        require(ready and not STOP)
        keeper = host_pid(cg, 1)
        xserver = host_pid(cg, ready['xserverInnerPid'])
        live_root = pathlib.Path('/proc/%d/root' % keeper)
        socket = (live_root / 'tmp/.X11-unix/X1').stat()
        manifest = {'version': 1, 'sessionId': session_id, 'generation': generation, 'state': 'ready',
                    'uid': UID, 'gid': GID, 'width': 1440, 'height': 900, 'display': ':1',
                    'bootId': pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                    'supervisor': control['supervisor'], 'keeper': {'pid': keeper, 'startTime': identity(keeper)},
                    'xserver': {'pid': xserver, 'startTime': identity(xserver)},
                    'namespaces': {key: os.readlink('/proc/%d/ns/%s' % (keeper, name)) for key, name in [('mount', 'mnt'), ('pid', 'pid'), ('network', 'net'), ('ipc', 'ipc')]},
                    'cgroupPath': str(cg), 'rootfs': str(session / 'rootfs'), 'home': str(session / 'home'),
                    'workspace': cfg['workspace'], 'xauthority': '/run/openbot/Xauthority',
                    'socket': {'path': '/tmp/.X11-unix/X1', 'device': socket.st_dev, 'inode': socket.st_ino},
                    'helperSha256': hashlib.sha256(pathlib.Path(cfg['helper']).read_bytes()).hexdigest()}
        write_private(session / 'manifest.json', manifest)
        while not STOP and process.poll() is None:
            disk = os.statvfs(BASE)
            if disk.f_bavail * disk.f_frsize < 96 * 1024 * 1024 or disk.f_favail < 1024:
                stop_reason = 'disk-reserve'
                write_private(session / 'diagnostic.json', {'stopReason': stop_reason,
                              'freeBytes': disk.f_bavail * disk.f_frsize, 'freeInodes': disk.f_favail})
                break
            time.sleep(.1)
        if not STOP and stop_reason != 'disk-reserve':
            stop_reason = 'session-exited'
    except BaseException as error:
        stop_reason = 'session-error'
        write_private(session / 'diagnostic.json', {'error': type(error).__name__, 'lines': [t.lineno for t in traceback.extract_tb(error.__traceback__)]})
    finally:
        if cg:
            clean_cgroup(cg)
        if process:
            if process.poll() is None:
                process.kill()
            process.wait()
        for fd in [rfd, wfd]:
            if fd is not None:
                os.close(fd)
        write_private(session / 'manifest.json', {'version': 1, 'sessionId': session_id, 'generation': generation,
                      'state': 'stopped', 'stopReason': stop_reason})


