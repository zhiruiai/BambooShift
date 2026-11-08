def enter(jobdir, statusfd, workspacefd):
    """Runs as PID 1 in brand-new mount/PID/network namespaces, never directly by Node."""
    cfg = config()
    require(os.getpid() == 1)
    record = private_json(jobdir / 'job.json', 131072)
    require(record['id'] == jobdir.name and re.fullmatch(r'[a-f0-9]{32}', jobdir.name))
    cg = pathlib.Path(cfg['cgroupRoot']) / record['id']
    write_control(cg / 'cgroup.procs', os.getpid())
    mount(None, '/', flags=MS_REC | MS_PRIVATE)
    root = jobdir / 'root'
    root.mkdir()
    mount('tmpfs', root, 'tmpfs', MS_NOSUID | MS_NODEV, 'size=16777216,mode=0755')
    for folder in ['usr', 'usr/local/bin', 'usr/local/lib', 'opt', 'etc', 'proc', 'dev', 'tmp', 'workspace']:
        (root / folder).mkdir(parents=True, exist_ok=True)
    runtime = ['/usr/bin', '/usr/lib', '/usr/lib64', sysconfig.get_path('stdlib'), '/opt/node']
    executable = os.path.realpath(sys.executable)
    runtime.append(executable)
    libdir = pathlib.Path(sysconfig.get_config_var('LIBDIR'))
    runtime.extend(str(path) for path in libdir.glob('libpython%d.%d.so*' % sys.version_info[:2]))
    for source in runtime:
        require(os.path.exists(source))
        info = os.stat(source)
        require(info.st_uid == 0 and not info.st_mode & 0o022)
        bind_readonly(source, root / source.lstrip('/'))
    for name, target in [('bin', 'usr/bin'), ('lib', 'usr/lib'), ('lib64', 'usr/lib64')]:
        (root / name).symlink_to(target)
    for name in ['python', 'python3']:
        path = root / 'usr/local/bin' / name
        if not path.exists():
            path.symlink_to(pathlib.Path(executable).name)
    (root / 'etc/passwd').write_text('openbot:x:%d:%d::/workspace:/bin/bash\n' % (cfg['uid'], cfg['gid']))
    (root / 'etc/group').write_text('openbot:x:%d:\n' % cfg['gid'])
    (root / 'etc/nsswitch.conf').write_text('passwd: files\ngroup: files\nhosts: files\n')
    mount('tmpfs', root / 'tmp', 'tmpfs', MS_NOSUID | MS_NODEV, 'size=%d,mode=1777' % TMP_BYTES)
    for name in ['null', 'zero', 'random', 'urandom']:
        bind_readonly('/dev/' + name, root / 'dev' / name, device=True)
    for name, target in [('fd', '/proc/self/fd'), ('stdin', '/proc/self/fd/0'),
                         ('stdout', '/proc/self/fd/1'), ('stderr', '/proc/self/fd/2')]:
        (root / 'dev' / name).symlink_to(target)
    # Some PVM kernels reject procfd mount sources. The fixed source's parent
    # hierarchy is root-owned/non-writable; compare the pinned fd before/after.
    pinned = os.fstat(workspacefd)
    source = os.lstat(cfg['workspace'])
    require(stat.S_ISDIR(source.st_mode) and (source.st_dev, source.st_ino) == (pinned.st_dev, pinned.st_ino))
    mount(cfg['workspace'], root / 'workspace', flags=MS_BIND)
    bound = os.stat(root / 'workspace')
    require((bound.st_dev, bound.st_ino) == (pinned.st_dev, pinned.st_ino))
    mount(None, root / 'workspace', flags=MS_BIND | MS_REMOUNT | MS_NOSUID | MS_NODEV)
    mount('proc', root / 'proc', 'proc', MS_NOSUID | MS_NODEV | MS_NOEXEC)
    mount(None, root, flags=MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV)
    os.close(workspacefd)
    os.chroot(root)
    os.chdir('/')
    try:
        cwd = os.path.realpath('/workspace/' + record['request']['cwd'])
        valid_cwd = (cwd == '/workspace' or cwd.startswith('/workspace/')) and os.path.isdir(cwd)
    except OSError:
        valid_cwd = False
    os.write(statusfd, b'{"ready":true}\n')
    child = os.fork()
    if child == 0:
        os.close(statusfd)
        if not valid_cwd:
            os.write(2, '工作目录不存在或不在电脑工作区内。\n'.encode())
            os._exit(2)
        os.setsid()
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (31, 31))
        # setpriv applies bounding/inheritable/ambient capability drops and no_new_privs.
        script = 'cd -- "$1" && exec /bin/bash --noprofile --norc -c "$2"'
        os.execve('/usr/bin/setpriv', ['setpriv', '--reuid=%d' % cfg['uid'],
                  '--regid=%d' % cfg['gid'], '--clear-groups', '--no-new-privs',
                  '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all',
                  '/bin/bash', '--noprofile', '--norc', '-c', script, 'openbot',
                  cwd, record['request']['command']], CLEAN_ENV)
    # This root PID 1 has no inherited secrets, only the private rootfs and a result fd.
    _, status = os.waitpid(child, 0)
    result = {'exitCode': os.waitstatus_to_exitcode(status)}
    os.write(statusfd, (json.dumps(result) + '\n').encode())
    os.close(statusfd)
    # Exiting namespace PID 1 kills all remaining descendants, including setsid jobs.
    os._exit(0)


