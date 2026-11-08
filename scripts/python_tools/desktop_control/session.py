def private_file(path, limit=65536):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and
                info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= limit)
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(limit + 1)
        require(len(data) <= limit)
        return json.loads(data)
    finally:
        os.close(fd)


def root_directory(path, private=False):
    info = os.lstat(path)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and
            not info.st_mode & (0o077 if private else 0o022))


def digest(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and
                info.st_size <= 1024 * 1024)
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return hashlib.sha256(stream.read(1024 * 1024 + 1)).hexdigest()
    finally:
        os.close(fd)


def proc_identity(pid):
    with open('/proc/%d/stat' % pid) as source:
        return source.read().rsplit(')', 1)[1].split()[19]


def read_text(path):
    with open(path) as source:
        return source.read(65537).strip()


def process_matches(record, uid, cgroup=None):
    require(isinstance(record, dict) and set(record) == {'pid', 'startTime'} and
            integer(record['pid'], 2, 2 ** 31 - 1) and
            isinstance(record['startTime'], (str, int)) and
            re.fullmatch(r'[0-9]+', str(record['startTime'])), 'STALE_SESSION')
    pid = record['pid']
    require(proc_identity(pid) == str(record['startTime']), 'STALE_SESSION')
    status = read_text('/proc/%d/status' % pid)
    match = re.search(r'^Uid:\s+([0-9]+)\s+([0-9]+)', status, re.MULTILINE)
    require(match and int(match[1]) == uid and int(match[2]) == uid, 'STALE_SESSION')
    if cgroup:
        # A PVM can mount a cgroup subtree at /sys/fs/cgroup. Its /proc cgroup
        # names then have an additional kernel prefix. Membership in the trusted
        # cgroup.procs is authoritative without guessing or stripping that prefix.
        require(str(pid) in read_text(cgroup + '/cgroup.procs').splitlines(), 'STALE_SESSION')
        require(proc_identity(pid) == str(record['startTime']), 'STALE_SESSION')


class Session:
    def __init__(self, path, program=HELPER):
        self.fds = []
        self.manifest_path = path
        match = re.fullmatch(CONTROL + r'/sessions/(' + UUID + r')/manifest\.json', path)
        require(match, 'INVALID_REQUEST')
        require(sys.platform == 'linux' and os.geteuid() == 0)
        for parent in ('/opt', '/opt/openbot'):
            root_directory(parent)
        for parent in (CONTROL, CONTROL + '/sessions', os.path.dirname(path)):
            root_directory(parent, private=True)
        config = private_file(CONFIG)
        cg = config.get('cgroupRoot') if isinstance(config, dict) else None
        require(isinstance(cg, str) and re.fullmatch(r'/sys/fs/cgroup/openbot-desktop-[a-f0-9]{32}', cg))
        root_directory(cg)
        manifest = private_file(path)
        require(isinstance(manifest, dict))
        self.value = manifest
        self.id = match[1]
        self.session = {'id': self.id, 'generation': manifest.get('generation')}
        directory = os.path.dirname(path)
        require(manifest.get('version') == 1 and manifest.get('sessionId') == self.id and
                uuid(manifest.get('generation')) and manifest.get('state') == 'ready' and
                manifest.get('uid') == TASK_UID and manifest.get('gid') == TASK_GID and
                manifest.get('width') == WIDTH and manifest.get('height') == HEIGHT and
                manifest.get('display') == ':1' and manifest.get('rootfs') == directory + '/rootfs' and
                manifest.get('home') == directory + '/home' and
                manifest.get('workspace') == '/opt/openbot/workspace' and
                manifest.get('xauthority') == '/run/openbot/Xauthority' and
                manifest.get('cgroupPath') == cg + '/' + self.id, 'STALE_SESSION')
        require(manifest.get('bootId') == read_text('/proc/sys/kernel/random/boot_id'), 'STALE_SESSION')
        require(program in (HELPER, '/opt/openbot/desktop-browser.py'))
        require(re.fullmatch(r'[a-f0-9]{64}', str(manifest.get('helperSha256', ''))) and
                digest(HELPER) == manifest['helperSha256'] and
                os.path.realpath(__file__) == program, 'STALE_SESSION')
        root_directory(manifest['cgroupPath'])
        namespaces = manifest.get('namespaces')
        require(isinstance(namespaces, dict) and set(namespaces) == {key for key, _ in NAMESPACES})
        self.check_processes()
        keeper = manifest['keeper']['pid']
        self.ns = {}
        try:
            for field, procname in NAMESPACES:
                expected = namespaces[field]
                require(isinstance(expected, str) and re.fullmatch(procname + r':\[[0-9]+\]', expected))
                ns_path = '/proc/%d/ns/%s' % (keeper, procname)
                require(os.readlink(ns_path) == expected and
                        os.readlink('/proc/self/ns/' + procname) != expected, 'STALE_SESSION')
                fd = os.open(ns_path, os.O_RDONLY)
                self.fds.append(fd)
                require(os.fstat(fd).st_ino == int(expected.split('[')[1][:-1]), 'STALE_SESSION')
                self.ns[field] = fd
            self.root = os.open('/proc/%d/root' % keeper, os.O_RDONLY | os.O_DIRECTORY)
            self.fds.append(self.root)
            self.root_info = os.fstat(self.root)
            self.check_processes()
            socket_info = manifest.get('socket')
            require(isinstance(socket_info, dict) and set(socket_info) == {'path', 'device', 'inode'} and
                    socket_info.get('path') == '/tmp/.X11-unix/X1' and
                    type(socket_info.get('device')) is int and type(socket_info.get('inode')) is int)
            self.check_socket()
        except BaseException:
            self.close()
            raise

    def check_processes(self):
        manifest = self.value
        process_matches(manifest.get('supervisor'), 0)
        process_matches(manifest.get('keeper'), 0, manifest['cgroupPath'])
        process_matches(manifest.get('xserver'), TASK_UID, manifest['cgroupPath'])
        for field, procname in NAMESPACES:
            expected = manifest['namespaces'][field]
            for process in ('keeper', 'xserver'):
                require(os.readlink('/proc/%d/ns/%s' % (manifest[process]['pid'], procname)) == expected,
                        'STALE_SESSION')

    def check_socket(self):
        # Never follow a user-created intermediate symlink outside the pinned root.
        tmp = os.open('tmp', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.root)
        directory = None
        try:
            directory = os.open('.X11-unix', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=tmp)
            info = os.stat('X1', dir_fd=directory, follow_symlinks=False)
        finally:
            if directory is not None:
                os.close(directory)
            os.close(tmp)
        require(stat.S_ISSOCK(info.st_mode) and info.st_uid == TASK_UID and
                (info.st_dev, info.st_ino) ==
                (self.value['socket']['device'], self.value['socket']['inode']), 'STALE_SESSION')

    def current(self):
        latest = private_file(self.manifest_path)
        require(latest == self.value, 'STALE_SESSION')
        self.check_processes()
        self.check_socket()
        current = os.stat('/proc/%d/root' % self.value['keeper']['pid'])
        require((current.st_dev, current.st_ino) ==
                (self.root_info.st_dev, self.root_info.st_ino), 'STALE_SESSION')

    def close(self):
        for fd in self.fds:
            os.close(fd)
        self.fds = []

    def lock(self):
        # Serialize inputs across Worker processes as well as within one adapter.
        # Status never creates files or takes a write lock.
        path = os.path.dirname(self.manifest_path) + '/operation.lock'
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        self.fds.append(fd)
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and
                info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600)
        while True:
            interrupted()
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return
            except BlockingIOError:
                time.sleep(0.025)


def geometry_token(session):
    return hashlib.sha256(encode({'session': session, 'displayId': DISPLAY_ID,
                                  'width': WIDTH, 'height': HEIGHT})).hexdigest()


