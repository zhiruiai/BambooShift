#!/usr/bin/env python3
"""One bounded operation in a verified, existing Linux desktop namespace.

Only the outside root process reads manifests. A descendant joins pinned
namespaces/root, forks into the PID namespace and drops privileges before
connecting to X11 or starting fixed tools. No operation starts a GUI session.
"""
from __future__ import annotations

import base64
import ctypes
import datetime
import errno
import fcntl
import hashlib
import json
import math
import os
import re
import resource
import select
import signal
import stat
import struct
import subprocess
import sys
import time
import zlib

CONTROL = '/opt/openbot/desktop'
CONFIG = CONTROL + '/config.json'
HELPER = '/opt/openbot/desktop-control.py'
INNER_HELPER = '/usr/local/lib/openbot/desktop-control.py'
UUID = r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
WIDTH, HEIGHT, DISPLAY_ID = 1440, 900, 1
NAMESPACES = (('mount', 'mnt'), ('pid', 'pid'), ('network', 'net'), ('ipc', 'ipc'))
TASK_UID = TASK_GID = 65532
PNG_LIMIT = 8 * 1024 * 1024
MAX_TEXT_UNITS = 300  # Keep in sync with shared/linux-desktop.ts (UTF-16 units).
REPLY_LIMIT = 12 * 1024 * 1024
CANCELLED = False
STARTED = time.monotonic()
LIBC = ctypes.CDLL(None, use_errno=True)


class Failure(Exception):
    def __init__(self, code='DESKTOP_UNAVAILABLE', cleanup=True):
        super().__init__(code)
        self.code = code
        self.cleanup = cleanup and code != 'CLEANUP_UNKNOWN'


def require(condition, code='DESKTOP_UNAVAILABLE'):
    if not condition:
        raise Failure(code)


def interrupted():
    if CANCELLED:
        raise Failure('CANCELLED')
    if time.monotonic() - STARTED >= 12:
        raise Failure('TIMEOUT')


def cancelled(_signum, _frame):
    global CANCELLED
    CANCELLED = True


def envelope(error):
    return {'ok': False, 'error': {'code': error.code, 'cleanupConfirmed': error.cleanup}}


def encode(value):
    return json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode()


def uuid(value):
    return isinstance(value, str) and re.fullmatch(UUID, value) is not None


def integer(value, low, high):
    return type(value) is int and low <= value <= high


def finite(value, low, high):
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high


KEYS = {
    'enter': 'Return', 'tab': 'Tab', 'escape': 'Escape', 'backspace': 'BackSpace',
    'delete': 'Delete', 'arrowleft': 'Left', 'arrowright': 'Right', 'arrowup': 'Up',
    'arrowdown': 'Down', 'home': 'Home', 'end': 'End', 'pageup': 'Prior',
    'pagedown': 'Next', 'space': 'space',
    '=': 'equal', '-': 'minus', ']': 'bracketright', '[': 'bracketleft',
    ';': 'semicolon', "'": 'apostrophe', '\\': 'backslash', ',': 'comma',
    '/': 'slash', '.': 'period', '`': 'grave',
}
KEYS.update({str(i): str(i) for i in range(10)})
KEYS.update({chr(i): chr(i) for i in range(ord('a'), ord('z') + 1)})
KEYS.update({'f%d' % i: 'F%d' % i for i in range(1, 13)})
MODIFIERS = {'controlormeta': 'ctrl', 'control': 'ctrl', 'meta': 'super',
             'command': 'super', 'alt': 'alt', 'option': 'alt', 'shift': 'shift'}


def key_sequence(value):
    require(isinstance(value, str) and 0 < len(value) <= 100, 'INVALID_REQUEST')
    parts = value.lower().split('+')
    require(len(parts) <= 5 and parts[-1] in KEYS and
            all(part in MODIFIERS for part in parts[:-1]), 'INVALID_REQUEST')
    modifiers = [MODIFIERS[part] for part in parts[:-1]]
    require(len(set(modifiers)) == len(modifiers), 'INVALID_REQUEST')
    return '+'.join(modifiers + [KEYS[parts[-1]]])


def validate_input(value):
    require(isinstance(value, dict), 'INVALID_REQUEST')
    kind = value.get('type')
    allowed = {
        'click': {'type', 'x', 'y', 'button', 'clickCount'},
        'drag': {'type', 'x', 'y', 'toX', 'toY', 'durationMs'},
        'type': {'type', 'text'}, 'key': {'type', 'key'},
        'scroll': {'type', 'deltaY', 'deltaX'},
    }
    require(kind in allowed and set(value) <= allowed[kind], 'INVALID_REQUEST')
    if kind in ('click', 'drag'):
        require(finite(value.get('x'), 0, WIDTH) and value['x'] < WIDTH and
                finite(value.get('y'), 0, HEIGHT) and value['y'] < HEIGHT, 'INVALID_REQUEST')
    if kind == 'click':
        require(value.get('button', 'left') in ('left', 'right') and
                integer(value.get('clickCount', 1), 1, 2), 'INVALID_REQUEST')
    elif kind == 'drag':
        require(finite(value.get('toX'), 0, WIDTH) and value['toX'] < WIDTH and
                finite(value.get('toY'), 0, HEIGHT) and value['toY'] < HEIGHT and
                finite(value.get('durationMs', 600), 100, 2000), 'INVALID_REQUEST')
    elif kind == 'type':
        text = value.get('text')
        require(isinstance(text, str) and 0 < len(text) <= MAX_TEXT_UNITS and '\0' not in text,
                'INVALID_REQUEST')
        try:
            text.encode('utf-8')
            require(len(text.encode('utf-16-le')) // 2 <= MAX_TEXT_UNITS, 'INVALID_REQUEST')
        except UnicodeError:
            raise Failure('INVALID_REQUEST')
    elif kind == 'key':
        key_sequence(value.get('key'))
    elif kind == 'scroll':
        require(finite(value.get('deltaY'), -4000, 4000) and
                finite(value.get('deltaX', 0), -4000, 4000), 'INVALID_REQUEST')
    return value


def parse_request(raw):
    require(len(raw) <= 131072, 'INVALID_REQUEST')
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        raise Failure('INVALID_REQUEST')
    require(isinstance(value, dict), 'INVALID_REQUEST')
    op = value.get('op')
    if op == 'status':
        require(set(value) == {'op'}, 'INVALID_REQUEST')
        return value
    require(op in ('capture', 'input'), 'INVALID_REQUEST')
    fields = {'op', 'enabled', 'session'} | ({'input', 'frame'} if op == 'input' else set())
    require(set(value) == fields and value.get('enabled') is True, 'INVALID_REQUEST')
    session = value.get('session')
    require(isinstance(session, dict) and set(session) == {'id', 'generation'} and
            uuid(session.get('id')) and uuid(session.get('generation')), 'INVALID_REQUEST')
    if op == 'input':
        validate_input(value.get('input'))
        frame = value.get('frame')
        require(isinstance(frame, dict) and set(frame) ==
                {'displayId', 'geometryToken', 'width', 'height'} and
                integer(frame.get('displayId'), DISPLAY_ID, DISPLAY_ID) and
                integer(frame.get('width'), WIDTH, WIDTH) and
                integer(frame.get('height'), HEIGHT, HEIGHT) and
                isinstance(frame.get('geometryToken'), str) and
                re.fullmatch(r'[a-f0-9]{64}', frame['geometryToken']), 'STALE_FRAME')
    return value


def request():
    fd = sys.stdin.fileno()
    os.set_blocking(fd, False)
    raw = bytearray()
    while True:
        interrupted()
        readable, _, _ = select.select([fd], [], [], 0.025)
        if not readable:
            continue
        chunk = os.read(fd, min(8192, 131073 - len(raw)))
        if not chunk:
            return parse_request(raw)
        raw.extend(chunk)
        require(len(raw) <= 131072, 'INVALID_REQUEST')


