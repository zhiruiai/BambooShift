def command(args, input_bytes=None, output_limit=4096, cleanup=False, pass_fds=()):
    if not cleanup:
        interrupted()
    process = subprocess.Popen(args, stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True,
                               pass_fds=pass_fds,
                               env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'DISPLAY': ':1',
                                    'XAUTHORITY': '/run/openbot/Xauthority', 'HOME': '/home/openbot'})
    output = bytearray()
    try:
        if input_bytes is not None:
            os.set_blocking(process.stdin.fileno(), False)
        os.set_blocking(process.stdout.fileno(), False)
        offset = 0
        while process.poll() is None or process.stdout:
            if not cleanup:
                interrupted()
            readable, writable, _ = select.select(
                [process.stdout] if process.stdout else [],
                [process.stdin] if process.stdin else [], [], 0.025)
            if writable:
                try:
                    offset += os.write(process.stdin.fileno(), input_bytes[offset:offset + 8192])
                    if offset == len(input_bytes):
                        process.stdin.close()
                        process.stdin = None
                except BrokenPipeError:
                    process.stdin.close()
                    process.stdin = None
            if readable:
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    process.stdout.close()
                    process.stdout = None
                else:
                    output.extend(chunk)
                    require(len(output) <= output_limit,
                            'CAPTURE_FAILED' if args[0].endswith('scrot') else 'INPUT_FAILED')
        require(process.wait() == 0, 'CAPTURE_FAILED' if args[0].endswith('scrot') else 'INPUT_FAILED')
        return bytes(output)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=0.3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if process.stdin:
            process.stdin.close()
        if process.stdout:
            process.stdout.close()


def xdotool(*args, text=None):
    return command(['/usr/bin/xdotool', *args], text)


def input_action(value, connection=None):
    kind = value['type']
    if kind in ('click', 'drag'):
        xdotool('mousemove', str(math.floor(value['x'])), str(math.floor(value['y'])))
    if kind == 'click':
        xdotool('click', '--repeat', str(value.get('clickCount', 1)), '--delay', '100',
                '3' if value.get('button') == 'right' else '1')
    elif kind == 'type':
        require(connection is not None, 'INPUT_FAILED')
        connection.paste_text(value['text'])
    elif kind == 'key':
        xdotool('key', '--delay', '0', key_sequence(value['key']))
    elif kind == 'scroll':
        for delta, negative, positive in ((value['deltaY'], '4', '5'), (value.get('deltaX', 0), '6', '7')):
            if delta:
                xdotool('click', '--repeat', str(math.ceil(abs(delta) / 120)), '--delay', '15',
                        negative if delta < 0 else positive)
    elif kind == 'drag':
        xdotool('mousedown', '1')
        duration = value.get('durationMs', 600) / 1000
        began = time.monotonic()
        for step in range(1, 21):
            interrupted()
            target = began + duration * step / 20
            if target > time.monotonic():
                time.sleep(target - time.monotonic())
            xdotool('mousemove',
                    str(math.floor(value['x'] + (value['toX'] - value['x']) * step / 20)),
                    str(math.floor(value['y'] + (value['toY'] - value['y']) * step / 20)))
        xdotool('mouseup', '1')


def png_valid(data):
    require(57 <= len(data) <= PNG_LIMIT and data[:8] == b'\x89PNG\r\n\x1a\n', 'CAPTURE_FAILED')
    offset, pixels = 8, False
    while offset < len(data):
        require(offset + 12 <= len(data), 'CAPTURE_FAILED')
        length = struct.unpack('>I', data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        end = offset + 8 + length
        require(end + 4 <= len(data) and
                zlib.crc32(data[offset + 4:end]) == struct.unpack('>I', data[end:end + 4])[0],
                'CAPTURE_FAILED')
        if offset == 8:
            require(kind == b'IHDR' and length == 13 and
                    struct.unpack('>II', data[offset + 8:offset + 16]) == (WIDTH, HEIGHT), 'CAPTURE_FAILED')
        elif kind == b'IHDR':
            raise Failure('CAPTURE_FAILED')
        if kind == b'IDAT':
            pixels = True
        if kind == b'IEND':
            require(length == 0 and end + 4 == len(data) and pixels, 'CAPTURE_FAILED')
            return
        offset = end + 4
    raise Failure('CAPTURE_FAILED')


def capture_png():
    # Debian scrot 1.8.1 needs a filename. An inherited anonymous RAM file works
    # without creating a replaceable pathname or retaining an image on disk.
    fd = os.memfd_create('openbot-capture', os.MFD_CLOEXEC)
    try:
        command(['/usr/bin/scrot', '-o', '-F', '/proc/self/fd/%d' % fd], pass_fds=(fd,))
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= PNG_LIMIT, 'CAPTURE_FAILED')
        os.lseek(fd, 0, os.SEEK_SET)
        with os.fdopen(fd, 'rb', closefd=False) as image:
            data = image.read(PNG_LIMIT + 1)
        png_valid(data)
        return data
    finally:
        os.close(fd)


def operate(value, session):
    x = None
    error = None
    result = None
    try:
        interrupted()
        x = XConnection()
        token = geometry_token(session)
        if value['op'] == 'status':
            result = {'available': True, 'authorized': True, 'kind': 'virtual', 'width': WIDTH,
                      'height': HEIGHT, 'displayId': DISPLAY_ID, 'session': session,
                      'permissions': {'screenRecording': 'granted', 'accessibility': 'granted'},
                      'displays': [{'id': DISPLAY_ID, 'x': 0, 'y': 0, 'logicalWidth': WIDTH,
                                    'logicalHeight': HEIGHT, 'pixelWidth': WIDTH, 'pixelHeight': HEIGHT}]}
        elif value['op'] == 'capture':
            data = capture_png()
            result = {'png': base64.b64encode(data).decode('ascii'), 'width': WIDTH, 'height': HEIGHT,
                      'displayId': DISPLAY_ID, 'geometryToken': token, 'session': session,
                      'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        else:
            require(value['frame']['geometryToken'] == token, 'STALE_FRAME')
            x.begin_input()
            input_action(value['input'], x)
            result = {'ok': True, 'session': session, 'geometryToken': token}
        interrupted()
    except Failure as failure:
        error = failure
    except BaseException:
        error = Failure('DESKTOP_UNAVAILABLE')
    finally:
        if x:
            if value['op'] == 'input':
                try:
                    x.release()
                except BaseException:
                    error = Failure('CLEANUP_UNKNOWN', False)
            try:
                x.close()
            except BaseException:
                error = Failure('CLEANUP_UNKNOWN', False)
    return envelope(error) if error else {'ok': True, 'result': result}


