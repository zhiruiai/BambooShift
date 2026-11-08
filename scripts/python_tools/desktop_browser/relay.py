class BrowserRelay:
    """Bounded byte forwarding to one fixed, policy-enforcing host proxy."""
    def __init__(self, listener, port):
        self.listener = listener
        self.port = port
        self.selector = selectors.DefaultSelector()
        self.selector.register(listener, selectors.EVENT_READ, None)
        self.peers = {}
        self.pending = {}
        self.touched = {}
        self.eof = set()
        self.write_closed = set()

    def drop(self, stream):
        pair = self.peers.pop(stream, None)
        for sock in (stream, pair):
            if sock is None:
                continue
            self.peers.pop(sock, None)
            self.pending.pop(sock, None)
            self.touched.pop(sock, None)
            self.eof.discard(sock)
            self.write_closed.discard(sock)
            try:
                self.selector.unregister(sock)
            except (KeyError, ValueError):
                pass
            sock.close()

    def interest(self, stream):
        peer = self.peers.get(stream)
        if peer is None:
            return
        events = (selectors.EVENT_READ if stream not in self.eof and len(self.pending[peer]) < 65536 else 0)
        if self.pending[stream]:
            events |= selectors.EVENT_WRITE
        try:
            self.selector.unregister(stream)
        except KeyError:
            pass
        if events:
            self.selector.register(stream, events, True)

    def poll(self):
        for key, events in self.selector.select(.05):
            stream = key.fileobj
            if stream is self.listener:
                client, _ = stream.accept()
                if len(self.peers) >= 128:
                    client.close()
                    continue
                try:
                    upstream = socket.create_connection(('127.0.0.1', self.port), timeout=2)
                    for sock, peer in ((client, upstream), (upstream, client)):
                        sock.setblocking(False)
                        self.peers[sock] = peer
                        self.pending[sock] = bytearray()
                        self.touched[sock] = time.monotonic()
                        self.selector.register(sock, selectors.EVENT_READ, True)
                except OSError:
                    client.close()
                continue
            peer = self.peers.get(stream)
            if peer is None:
                continue
            try:
                if events & selectors.EVENT_READ:
                    data = stream.recv(min(16384, 65536 - len(self.pending[peer])))
                    if not data:
                        self.eof.add(stream)
                    else:
                        self.pending[peer].extend(data)
                    self.touched[stream] = self.touched[peer] = time.monotonic()
                if events & selectors.EVENT_WRITE and self.pending[stream]:
                    sent = stream.send(self.pending[stream])
                    del self.pending[stream][:sent]
                for target, source in ((stream, peer), (peer, stream)):
                    if source in self.eof and not self.pending[target] and target not in self.write_closed:
                        target.shutdown(socket.SHUT_WR)
                        self.write_closed.add(target)
                if stream in self.eof and peer in self.eof and not self.pending[stream] and not self.pending[peer]:
                    self.drop(stream)
                    continue
                self.interest(stream)
                self.interest(peer)
            except (OSError, ValueError):
                self.drop(stream)
        for stream, touched in list(self.touched.items()):
            if time.monotonic() - touched >= 120:
                self.drop(stream)

    def close(self):
        for stream in list(self.peers):
            self.drop(stream)
        self.selector.close()
        self.listener.close()


def supervise_browser(args, session, config, parent_handle):
    os.setsid()
    browser_prctl(36, 1)
    stopping = False
    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    child = relay = cgroup = None
    cleaned = False
    try:
        child, listener, cgroup = launch_isolated(session, config, args.lease)
        relay = BrowserRelay(listener, args.proxy_port)
        while not stopping and not select.select([parent_handle], [], [], 0)[0]:
            waited, _ = os.waitpid(child, os.WNOHANG)
            if waited:
                child = None
                break
            require(private_file(BROWSER_CONFIG) == config, 'STALE_SESSION')
            session.current()
            relay.poll()
    finally:
        if relay:
            relay.close()
        if cgroup:
            cleaned = cleanup_browser(cgroup)
        if child:
            try:
                os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(child, 0)
        while True:
            try:
                if not os.waitpid(-1, os.WNOHANG)[0]:
                    cleaned = False
                    break
            except ChildProcessError:
                break
        receipt(args, cleaned)
        session.close()
        os.close(parent_handle)


def browser_main():
    # If the Worker dies abruptly, the wrapper dies too. Its detached supervisor
    # observes the wrapper pidfd and drains the browser cgroup before acknowledging.
    worker_handle = os.pidfd_open(os.getppid(), 0)
    browser_prctl(1, signal.SIGKILL)
    require(not select.select([worker_handle], [], [], 0)[0])
    os.close(worker_handle)
    args = browser_args(sys.argv[1:])
    session = Session(args.manifest, program=BROWSER_PROGRAM)
    config = browser_configuration(args, session)
    session.current()
    if args.probe:
        print(json.dumps({'available': True, 'network': config['network'], 'session': session.session,
                          'workspaceScopeId': args.scope}))
        session.close()
        return
    root_directory(BROWSER_LEASES, private=True)
    require(not os.path.lexists(BROWSER_LEASES + '/' + args.lease + '.json'))
    parent_handle = os.pidfd_open(os.getpid(), 0)
    supervisor = os.fork()
    if supervisor == 0:
        try:
            supervise_browser(args, session, config, parent_handle)
            os._exit(0)
        except BaseException:
            os._exit(78)
    session.close()
    os.close(parent_handle)
    for fd in (3, 4):
        os.close(fd)
    def stop(_signal, _frame):
        try:
            os.kill(supervisor, signal.SIGTERM)
        except ProcessLookupError:
            pass
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    _, status = os.waitpid(supervisor, 0)
    require(os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0)


if __name__ == '__main__':
    try:
        browser_main()
    except BaseException:
        print('Managed desktop browser is unavailable.', file=sys.stderr)
        sys.exit(78)
