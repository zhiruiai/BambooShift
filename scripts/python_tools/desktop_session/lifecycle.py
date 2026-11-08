def start(cfg, session_id, generation=None):
    generation = valid_id(generation) if generation is not None else None
    session = BASE / 'sessions' / session_id
    session.mkdir(mode=0o700, exist_ok=True)
    require(not session.is_symlink() and session.stat().st_uid == 0 and session.stat().st_mode & 0o777 == 0o700)
    controls = []
    for candidate in (BASE / 'sessions').glob('*/control.json'):
        record = private(candidate)
        if identity(record['supervisor']['pid']) == record['supervisor']['startTime']:
            controls.append(record)
    existing = next((entry for entry in controls if entry['sessionId'] == session_id), None)
    if existing:
        require(generation is None or existing['generation'] == generation)
        until = time.monotonic() + 22
        while time.monotonic() < until:
            require(identity(existing['supervisor']['pid']) == existing['supervisor']['startTime'])
            if (session / 'manifest.json').exists():
                state = private(session / 'manifest.json')
                require(state['generation'] == existing['generation'] and state['state'] == 'ready')
                return state
            time.sleep(.1)
        raise RuntimeError('DESKTOP_START_PENDING')
    require(len(controls) < 2 and not (pathlib.Path(cfg['cgroupRoot']) / session_id).exists())
    home = session / 'home'
    home.mkdir(mode=0o700, exist_ok=True)
    require(not home.is_symlink() and home.stat().st_uid in (0, UID))
    os.chown(home, UID, GID)
    (session / 'manifest.json').unlink(missing_ok=True)
    (session / 'diagnostic.json').unlink(missing_ok=True)
    logfd = os.open(session / 'supervisor.log', os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    gate_read, gate_write = os.pipe()
    generation = generation or str(uuid.uuid4())
    try:
        process = subprocess.Popen([sys.executable, os.path.abspath(__file__), '--_supervise', session_id, generation, str(gate_read)],
                  stdin=subprocess.DEVNULL, stdout=logfd, stderr=logfd, start_new_session=True,
                  env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'}, pass_fds=(gate_read,))
        start_time = identity(process.pid)
        require(start_time is not None)
        write_private(session / 'control.json', {'sessionId': session_id, 'generation': generation,
                      'supervisor': {'pid': process.pid, 'startTime': start_time}})
        os.write(gate_write, b'1')
    finally:
        os.close(logfd)
        os.close(gate_read)
        os.close(gate_write)
    until = time.monotonic() + 22
    while time.monotonic() < until:
        require(process.poll() is None)
        if (session / 'manifest.json').exists():
            record = private(session / 'manifest.json')
            require(record.get('state') == 'ready' and record.get('generation') == generation)
            return record
        time.sleep(.1)
    process.terminate()
    process.wait(timeout=5)
    raise RuntimeError('DESKTOP_START_TIMEOUT')


def stop_session(cfg, session_id, expected_generation=None):
    session = BASE / 'sessions' / session_id
    record = private(session / 'control.json')
    require(record.get('sessionId') == session_id)
    require(expected_generation is None or record.get('generation') == expected_generation)
    pid = record['supervisor']['pid']
    if identity(pid) == record['supervisor']['startTime']:
        # Pin the recorded process before signalling: a PID can be reused between
        # the identity check and kill(), but a pidfd never retargets a new process.
        try:
            pidfd = os.pidfd_open(pid, 0)
        except ProcessLookupError:
            pidfd = None
        if pidfd is not None:
            try:
                if identity(pid) == record['supervisor']['startTime']:
                    try:
                        signal.pidfd_send_signal(pidfd, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            finally:
                os.close(pidfd)
        until = time.monotonic() + 8
        while time.monotonic() < until:
            if not (pathlib.Path(cfg['cgroupRoot']) / session_id).exists() and identity(pid) != record['supervisor']['startTime']:
                break
            time.sleep(.1)
    clean_cgroup(pathlib.Path(cfg['cgroupRoot']) / session_id)
    require(not (pathlib.Path(cfg['cgroupRoot']) / session_id).exists())
    # cgroup disappearance alone does not mean its external writer has exited.
    # Never let an old supervisor's finally block overwrite a replacement manifest.
    until = time.monotonic() + 8
    while identity(pid) == record['supervisor']['startTime'] and time.monotonic() < until:
        time.sleep(.05)
    require(identity(pid) != record['supervisor']['startTime'])
    if (session / 'manifest.json').exists():
        manifest = private(session / 'manifest.json')
        manifest['state'] = 'stopped'
        write_private(session / 'manifest.json', manifest)
    return {'ok': True, 'sessionId': session_id, 'state': 'stopped', 'homePreserved': True}


def lifecycle(cfg, request):
    require(isinstance(request, dict) and set(request) == {'version', 'operationId', 'kind', 'expectedSession', 'nextSession'})
    require(request['version'] == 1 and request['kind'] in ['release', 'reset'])
    valid_id(request['operationId'])
    previous, target = request['expectedSession'], request['nextSession']
    for entry in [previous, target]:
        require(isinstance(entry, dict) and set(entry) == {'id', 'generation'})
        valid_id(entry['id'])
        valid_id(entry['generation'])
    require(previous['generation'] != target['generation'])
    require((request['kind'] == 'reset') == (previous['id'] == target['id']))
    original = BASE / 'sessions' / previous['id']
    control = private(original / 'control.json')
    if control['generation'] == previous['generation']:
        stop_session(cfg, previous['id'], previous['generation'])
    else:
        # Only this transaction's already-started generation is recoverable.
        require(previous['id'] == target['id'] and control['generation'] == target['generation'])
    destination = BASE / 'sessions' / target['id']
    if (destination / 'control.json').exists():
        record = private(destination / 'control.json')
        require(record['generation'] in ([target['generation'], previous['generation']]
                if previous['id'] == target['id'] else [target['generation']]))
        if record['generation'] == target['generation'] and identity(record['supervisor']['pid']) != record['supervisor']['startTime']:
            stop_session(cfg, target['id'], target['generation'])
    manifest = start(cfg, target['id'], target['generation'])
    require(manifest['state'] == 'ready' and manifest['sessionId'] == target['id'] and manifest['generation'] == target['generation'])
    return {'version': 1, 'oldStopped': True, 'session': target, 'homePreserved': True}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    if mode == '--_keeper':
        try:
            keep(valid_id(sys.argv[2]), int(sys.argv[3]))
        except BaseException as error:
            traceback.print_exc()
            os._exit(78)
    if mode == '--_supervise':
        require(len(sys.argv) in [3, 5])
        supervise(valid_id(sys.argv[2]), sys.argv[3] if len(sys.argv) == 5 else None,
                  int(sys.argv[4]) if len(sys.argv) == 5 else None)
        return
    if mode == '--lifecycle':
        parent = os.getppid()
        require(parent > 1 and LIBC.prctl(1, signal.SIGTERM, 0, 0, 0) == 0 and os.getppid() == parent)
    cfg = config()
    require((mode in ['--start', '--stop'] and len(sys.argv) == 3) or (mode == '--lifecycle' and len(sys.argv) == 2))
    if mode == '--lifecycle':
        raw = sys.stdin.buffer.read(8193)
        require(len(raw) <= 8192)
        request = json.loads(raw)
    else:
        session_id = valid_id(sys.argv[2])
    lockfd = os.open(BASE / 'sessions.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lockfd, fcntl.LOCK_EX)
        result = lifecycle(cfg, request) if mode == '--lifecycle' else (start(cfg, session_id) if mode == '--start' else stop_session(cfg, session_id))
        print(json.dumps(result, separators=(',', ':')))
    finally:
        os.close(lockfd)


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print(json.dumps({'error': 'DESKTOP_UNAVAILABLE'}))
        sys.exit(78)
