import argparse
import pathlib
import selectors
import socket

BROWSER_PROGRAM = '/opt/openbot/desktop-browser.py'
BROWSER_CONFIG = CONTROL + '/browser.json'
BROWSER_LEASES = CONTROL + '/browser-leases'
LOOPBACK_PORT = 18080


def browser_args(argv):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--probe', action='store_true')
    for name in ('manifest', 'session', 'generation', 'scope'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--lease')
    parser.add_argument('--proxy-port', type=int)
    value = parser.parse_args(argv)
    require(all(uuid(getattr(value, name)) for name in ('session', 'generation', 'scope')), 'INVALID_REQUEST')
    require(value.manifest == CONTROL + '/sessions/' + value.session + '/manifest.json', 'INVALID_REQUEST')
    if value.probe:
        require(value.lease is None and value.proxy_port is None, 'INVALID_REQUEST')
    else:
        require(uuid(value.lease) and integer(value.proxy_port, 1024, 65535), 'INVALID_REQUEST')
    return value


def browser_configuration(args, session):
    config = private_file(BROWSER_CONFIG)
    require(isinstance(config, dict) and set(config) == {'version', 'workspaceScopeId', 'executable', 'network'})
    require(config['version'] == 1 and config['workspaceScopeId'] == args.scope and
            config['network'] == 'browser-proxy-only' and
            config['executable'] == '/desktop/opt/chrome/chrome', 'DESKTOP_UNAVAILABLE')
    require(session.session == {'id': args.session, 'generation': args.generation}, 'STALE_SESSION')
    # Only a root-installed executable inside the already pinned runtime is used.
    parent = os.dup(session.root)
    try:
        for name in ('desktop', 'opt', 'chrome'):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
            info = os.fstat(parent)
            require(info.st_uid == 0 and not info.st_mode & 0o022)
        binary = os.open('chrome', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            info = os.fstat(binary)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and
                    not info.st_mode & 0o022 and info.st_mode & 0o111 and
                    os.read(binary, 4) == b'\x7fELF')
        finally:
            os.close(binary)
    finally:
        os.close(parent)
    return config


def receipt(args, cleaned):
    root_directory(BROWSER_LEASES, private=True)
    path = BROWSER_LEASES + '/' + args.lease + '.json'
    temporary = path + '.tmp'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        raw = encode({'version': 1, 'leaseId': args.lease, 'workspaceScopeId': args.scope,
                      'session': {'id': args.session, 'generation': args.generation},
                      'cleanupConfirmed': cleaned})
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(BROWSER_LEASES, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def chromium_args(config):
    # A remote page cannot choose flags, profiles, an extension or a debug port.
    return [config['executable'], '--remote-debugging-pipe',
            '--user-data-dir=/home/openbot/.browser-profile',
            '--proxy-server=http://127.0.0.1:' + str(LOOPBACK_PORT),
            '--proxy-bypass-list=<-loopback>', '--disable-quic',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--disable-background-networking', '--disable-component-update',
            '--disable-default-apps', '--disable-extensions', '--no-first-run',
            '--no-default-browser-check', '--disable-dev-shm-usage',
            '--disable-features=Translate,MediaRouter', '--password-store=basic',
            '--use-mock-keychain', '--window-size=1440,900', '--window-position=0,0',
            '--enable-automation', 'about:blank']
