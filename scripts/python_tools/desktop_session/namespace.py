def mount(source, target, kind=None, flags=0, data=None):
    def b(value):
        return os.fsencode(value) if value is not None else None
    if LIBC.mount(b(source), b(target), b(kind), ctypes.c_ulong(flags), b(data)):
        raise OSError(ctypes.get_errno(), 'namespace mount failed')


def bind(source, target, readonly=True, device=False):
    if pathlib.Path(source).is_dir():
        target.mkdir(parents=True, exist_ok=True)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.touch(exist_ok=True)
    mount(source, target, flags=MS_BIND)
    mount(None, target, flags=MS_REMOUNT | MS_BIND | MS_NOSUID |
          (0 if device else MS_NODEV) | (MS_RDONLY if readonly else 0))


def union_tree(target, sources, relative=''):
    """Root-owned read-only symlink union, no overlay driver or writable system root."""
    target.mkdir(parents=True, exist_ok=True)
    names = set()
    for physical, _visible in sources:
        if physical.is_dir():
            names.update(os.listdir(physical))
    for name in names:
        candidates = [(p / name, visible + '/' + name) for p, visible in sources if (p / name).exists() or (p / name).is_symlink()]
        physical, visible = candidates[0]
        destination = target / name
        rel = relative + '/' + name
        directories = [(p, v) for p, v in candidates if p.is_dir() and not p.is_symlink()]
        if directories and (len(candidates) > 1 or rel in ['/local', '/local/lib']):
            union_tree(destination, directories, rel)
        else:
            destination.symlink_to(visible)


def set_limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (512, 512))
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))


def user_command(command, **kwargs):
    return subprocess.Popen(['/usr/bin/setpriv', '--reuid=65532', '--regid=65532', '--clear-groups',
                             '--no-new-privs', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all',
                             *command], env=ENV, preexec_fn=set_limits, **kwargs)


def keep(session_id, statusfd):
    cfg = config()
    require(os.getpid() == 1)
    session = BASE / 'sessions' / valid_id(session_id)
    cg = pathlib.Path(cfg['cgroupRoot']) / session_id
    (cg / 'cgroup.procs').write_text('1')
    mount(None, '/', flags=MS_REC | MS_PRIVATE)
    root = session / 'rootfs'
    root.mkdir(exist_ok=True)
    mount('tmpfs', root, 'tmpfs', MS_NOSUID | MS_NODEV, 'size=33554432,mode=0755')
    for name in ['system', 'desktop', 'usr', 'opt', 'etc', 'run/openbot', 'var', 'proc', 'dev/pts', 'tmp', 'workspace', 'home/openbot']:
        (root / name).mkdir(parents=True, exist_ok=True)
    bind('/usr', root / 'system/usr')
    bind(cfg['runtime'], root / 'desktop')
    union_tree(root / 'usr', [(root / 'desktop/usr', '/desktop/usr'), (root / 'system/usr', '/system/usr')])
    for name, target in [('bin', 'usr/bin'), ('sbin', 'usr/sbin'), ('lib', 'usr/lib'), ('lib64', 'usr/lib64')]:
        (root / name).symlink_to(target)
    helper = root / 'usr/local/lib/openbot/desktop-control.py'
    bind(cfg['helper'], helper)
    bind('/opt/node', root / 'opt/node')
    bind(cfg['workspace'], root / 'workspace', readonly=False)
    bind(session / 'home', root / 'home/openbot', readonly=False)
    if pathlib.Path('/etc/fonts').is_dir():
        bind('/etc/fonts', root / 'etc/fonts')
    # The distribution's generated menu advertises applications we did not
    # install. Keep its window/key bindings, with only working desktop actions.
    wm_config = root / 'etc/xdg/openbox'
    wm_config.mkdir(parents=True)
    rc = (root / 'desktop/etc/xdg/openbox/rc.xml').read_text()
    rc = rc.replace('<file>/var/lib/openbox/debian-menu.xml</file>', '')
    (wm_config / 'rc.xml').write_text(rc)
    (wm_config / 'menu.xml').write_text('''<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
  <menu id="root-menu" label="OpenBot Desktop">
    <item label="Terminal"><action name="Execute"><execute>/usr/bin/xterm -u8 -fa monospace -fs 12 -title OpenBot -e /bin/bash --noprofile --norc</execute></action></item>
    <item label="Windows"><action name="ShowMenu"><menu>client-list-combined-menu</menu></action></item>
  </menu>
</openbox_menu>
''')
    (root / 'etc/passwd').write_text('openbot:x:65532:65532::/home/openbot:/bin/bash\n')
    (root / 'etc/group').write_text('openbot:x:65532:\n')
    (root / 'etc/nsswitch.conf').write_text('passwd: files\ngroup: files\nhosts: files\n')
    mount('tmpfs', root / 'tmp', 'tmpfs', MS_NOSUID | MS_NODEV, 'size=67108864,mode=1777')
    for name, mode, owner in [('runtime-openbot', 0o700, UID), ('.X11-unix', 0o1777, 0), ('shm', 0o1777, 0)]:
        path = root / 'tmp' / name
        path.mkdir(mode=mode)
        path.chmod(mode)
        os.chown(path, owner, owner)
    (root / 'dev/shm').symlink_to('/tmp/shm')
    mount('devpts', root / 'dev/pts', 'devpts', MS_NOSUID | MS_NOEXEC, 'newinstance,ptmxmode=0666,mode=0620,gid=65532')
    (root / 'dev/ptmx').symlink_to('pts/ptmx')
    for name in ['null', 'zero', 'random', 'urandom', 'tty']:
        bind('/dev/' + name, root / 'dev' / name, device=True)
    (root / 'dev/fd').symlink_to('/proc/self/fd')
    (root / 'var/tmp').symlink_to('/tmp')
    mount('proc', root / 'proc', 'proc', MS_NOSUID | MS_NODEV | MS_NOEXEC)
    # Xauthority FamilyWild record. Its private cookie never appears in argv or manifest.
    cookie = os.urandom(16)
    record = struct.pack('>H', 65535)
    for field in [b'', b'1', b'MIT-MAGIC-COOKIE-1', cookie]:
        record += struct.pack('>H', len(field)) + field
    authority = root / 'run/openbot/Xauthority'
    authority.write_bytes(record)
    authority.chmod(0o600)
    os.chown(authority, UID, GID)
    os.chown(authority.parent, UID, GID)
    authority.parent.chmod(0o700)
    mount(None, root, flags=MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV)
    os.chroot(root)
    os.chdir('/workspace')
    # The root keeper contains no control credentials; every desktop application drops privileges.
    server = user_command(['/usr/bin/Xvfb', ':1', '-screen', '0', '1440x900x24', '-nolisten', 'tcp',
                           '-auth', '/run/openbot/Xauthority', '-extension', 'GLX', '-noreset'],
                          stdin=subprocess.DEVNULL)
    until = time.monotonic() + 12
    while time.monotonic() < until:
        require(server.poll() is None)
        if pathlib.Path('/tmp/.X11-unix/X1').exists():
            check = user_command(['/usr/bin/xdotool', 'getdisplaygeometry'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            output, _ = check.communicate(timeout=3)
            if check.returncode == 0 and output.strip() == b'1440 900':
                break
        time.sleep(.1)
    else:
        raise RuntimeError('X_SERVER_NOT_READY')
    wm = user_command(['/usr/bin/openbox', '--config-file', '/etc/xdg/openbox/rc.xml'], stdin=subprocess.DEVNULL)
    terminal = user_command(['/usr/bin/xterm', '-u8', '-fa', 'Noto Sans Mono CJK SC', '-fs', '12',
                             '-title', 'OpenBot Desktop', '-geometry', '70x26+60+70',
                             '-e', '/bin/bash', '--noprofile', '--norc'], stdin=subprocess.DEVNULL)
    time.sleep(.3)
    require(wm.poll() is None and terminal.poll() is None)
    os.write(statusfd, (json.dumps({'ready': True, 'xserverInnerPid': server.pid}) + '\n').encode())
    os.close(statusfd)
    while server.poll() is None:
        try:
            os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            pass
        time.sleep(.2)
    os._exit(1)


