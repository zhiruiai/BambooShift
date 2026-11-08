def prctl(option, value):
    require(LIBC.prctl(option, value, 0, 0, 0) == 0)


def setns(fd):
    require(LIBC.setns(fd, 0) == 0)


def enter(session, value, output):
    """This intermediate process stays outside the PID namespace; its child enters it."""
    parent = os.getppid()
    prctl(1, signal.SIGTERM)
    require(os.getppid() == parent and parent > 1)
    os.setsid()
    session.current()
    with open(session.value['cgroupPath'] + '/cgroup.procs', 'w') as group:
        group.write(str(os.getpid()))
    setns(session.ns['network'])
    setns(session.ns['ipc'])
    setns(session.ns['mount'])
    setns(session.ns['pid'])
    os.fchdir(session.root)
    os.chroot('.')
    os.chdir('/')
    require(digest(INNER_HELPER) == session.value['helperSha256'], 'STALE_SESSION')
    for tool in ('/usr/bin/xdotool', '/usr/bin/scrot'):
        info = os.stat(tool)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
    parent_handle = os.pidfd_open(os.getpid(), 0)
    pid = os.fork()
    if pid == 0:
        try:
            prctl(1, signal.SIGTERM)
            # The intermediate parent is outside this PID namespace (getppid == 0).
            # PR_SET_PDEATHSIG still binds its lifetime to that parent.
            for field, name in NAMESPACES:
                require(os.readlink('/proc/self/ns/' + name) == session.value['namespaces'][field], 'STALE_SESSION')
            require(os.getpid() != 1)
            session.close()
            # No manifest, host root or namespace descriptors reach an unprivileged tool.
            for name in os.listdir('/proc/self/fd'):
                fd = int(name)
                if fd >= 3 and fd not in (output, parent_handle):
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            os.setgroups([])
            for capability in range(64):
                if LIBC.prctl(24, capability, 0, 0, 0) != 0:  # PR_CAPBSET_DROP
                    require(ctypes.get_errno() == errno.EINVAL)
            os.setgid(TASK_GID)
            os.setuid(TASK_UID)
            # Linux clears PDEATHSIG on setuid. Re-arm it and inspect the pinned
            # parent handle because its PID is not visible in this PID namespace.
            prctl(1, signal.SIGTERM)
            require(not select.select([parent_handle], [], [], 0)[0])
            os.close(parent_handle)
            prctl(38, 1)  # PR_SET_NO_NEW_PRIVS
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            resource.setrlimit(resource.RLIMIT_FSIZE, (PNG_LIMIT, PNG_LIMIT))
            os.environ.clear()
            os.environ.update({'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'DISPLAY': ':1',
                               'XAUTHORITY': '/run/openbot/Xauthority', 'HOME': '/home/openbot'})
            reply = operate(value, session.session)
            raw = encode(reply)
            while raw:
                raw = raw[os.write(output, raw):]
            os.close(output)
            os._exit(0)
        except BaseException:
            os._exit(78)
    os.close(parent_handle)
    session.close()
    os.close(output)
    try:
        while True:
            waited, status = os.waitpid(pid, os.WNOHANG)
            if waited:
                os._exit(0 if os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0 else 78)
            if CANCELLED:
                os.kill(pid, signal.SIGTERM)
            time.sleep(0.025)
    except BaseException:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except OSError:
            pass
        os._exit(78)


def signal_operation(pid, signum):
    try:
        os.killpg(pid, signum)
    except ProcessLookupError:
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            pass


def reap_owned_children(force=False):
    """Only this helper's children are eligible; the desktop keeper is never ours."""
    found_live = False
    while True:
        try:
            child, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return found_live
        if child:
            continue
        found_live = True
        # A fixed tool should have no surviving descendants. If it does, terminate
        # the adopted children and mark the operation's cleanup unproven.
        if not force:
            force = True
        path = '/proc/self/task/%d/children' % os.getpid()
        for name in read_text(path).split():
            pid = int(name)
            try:
                descriptor = os.pidfd_open(pid, 0)
                try:
                    # PID FDs avoid affecting a reused PID even under rapid exits.
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                finally:
                    os.close(descriptor)
            except ProcessLookupError:
                pass
        time.sleep(0.01)


def supervised(value, session):
    prctl(36, 1)  # Adopt any orphaned tool descendants, not unrelated desktop apps.
    readfd, writefd = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(readfd)
        try:
            enter(session, value, writefd)
        except BaseException:
            os._exit(78)
    os.close(writefd)
    os.set_blocking(readfd, False)
    chunks = bytearray()
    status = None
    eof = False
    stopping = None
    hard_stopped = False
    try:
        while status is None or not eof:
            if (CANCELLED or time.monotonic() - STARTED >= 12) and stopping is None:
                stopping = time.monotonic()
                signal_operation(pid, signal.SIGTERM)
            if stopping and time.monotonic() - stopping >= 2.5 and not hard_stopped:
                hard_stopped = True
                signal_operation(pid, signal.SIGKILL)
            readable, _, _ = select.select([] if eof else [readfd], [], [], 0.025)
            if readable:
                chunk = os.read(readfd, 65536)
                if not chunk:
                    eof = True
                else:
                    chunks.extend(chunk)
                    if len(chunks) > REPLY_LIMIT:
                        raise Failure('CLEANUP_UNKNOWN', False)
            if status is None:
                waited, code = os.waitpid(pid, os.WNOHANG)
                if waited:
                    status = code
        # Reap orphaned tools before returning any cleanup acknowledgement.
        hard_stopped = reap_owned_children() or hard_stopped
        require(not hard_stopped and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0,
                'CLEANUP_UNKNOWN')
        session.current()
        reply = json.loads(chunks)
        require(isinstance(reply, dict) and type(reply.get('ok')) is bool, 'CLEANUP_UNKNOWN')
        return reply
    except Failure as error:
        error.cleanup = False
        raise
    except BaseException:
        raise Failure('CLEANUP_UNKNOWN', False)
    finally:
        os.close(readfd)
        if status is None:
            signal_operation(pid, signal.SIGKILL)
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass
        reap_owned_children(force=True)


def main():
    session = None
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    try:
        if sys.platform == 'linux':
            parent = os.getppid()
            prctl(1, signal.SIGTERM)
            require(parent > 1 and os.getppid() == parent, 'CANCELLED')
        require(len(sys.argv) == 3 and sys.argv[1] == '--manifest', 'INVALID_REQUEST')
        value = request()
        interrupted()
        session = Session(sys.argv[2])
        if value['op'] != 'status':
            require(value['session'] == session.session, 'STALE_SESSION')
            if value['op'] == 'input':
                require(value['frame']['geometryToken'] == geometry_token(session.session), 'STALE_FRAME')
            session.lock()
        reply = supervised(value, session)
    except Failure as error:
        reply = envelope(error)
    except BaseException:
        reply = envelope(Failure())
    finally:
        if session:
            session.close()
    sys.stdout.buffer.write(encode(reply) + b'\n')
    sys.stdout.buffer.flush()
    return 0 if reply.get('ok') is True else 1


if __name__ == '__main__':
    sys.exit(main())
