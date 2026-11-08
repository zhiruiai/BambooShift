"""No GUI: exercise the real helper parser, tool argv and cleanup boundaries."""
import base64
import ctypes
import importlib.util
import json
import os
import pathlib
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import zlib
from unittest.mock import patch

from python_tool_build import build_tool

spec = importlib.util.spec_from_file_location('desktop_control', build_tool('desktop-control'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

SESSION = {'id': '11111111-1111-1111-1111-111111111111', 'generation': '22222222-2222-2222-2222-222222222222'}
FRAME = {'displayId': 1, 'geometryToken': helper.geometry_token(SESSION), 'width': 1440, 'height': 900}


def input_request(value):
    return {'op': 'input', 'enabled': True, 'session': SESSION, 'frame': FRAME, 'input': value}


def png(width=1440, height=900):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress((b'\0' + b'\0' * width * 3) * height)) + chunk(b'IEND', b''))


class FakeX:
    events = []

    def __init__(self):
        self.events.append('open')

    def begin_input(self):
        self.events.append('begin')

    def release(self):
        self.events.append('release')

    def close(self):
        self.events.append('close')

    def paste_text(self, text):
        self.events.append(('paste', text))


class SelectionServer:
    """An Xlib call boundary, without loading Xlib or creating a GUI."""
    def __init__(self):
        self.atoms = {name: i + 1 for i, name in enumerate(['UTF8_STRING', 'TARGETS', 'TEXT', 'ATOM', 'PRIMARY', 'CLIPBOARD'])}
        self.owners = {}
        self.events = ['TARGETS', 'UTF8_STRING']
        self.properties = []
        self.notifications = []
        self.destroyed = []

    def XInternAtom(self, _display, name, _only):
        return self.atoms[name.decode()]

    def XDefaultRootWindow(self, _display):
        return 1

    def XCreateSimpleWindow(self, *_args):
        return 99

    def XSetSelectionOwner(self, _display, selection, owner, _time):
        self.owners[selection] = owner

    def XGetSelectionOwner(self, _display, selection):
        return self.owners.get(selection, 0)

    def XSync(self, *_args):
        pass

    def XPending(self, _display):
        return len(self.events)

    def XNextEvent(self, display, output):
        target = self.atoms[self.events.pop(0)]
        ctypes.cast(output, ctypes.POINTER(helper.XEvent)).contents.request = helper.XSelectionRequest(
            30, 1, 0, display, 99, 200, self.atoms['PRIMARY'], target, 300, 42)

    def XChangeProperty(self, _display, requestor, prop, kind, format_, _replace, data, length):
        if format_ == 8:
            content = ctypes.string_at(data, length)
        else:
            content = list(ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[:length])
        self.properties.append((requestor, prop, kind, format_, content))

    def XSendEvent(self, _display, requestor, _propagate, _mask, event):
        message = ctypes.cast(event, ctypes.POINTER(helper.XEvent)).contents.notification
        self.notifications.append((requestor, message.type, message.target, message.property, message.time))
        return 1

    def XDestroyWindow(self, _display, owner):
        self.destroyed.append(owner)


class DesktopControlTest(unittest.TestCase):
    def setUp(self):
        helper.STARTED = time.monotonic()
        helper.CANCELLED = False
        FakeX.events = []

    def parse(self, value):
        return helper.parse_request(json.dumps(value).encode())

    def rejects(self, value, code='INVALID_REQUEST'):
        with self.assertRaises(helper.Failure) as caught:
            self.parse(value)
        self.assertEqual(caught.exception.code, code)

    def test_closed_request_schema_and_explicit_enable(self):
        self.assertEqual(self.parse({'op': 'status'}), {'op': 'status'})
        for key, value in [('display', ':0'), ('pid', 1), ('path', '/tmp/a'), ('flags', ['--evil']), ('enabled', True)]:
            self.rejects({'op': 'status', key: value})
        capture = {'op': 'capture', 'enabled': True, 'session': SESSION}
        self.assertEqual(self.parse(capture), capture)
        for flag in (False, 1, 'true', None):
            self.rejects(dict(capture, enabled=flag))
        self.rejects(dict(capture, session=dict(SESSION, id='../../etc')))
        self.rejects({'op': 'exec', 'command': 'id'})

    def test_inputs_bounds_and_tool_injection(self):
        self.parse(input_request({'type': 'click', 'x': 1439.99, 'y': 899.99}))
        self.parse(input_request({'type': 'click', 'x': 1439.999999999, 'y': 899.999999999}))
        for point in (-1, 1440, float('nan'), float('inf'), True, '10'):
            self.rejects(input_request({'type': 'click', 'x': point, 'y': 0}))
        for value in ({'type': 'click', 'x': 0, 'y': 0, 'clickCount': 3},
                      {'type': 'type', 'text': 'a\0b'}, {'type': 'type', 'text': 'a' * 301},
                      {'type': 'type', 'text': '🙂' * 151},
                      {'type': 'type', 'text': '\ud800'},
                      {'type': 'scroll', 'deltaY': 4001}, {'type': 'key', 'key': 'x exec /bin/sh'},
                      {'type': 'key', 'key': 'Control+ControlOrMeta+A'},
                      {'type': 'key', 'key': '--clearmodifiers'},
                      {'type': 'drag', 'x': 1, 'y': 1, 'toX': 2, 'toY': 2, 'durationMs': 2001},
                      {'type': 'type', 'text': 'ok', 'command': 'id'}):
            self.rejects(input_request(value))

    def test_stale_frame_and_session_bound_geometry(self):
        for key, value in [('displayId', 2), ('width', 1920), ('height', 1080), ('geometryToken', 'http://evil')]:
            self.rejects(dict(input_request({'type': 'key', 'key': 'Enter'}), frame=dict(FRAME, **{key: value})), 'STALE_FRAME')
        self.assertNotEqual(helper.geometry_token(SESSION), helper.geometry_token(dict(SESSION, generation=SESSION['id'])))
        self.assertNotEqual(helper.geometry_token(SESSION), helper.geometry_token(dict(SESSION, id=SESSION['generation'])))

    def test_cgroup_membership_uses_trusted_mounted_subtree_and_rechecks_pid_identity(self):
        path = '/sys/fs/cgroup/openbot-desktop-' + 'a' * 32 + '/' + SESSION['id']
        record = {'pid': 2352, 'startTime': '100'}
        def source(filename):
            if filename == '/proc/2352/status':
                return 'Uid:\t65532\t65532\t65532\t65532'
            if filename == path + '/cgroup.procs':
                return '2352\n2353'
            raise AssertionError('Cannot infer a host cgroup name from its mounted path: ' + filename)
        with patch.object(helper, 'read_text', side_effect=source), patch.object(helper, 'proc_identity', return_value='100'):
            helper.process_matches(record, 65532, path)
        with patch.object(helper, 'read_text', side_effect=source), patch.object(helper, 'proc_identity', side_effect=['100', '101']):
            with self.assertRaises(helper.Failure) as caught:
                helper.process_matches(record, 65532, path)
            self.assertEqual(caught.exception.code, 'STALE_SESSION')
        with patch.object(helper, 'read_text', side_effect=lambda filename: 'Uid:\t65532\t65532' if filename.endswith('/status') else '2353'), \
                patch.object(helper, 'proc_identity', return_value='100'):
            with self.assertRaises(helper.Failure):
                helper.process_matches(record, 65532, path)

    def test_text_is_in_memory_selection_and_pixels_are_floored(self):
        with patch.object(helper, 'command', return_value=b'') as run:
            text = '--window 0 exec /bin/sh\n$(id); 你好'
            helper.input_action({'type': 'type', 'text': text}, FakeX())
            self.assertEqual(FakeX.events[-1], ('paste', text))
            run.assert_not_called()
            helper.input_action({'type': 'click', 'x': 10.9, 'y': 20.9, 'button': 'right', 'clickCount': 2})
            self.assertEqual(run.call_args_list[-2].args[0], ['/usr/bin/xdotool', 'mousemove', '10', '20'])
            self.assertEqual(run.call_args.args[0][-1], '3')
            helper.input_action({'type': 'key', 'key': 'ControlOrMeta+Shift+A'})
            self.assertEqual(run.call_args.args[0][-1], 'ctrl+shift+a')
            helper.input_action({'type': 'scroll', 'deltaY': -121, 'deltaX': 1})
            self.assertEqual(run.call_args_list[-2].args[0], ['/usr/bin/xdotool', 'click', '--repeat', '2', '--delay', '15', '4'])
            self.assertEqual(run.call_args.args[0][-1], '7')

    def selection(self):
        connection = object.__new__(helper.XConnection)
        connection.x = SelectionServer()
        connection.display = 123
        connection.selection_window = 0
        connection.selections = []
        return connection

    def test_unicode_selection_delivers_exact_utf8_and_destroys_both_temporary_owners(self):
        connection = self.selection()
        text = '你好，OpenBot 桌面中文输入验证。\n第二行 🐷 😀 café'
        self.parse(input_request({'type': 'type', 'text': '🙂' * 150}))
        with patch.object(helper, 'xdotool') as key:
            connection.paste_text(text)
        key.assert_called_once_with('key', '--delay', '0', 'shift+Insert')
        self.assertEqual(connection.x.properties[-1], (200, 300, connection.x.atoms['UTF8_STRING'], 8, text.encode('utf-8')))
        self.assertEqual(connection.x.notifications[-1], (200, 31, connection.x.atoms['UTF8_STRING'], 300, 42))
        self.assertEqual(connection.x.owners, {connection.x.atoms['PRIMARY']: 0, connection.x.atoms['CLIPBOARD']: 0})
        self.assertEqual(connection.x.destroyed, [99])
        self.assertEqual(connection.selection_window, 0)
        self.assertEqual(ctypes.sizeof(helper.XEvent), 24 * ctypes.sizeof(ctypes.c_long))

    def test_selection_cancel_timeout_and_delivery_failure_never_leave_an_owner(self):
        for code in ('CANCELLED', 'TIMEOUT'):
            connection = self.selection()
            with patch.object(helper, 'xdotool'), patch.object(helper, 'interrupted', side_effect=helper.Failure(code)):
                with self.assertRaises(helper.Failure) as caught:
                    connection.paste_text('尚未交付的文字')
            self.assertEqual(caught.exception.code, code)
            self.assertFalse(any(connection.x.owners.values()))
            self.assertEqual(connection.x.destroyed, [99])
            self.assertEqual(connection.x.properties, [])
        connection = self.selection()
        with patch.object(helper, 'xdotool'), patch.object(connection.x, 'XSendEvent', return_value=0):
            with self.assertRaises(helper.Failure):
                connection.paste_text('交付失败')
        self.assertFalse(any(connection.x.owners.values()))

    def test_unsupported_selection_target_is_refused_without_lossy_fallback(self):
        connection = self.selection()
        connection.x.atoms['STRING'] = 7
        connection.x.events.insert(0, 'STRING')
        with patch.object(helper, 'xdotool') as key:
            connection.paste_text('不丢字🐷')
        self.assertEqual(connection.x.notifications[0], (200, 31, 7, 0, 42))
        self.assertEqual(connection.x.properties[-1][-1], '不丢字🐷'.encode())
        self.assertEqual(key.call_count, 1, 'Never retry by generating Unicode keymap events')

    def test_png_crc_dimensions_and_complete_file(self):
        data = png()
        helper.png_valid(data)
        for invalid in (png(100, 900), data[:-1], data + b'extra', data[:60] + b'x' + data[61:], b'not a png'):
            with self.assertRaises(helper.Failure):
                helper.png_valid(invalid)

    def test_status_reads_geometry_without_capture_or_input(self):
        with patch.object(helper, 'XConnection', FakeX), patch.object(helper, 'command') as run:
            reply = helper.operate({'op': 'status'}, SESSION)
        self.assertTrue(reply['ok'])
        self.assertEqual(reply['result']['session'], SESSION)
        self.assertEqual(reply['result']['kind'], 'virtual')
        run.assert_not_called()
        self.assertEqual(FakeX.events, ['open', 'close'])

    def test_capture_uses_fixed_tool_and_real_png(self):
        data = png()
        with patch.object(helper, 'XConnection', FakeX), patch.object(helper, 'capture_png', return_value=data) as capture:
            reply = helper.operate({'op': 'capture'}, SESSION)
        capture.assert_called_once_with()
        self.assertEqual(base64.b64decode(reply['result']['png']), data)
        self.assertEqual(reply['result']['geometryToken'], FRAME['geometryToken'])
        self.assertEqual(FakeX.events, ['open', 'close'])

    def test_capture_anonymous_fd_is_bounded_and_closed_even_when_scrot_fails(self):
        data = png()
        for fail in (False, True):
            with tempfile.TemporaryFile() as temporary:
                descriptor = os.dup(temporary.fileno())
                def scrot(args, **kwargs):
                    self.assertEqual(args, ['/usr/bin/scrot', '-o', '-F', '/proc/self/fd/%d' % descriptor])
                    self.assertEqual(kwargs, {'pass_fds': (descriptor,)})
                    os.write(descriptor, data)
                    if fail:
                        raise helper.Failure('CAPTURE_FAILED')
                with patch.object(helper.os, 'memfd_create', return_value=descriptor, create=True), \
                        patch.object(helper.os, 'MFD_CLOEXEC', 1, create=True), \
                        patch.object(helper, 'command', side_effect=scrot):
                    if fail:
                        with self.assertRaises(helper.Failure):
                            helper.capture_png()
                    else:
                        self.assertEqual(helper.capture_png(), data)
                with self.assertRaises(OSError):
                    os.fstat(descriptor)

    def test_cancelled_drag_releases_after_tool_stops(self):
        def drag(_input, _connection):
            FakeX.events.append('tool-stopped')
            raise helper.Failure('CANCELLED')
        with patch.object(helper, 'XConnection', FakeX), patch.object(helper, 'input_action', side_effect=drag):
            reply = helper.operate(input_request({'type': 'drag'}), SESSION)
        self.assertEqual(reply, {'ok': False, 'error': {'code': 'CANCELLED', 'cleanupConfirmed': True}})
        self.assertEqual(FakeX.events, ['open', 'begin', 'tool-stopped', 'release', 'close'])

    def test_release_failure_never_claims_cleanup(self):
        with patch.object(helper, 'XConnection', FakeX), patch.object(helper, 'input_action'), \
                patch.object(FakeX, 'release', side_effect=OSError('private host error')):
            reply = helper.operate(input_request({'type': 'key'}), SESSION)
        self.assertEqual(reply, {'ok': False, 'error': {'code': 'CLEANUP_UNKNOWN', 'cleanupConfirmed': False}})
        self.assertNotIn('private', json.dumps(reply))

    def test_actual_tool_process_is_reaped_on_timeout(self):
        processes = []
        popen = subprocess.Popen
        def launch(*args, **kwargs):
            process = popen(*args, **kwargs)
            processes.append(process)
            helper.STARTED -= 13
            return process
        with patch.object(helper.subprocess, 'Popen', side_effect=launch):
            with self.assertRaises(helper.Failure) as caught:
                helper.command([sys.executable, '-c', 'import time; time.sleep(60)'])
        self.assertEqual(caught.exception.code, 'TIMEOUT')
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].returncode)

    def test_actual_tool_output_is_bounded_and_failure_is_generic(self):
        with self.assertRaises(helper.Failure) as caught:
            helper.command([sys.executable, '-c', 'print("x" * 9000)'], output_limit=64)
        self.assertEqual(caught.exception.code, 'INPUT_FAILED')
        with self.assertRaises(helper.Failure):
            helper.command([sys.executable, '-c', 'raise SystemExit(2)'])


if __name__ == '__main__':
    unittest.main()
