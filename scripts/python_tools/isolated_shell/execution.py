def request():
    raw = sys.stdin.buffer.read(131073)
    require(len(raw) <= 131072)
    value = json.loads(raw)
    require(isinstance(value, dict) and set(value) <= {'version', 'command', 'cwd', 'timeoutMs'})
    require(value.get('version') == 1 and isinstance(value.get('command'), str) and
            0 < len(value['command']) <= 16000 and '\0' not in value['command'])
    cwd = value.get('cwd', '.')
    require(isinstance(cwd, str) and 0 < len(cwd) <= 4096 and not cwd.startswith('/') and
            '\0' not in cwd and '\\' not in cwd and '..' not in cwd.split('/'))
    timeout = value.get('timeoutMs', MAX_TIME)
    require(type(timeout) is int and 100 <= timeout <= MAX_TIME)
    return {'command': value['command'], 'cwd': cwd, 'timeoutMs': timeout}


def lock_execution():
    fd = os.open(CONTROL / 'run.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    require(info.st_uid == 0 and stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
            info.st_mode & 0o777 == 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        os.close(fd)
        raise IsolationError()
    return fd


def trim_output(text, remaining):
    encoded = text.encode('utf-8')
    return encoded[:remaining].decode('utf-8', errors='ignore')


def run(cfg, req):
    global CANCELLED
    lockfd = lock_execution()
    jobdir = cg = process = None
    rootfd = readfd = writefd = None
    started = time.monotonic()
    try:
        require(not any((CONTROL / 'jobs').iterdir()))
        rootfd = workspace_fd(cfg)
        disk = os.fstatvfs(rootfd)
        require(disk.f_bavail * disk.f_frsize >= DISK_RESERVE and disk.f_favail >= INODE_RESERVE)
        prepare_workspace(rootfd, cfg, started + req['timeoutMs'] / 1000)
        require(not CANCELLED)
        jobid = uuid.uuid4().hex
        jobdir = CONTROL / 'jobs' / jobid
        jobdir.mkdir(mode=0o700)
        private_write(jobdir / 'job.json', {'id': jobid, 'request': req,
                      'supervisorPid': os.getpid(), 'supervisorStart': process_identity(os.getpid())})
        cg = create_cgroup(cfg, jobid, os.fstat(rootfd).st_dev)
        readfd, writefd = os.pipe()
        parent = os.getpid()
        process = subprocess.Popen(['/usr/bin/unshare', '--mount', '--pid', '--net', '--fork',
                   '--kill-child=SIGKILL', sys.executable, os.path.abspath(__file__), '--_enter',
                   str(jobdir), str(writefd), str(rootfd)], stdin=subprocess.DEVNULL,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=CLEAN_ENV,
                   pass_fds=(writefd, rootfd), preexec_fn=lambda: pdeath(signal.SIGKILL, parent))
        os.close(writefd)
        writefd = None
        os.close(rootfd)
        rootfd = None
        selector = selectors.DefaultSelector()
        for stream, name in [(process.stdout, 'stdout'), (process.stderr, 'stderr'), (readfd, 'status')]:
            selector.register(stream, selectors.EVENT_READ, name)
        chunks = {'stdout': [], 'stderr': []}
        decoders = {name: codecs.getincrementaldecoder('utf-8')(errors='replace') for name in chunks}
        total = 0
        truncated = timedout = ready = disk_limit = False
        setup_error = None
        exitcode = None
        statusbytes = b''
        stopped = False
        while selector.get_map() or process.poll() is None:
            elapsed = (time.monotonic() - started) * 1000
            disk = os.statvfs(cfg['workspace'])
            disk_limit = disk_limit or disk.f_bavail * disk.f_frsize < DISK_RESERVE or disk.f_favail < INODE_RESERVE
            if not stopped and (CANCELLED or elapsed >= req['timeoutMs'] or disk_limit):
                timedout = not CANCELLED and not disk_limit
                kill_cgroup(cg)
                process.terminate()
                stopped = True
            for key, _ in selector.select(0.05):
                fd = key.fileobj if isinstance(key.fileobj, int) else key.fileobj.fileno()
                data = os.read(fd, 8192)
                if not data:
                    selector.unregister(key.fileobj)
                    if key.data in decoders:
                        decoded = decoders[key.data].decode(b'', final=True)
                        text = trim_output(decoded, MAX_OUTPUT - total)
                        chunks[key.data].append(text)
                        total += len(text.encode('utf-8'))
                        truncated = truncated or text != decoded
                    continue
                if key.data == 'status':
                    statusbytes += data
                    require(len(statusbytes) <= 4096)
                    while b'\n' in statusbytes:
                        line, statusbytes = statusbytes.split(b'\n', 1)
                        message = json.loads(line)
                        ready = ready or message.get('ready') is True
                        if 'setupError' in message:
                            setup_error = message
                        if 'exitCode' in message:
                            exitcode = message['exitCode']
                else:
                    decoded = decoders[key.data].decode(data)
                    text = trim_output(decoded, MAX_OUTPUT - total)
                    chunks[key.data].append(text)
                    total += len(text.encode('utf-8'))
                    if text != decoded:
                        truncated = True
            if stopped and process.poll() is None and elapsed > req['timeoutMs'] + 1000:
                process.kill()
        selector.close()
        process.wait()
        memory_events = dict(line.split() for line in read_text(cg / 'memory.events').splitlines())
        oom = int(memory_events.get('oom_kill', '0')) > 0
        pids_events = dict(line.split() for line in read_text(cg / 'pids.events').splitlines())
        pids_limited = int(pids_events.get('max', '0')) > 0
        if setup_error:
            private_write(CONTROL / 'last-failure.json', setup_error)
        require(ready or CANCELLED or timedout or disk_limit)
        require(exitcode is not None or CANCELLED or timedout or disk_limit or oom)
        result = {'version': 1, 'stdout': ''.join(chunks['stdout']), 'stderr': ''.join(chunks['stderr']),
                  'exitCode': max(exitcode, 0) if exitcode is not None and exitcode >= 0 else None,
                  'truncated': truncated, 'timedOut': timedout, 'cancelled': CANCELLED,
                  'durationMs': round((time.monotonic() - started) * 1000)}
        if disk_limit:
            result['resourceLimit'] = 'disk-reserve'
        elif oom:
            result['resourceLimit'] = 'memory'
            result['signal'] = 'SIGKILL'
        elif pids_limited:
            result['resourceLimit'] = 'pids'
        if exitcode is not None and exitcode < 0:
            try:
                result['signal'] = signal.Signals(-exitcode).name
            except ValueError:
                result['signal'] = 'SIG%d' % -exitcode
        return result
    except BaseException as error:
        if CANCELLED or isinstance(error, TaskDeadline):
            return {'version': 1, 'stdout': '', 'stderr': '', 'exitCode': None,
                    'truncated': False, 'timedOut': not CANCELLED, 'cancelled': CANCELLED,
                    'durationMs': round((time.monotonic() - started) * 1000)}
        raise
    finally:
        # Never release the execution lock while the cgroup contains a process.
        if cg is not None:
            kill_cgroup(cg)
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.wait()
            for stream in [process.stdout, process.stderr]:
                if stream:
                    stream.close()
        if cg is not None:
            while populated(cg):
                kill_cgroup(cg)
                time.sleep(0.05)
            cg.rmdir()
        for fd in [rootfd, readfd, writefd]:
            if fd is not None:
                os.close(fd)
        if jobdir is not None:
            shutil.rmtree(jobdir)
        os.close(lockfd)


VERIFY_COMMAND = r'''python3 - <<'CHECK'
import json,os,pathlib,socket
assert os.getuid() == 65532 and os.getgid() == 65532
s=pathlib.Path('/proc/self/status').read_text()
assert 'NoNewPrivs:\t1' in s and 'CapEff:\t0000000000000000' in s
assert os.statvfs('/').f_flag & os.ST_RDONLY
assert not os.path.exists('/opt/openbot') and not os.path.exists('/sys/fs/cgroup')
assert set(os.listdir('/proc/net')) and list(socket.if_nameindex()) == [(1,'lo')]
assert os.access('/workspace',os.W_OK) and os.access('/tmp',os.W_OK)
assert not any(k for k in os.environ if any(x in k for x in ['TOKEN','SECRET','KEY','PASSWORD']))
try:
 pathlib.Path('/proc/1/environ').read_bytes()
 raise AssertionError('root process readable')
except PermissionError: pass
print('OPENBOT_ISOLATION_VERIFIED')
CHECK'''


