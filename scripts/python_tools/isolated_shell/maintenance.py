def recover(cfg):
    fd = lock_execution()
    try:
        root = validate_cgroup_root(cfg)
        for item in root.iterdir():
            if item.is_dir():
                require(re.fullmatch(r'[a-f0-9]{32}', item.name) and not item.is_symlink())
                kill_cgroup(item)
                while populated(item):
                    time.sleep(0.05)
                item.rmdir()
        for item in (CONTROL / 'jobs').iterdir():
            require(re.fullmatch(r'[a-f0-9]{32}', item.name) and not item.is_symlink())
            shutil.rmtree(item)
    finally:
        os.close(fd)


def main():
    global CANCELLED
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    if mode == '--_enter':
        try:
            enter(pathlib.Path(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]))
        except BaseException as error:
            try:
                os.write(int(sys.argv[3]), (json.dumps({'setupError': type(error).__name__,
                         'line': traceback.extract_tb(error.__traceback__)[-1].lineno,
                         'traceLines': [frame.lineno for frame in traceback.extract_tb(error.__traceback__)],
                         'errno': getattr(error, 'errno', None)}) + '\n').encode())
            except BaseException:
                pass
            os._exit(78)
    try:
        cfg = config()
        if mode == '--probe':
            emit(probe(cfg))
            return 0
        require(mode in ['--run', '--verify', '--recover'])
        def cancel(_sig, _frame):
            global CANCELLED
            CANCELLED = True
        signal.signal(signal.SIGTERM, cancel)
        signal.signal(signal.SIGINT, cancel)
        pdeath(signal.SIGTERM, os.getppid())
        if mode == '--recover':
            recover(cfg)
        if mode in ['--verify', '--recover']:
            result = run(cfg, {'command': VERIFY_COMMAND, 'cwd': '.', 'timeoutMs': 10000})
            require(result['exitCode'] == 0 and result['stdout'].strip() == 'OPENBOT_ISOLATION_VERIFIED')
            private_write(CONTROL / 'verified.json', {'version': 1, 'binding': binding(cfg), 'at': time.time()})
            (CONTROL / 'last-failure.json').unlink(missing_ok=True)
            emit(probe(cfg))
        else:
            require(probe(cfg)['available'])
            try:
                req = request()
            except BaseException:
                emit({'version': 1, 'error': 'INVALID_REQUEST'})
                return 64
            emit(run(cfg, req))
        return 0
    except BaseException:
        if mode == '--probe':
            emit({'version': 1, 'available': False, 'capability': CAPABILITY, 'reason': 'ISOLATION_UNAVAILABLE'})
            return 0
        emit({'version': 1, 'error': 'ISOLATION_UNAVAILABLE'})
        return 78


if __name__ == '__main__':
    sys.exit(main())
