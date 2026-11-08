#!/usr/bin/env python3
"""Explicit synthetic-only desktop checks inside an already started test session.

Run as root with a test session's manifest. Does not start, stop, renew, or bind a
Worker. Writes only its own temporary workspace fixture and private evidence.
"""
import base64
import hashlib
import json
import os
import pathlib
import re
import signal
import struct
import subprocess
import sys
import time
import uuid


def main():
    assert len(sys.argv) == 2 and os.geteuid() == 0
    manifest_path = pathlib.Path(sys.argv[1])
    assert re.fullmatch(r'/opt/openbot/desktop/sessions/[a-f0-9-]{36}/manifest.json', str(manifest_path))
    manifest = json.loads(manifest_path.read_text())
    assert manifest['state'] == 'ready'
    session = {'id': manifest['sessionId'], 'generation': manifest['generation']}
    helper = [sys.executable, '/opt/openbot/desktop-control.py', '--manifest', str(manifest_path)]
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'}
    checks = []

    def call(payload):
        process = subprocess.run(helper, input=json.dumps(payload), capture_output=True,
                                 text=True, timeout=20, env=environment)
        result = json.loads(process.stdout)
        assert (process.returncode == 0) == (result['ok'] is True)
        return result

    def namespace_command(code):
        return ['/usr/bin/nsenter', '--target', str(manifest['keeper']['pid']),
                   '--mount', '--net', '--ipc', '--pid', '--root', '--wd=/workspace',
                   '/usr/bin/setpriv', '--reuid=65532', '--regid=65532', '--clear-groups',
                   '--no-new-privs', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all',
                   '/usr/local/bin/python3', '-c', code]

    def namespace(code):
        process = subprocess.run(namespace_command(code), capture_output=True, text=True, timeout=5,
                                 env={**environment, 'DISPLAY': ':1', 'XAUTHORITY': '/run/openbot/Xauthority',
                                      'PYTHONDONTWRITEBYTECODE': '1'})
        assert process.returncode == 0, process.stderr
        return json.loads(process.stdout)

    def pointer():
        return namespace('''
import ctypes,json
x=ctypes.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes=[ctypes.c_char_p];x.XOpenDisplay.restype=ctypes.c_void_p
x.XDefaultRootWindow.argtypes=[ctypes.c_void_p];x.XDefaultRootWindow.restype=ctypes.c_ulong
x.XQueryKeymap.argtypes=[ctypes.c_void_p,ctypes.c_void_p]
x.XQueryPointer.argtypes=[ctypes.c_void_p,ctypes.c_ulong]+[ctypes.POINTER(ctypes.c_ulong)]*2+[ctypes.POINTER(ctypes.c_int)]*4+[ctypes.POINTER(ctypes.c_uint)]
x.XCloseDisplay.argtypes=[ctypes.c_void_p]
d=x.XOpenDisplay(b':1');assert d
keys=ctypes.create_string_buffer(32);assert x.XQueryKeymap(d,keys)
root,child=ctypes.c_ulong(),ctypes.c_ulong();rx,ry,wx,wy=[ctypes.c_int() for _ in range(4)];mask=ctypes.c_uint()
assert x.XQueryPointer(d,x.XDefaultRootWindow(d),*[ctypes.byref(v) for v in [root,child,rx,ry,wx,wy,mask]])
print(json.dumps({'buttons':mask.value & 0x1f00,'keysHeld':any(keys.raw)}));x.XCloseDisplay(d)
''')

    def selection(focus=None):
        return namespace('''
import ctypes,json
x=ctypes.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes=[ctypes.c_char_p];x.XOpenDisplay.restype=ctypes.c_void_p
x.XInternAtom.argtypes=[ctypes.c_void_p,ctypes.c_char_p,ctypes.c_int];x.XInternAtom.restype=ctypes.c_ulong
x.XGetSelectionOwner.argtypes=[ctypes.c_void_p,ctypes.c_ulong];x.XGetSelectionOwner.restype=ctypes.c_ulong
x.XDefaultRootWindow.argtypes=[ctypes.c_void_p];x.XDefaultRootWindow.restype=ctypes.c_ulong
x.XGetInputFocus.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.c_int)]
x.XSetInputFocus.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_int,ctypes.c_ulong]
x.XSync.argtypes=[ctypes.c_void_p,ctypes.c_int];x.XCloseDisplay.argtypes=[ctypes.c_void_p]
d=x.XOpenDisplay(b':1');assert d
old=ctypes.c_ulong();revert=ctypes.c_int();x.XGetInputFocus(d,ctypes.byref(old),ctypes.byref(revert))
focus=''' + repr(focus) + '''
if focus is not None:
 x.XSetInputFocus(d,x.XDefaultRootWindow(d) if focus=='root' else focus,2,0);x.XSync(d,0)
owners={name:x.XGetSelectionOwner(d,x.XInternAtom(d,name.encode(),0)) for name in ['PRIMARY','CLIPBOARD']}
print(json.dumps({'focus':old.value,'owners':owners}));x.XCloseDisplay(d)
''')

    status = call({'op': 'status'})
    assert status['ok'] and status['result']['kind'] == 'virtual'
    assert status['result']['width'] == 1440 and status['result']['height'] == 900
    checks.append('real Xvfb status and geometry')
    screenshot = call({'op': 'capture', 'enabled': True, 'session': session})
    assert screenshot['ok'], screenshot
    frame = {key: screenshot['result'][key] for key in ['displayId', 'geometryToken', 'width', 'height']}

    def input_request(action):
        return {'op': 'input', 'enabled': True, 'session': session, 'frame': frame, 'input': action}

    wrong = input_request({'type': 'type', 'text': 'UNEXPECTED_STALE_FRAME'})
    wrong = {**wrong, 'frame': {**frame, 'geometryToken': '0' * 64}}
    assert call(wrong)['error']['code'] == 'STALE_FRAME'
    wrong = input_request({'type': 'type', 'text': 'UNEXPECTED_STALE_SESSION'})
    wrong = {**wrong, 'session': {**session, 'generation': str(uuid.uuid4())}}
    assert call(wrong)['error']['code'] == 'STALE_SESSION'
    checks.append('wrong frame and generation rejected before input')

    fixture = pathlib.Path('/opt/openbot/workspace') / ('.desktop-input-' + uuid.uuid4().hex + '.txt')
    samples = ['你好，OpenBot 桌面中文输入验证。', '第二轮：中文 🐷 😀 café',
               '第三轮，多行文本。\n第二行 🐷 😀 café']
    try:
        assert call(input_request({'type': 'click', 'x': 250, 'y': 180}))['ok']
        assert call(input_request({'type': 'key', 'key': 'Control+u'}))['ok']
        for expected in samples:
            fixture.unlink(missing_ok=True)
            command = "printf '%s\\n' '" + expected + "' > /workspace/" + fixture.name
            assert call(input_request({'type': 'type', 'text': command}))['ok']
            assert call(input_request({'type': 'key', 'key': 'Enter'}))['ok']
            until = time.monotonic() + 4
            while not fixture.exists() and time.monotonic() < until:
                time.sleep(.05)
            actual = fixture.read_bytes()
            assert actual == (expected + '\n').encode('utf-8'), repr(actual)
        checks.append('real click, three exact UTF-8 Chinese/emoji/multiline pastes and Enter in xterm')
        fixture.unlink()
        assert call(input_request({'type': 'type', 'text': 'cat > /workspace/' + fixture.name}))['ok']
        assert call(input_request({'type': 'key', 'key': 'Enter'}))['ok']
        boundary = '甲' * 298 + '🐷'
        assert len(boundary.encode('utf-16-le')) // 2 == 300
        assert call(input_request({'type': 'type', 'text': boundary}))['ok']
        assert call(input_request({'type': 'key', 'key': 'Enter'}))['ok']
        assert call(input_request({'type': 'key', 'key': 'Control+d'}))['ok']
        assert fixture.read_bytes() == (boundary + '\n').encode('utf-8')
        assert call(input_request({'type': 'type', 'text': boundary + 'a'}))['error']['code'] == 'INVALID_REQUEST'
        assert selection()['owners'] == {'PRIMARY': 0, 'CLIPBOARD': 0}
        checks.append('300 UTF-16 units delivered exactly, 301 rejected, temporary selections cleared')
    finally:
        fixture.unlink(missing_ok=True)

    drag = subprocess.Popen(helper, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=environment)
    drag.stdin.write(json.dumps(input_request({'type': 'drag', 'x': 100, 'y': 80,
                     'toX': 400, 'toY': 200, 'durationMs': 2000})).encode())
    drag.stdin.close()
    drag.stdin = None
    until = time.monotonic() + 1.5
    held = False
    while time.monotonic() < until and drag.poll() is None:
        if pointer()['buttons']:
            held = True
            break
        time.sleep(.05)
    assert held, 'drag must actually begin before cancellation'
    drag.send_signal(signal.SIGTERM)
    stdout, _ = drag.communicate(timeout=8)
    cancelled = json.loads(stdout)
    assert not cancelled['ok'] and cancelled['error']['code'] == 'CANCELLED'
    assert cancelled['error']['cleanupConfirmed'] is True
    released = pointer()
    assert released == {'buttons': 0, 'keysHeld': False}, released
    assert call(input_request({'type': 'key', 'key': 'Alt+Tab'}))['ok']
    checks.append('active drag TERM releases all keys/buttons and next input works')

    old_focus = selection()['focus']
    # A root-window focus request is not enough: Openbox can focus the terminal
    # again. This real blank X client receives keys but never requests a paste.
    receiver = subprocess.Popen(namespace_command('''
import ctypes,sys,time
x=ctypes.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes=[ctypes.c_char_p];x.XOpenDisplay.restype=ctypes.c_void_p
x.XDefaultRootWindow.argtypes=[ctypes.c_void_p];x.XDefaultRootWindow.restype=ctypes.c_ulong
x.XCreateSimpleWindow.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_int,ctypes.c_int,ctypes.c_uint,ctypes.c_uint,ctypes.c_uint,ctypes.c_ulong,ctypes.c_ulong];x.XCreateSimpleWindow.restype=ctypes.c_ulong
x.XMapWindow.argtypes=[ctypes.c_void_p,ctypes.c_ulong]
x.XStoreName.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_char_p]
x.XSetInputFocus.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_int,ctypes.c_ulong]
x.XSync.argtypes=[ctypes.c_void_p,ctypes.c_int];x.XCloseDisplay.argtypes=[ctypes.c_void_p]
d=x.XOpenDisplay(b':1');assert d
w=x.XCreateSimpleWindow(d,x.XDefaultRootWindow(d),1000,600,150,100,0,0,0)
x.XStoreName(d,w,b'OpenBot synthetic no-receiver');x.XMapWindow(d,w);x.XSync(d,0);time.sleep(.4)
x.XSetInputFocus(d,w,2,0);x.XSync(d,0);print(w,flush=True)
sys.stdin.buffer.read();x.XCloseDisplay(d)
'''), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={**environment, 'DISPLAY': ':1', 'XAUTHORITY': '/run/openbot/Xauthority'})
    try:
        receiver_window = int(receiver.stdout.readline())
        selection(receiver_window)
        pending = subprocess.Popen(helper, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env=environment)
        pending.stdin.write(json.dumps(input_request({'type': 'type', 'text': '合成取消测试 🐷'})).encode())
        pending.stdin.close()
        pending.stdin = None
        until = time.monotonic() + 2
        owned = False
        while time.monotonic() < until and pending.poll() is None:
            if all(selection()['owners'].values()):
                owned = True
                break
            time.sleep(.05)
        assert owned, 'selection must really exist before cancellation'
        pending.send_signal(signal.SIGTERM)
        stdout, _ = pending.communicate(timeout=8)
        selection_cancelled = json.loads(stdout)
        assert selection_cancelled == {'ok': False, 'error': {'code': 'CANCELLED', 'cleanupConfirmed': True}}
        assert selection()['owners'] == {'PRIMARY': 0, 'CLIPBOARD': 0}
        began = time.monotonic()
        no_receiver = call(input_request({'type': 'type', 'text': '合成超时测试 🐷'}))
        elapsed = time.monotonic() - began
        assert not no_receiver['ok'] and no_receiver['error']['cleanupConfirmed'] is True
        assert no_receiver['error']['code'] in ('TIMEOUT', 'CANCELLED') and 11 <= elapsed <= 16
        assert selection()['owners'] == {'PRIMARY': 0, 'CLIPBOARD': 0}
        assert pointer() == {'buttons': 0, 'keysHeld': False}
        checks.append('no receiver: active selection cancellation and deadline both clear owners and keys')
    finally:
        receiver.communicate(input=b'', timeout=5)
        selection(old_focus)

    screenshot = call({'op': 'capture', 'enabled': True, 'session': session})
    assert screenshot['ok'], screenshot
    raw = base64.b64decode(screenshot['result']['png'], validate=True)
    assert raw.startswith(b'\x89PNG\r\n\x1a\n') and struct.unpack('>II', raw[16:24]) == (1440, 900)
    png_path = manifest_path.parent / 'synthetic-desktop.png'
    descriptor = os.open(png_path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(raw)
    checks.append('real PNG capture after input and cancellation')
    result = {'session': session, 'checks': checks, 'capture': {'bytes': len(raw),
              'sha256': hashlib.sha256(raw).hexdigest(), 'width': 1440, 'height': 900},
              'unicodeSamples': samples, 'cancelled': cancelled, 'releasedInput': released,
              'selectionCancelled': selection_cancelled, 'noReceiver': no_receiver,
              'noReceiverElapsedSeconds': round(elapsed, 3)}
    path = manifest_path.parent / 'acceptance.json'
    path.write_text(json.dumps(result, ensure_ascii=False))
    path.chmod(0o600)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
