"""Exercise the browser protocol and relay without starting a desktop or joining namespaces."""
import contextlib
import importlib.util
import io
import json
import socket
import sys
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch

from python_tool_build import build_tool

spec = importlib.util.spec_from_file_location('desktop_browser', build_tool('desktop-browser'))
browser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser)
SESSION = '11111111-1111-4111-8111-111111111111'
GENERATION = '22222222-2222-4222-8222-222222222222'
SCOPE = '33333333-3333-4333-8333-333333333333'
LEASE = '44444444-4444-4444-8444-444444444444'


def arguments():
    return ['--manifest', browser.CONTROL + '/sessions/' + SESSION + '/manifest.json',
            '--session', SESSION, '--generation', GENERATION, '--scope', SCOPE]


class ProtocolTests(unittest.TestCase):
    def test_only_fixed_session_and_explicit_proxy_are_accepted(self):
        args = browser.browser_args(arguments() + ['--lease', LEASE, '--proxy-port', '18000'])
        self.assertEqual(args.proxy_port, 18000)
        self.assertEqual(browser.browser_args(arguments() + ['--probe']).scope, SCOPE)
        for extra in (['--probe', '--lease', LEASE], ['--lease', LEASE, '--proxy-port', '80'],
                      ['--lease', LEASE, '--proxy-port', '65536'], ['--url', 'https://example.test']):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises((browser.Failure, SystemExit)):
                browser.browser_args(arguments() + extra)
        changed = arguments()
        changed[1] = '/tmp/manifest.json'
        with self.assertRaises(browser.Failure):
            browser.browser_args(changed + ['--probe'])

    def test_chrome_has_fixed_proxy_profile_pipe_and_no_unsafe_sandbox_fallback(self):
        args = browser.chromium_args({'executable': '/desktop/opt/chrome/chrome'})
        self.assertIn('--remote-debugging-pipe', args)
        self.assertIn('--proxy-server=http://127.0.0.1:18080', args)
        self.assertIn('--proxy-bypass-list=<-loopback>', args)
        self.assertIn('--disable-quic', args)
        self.assertIn('--user-data-dir=/home/openbot/.browser-profile', args)
        self.assertNotIn('--no-sandbox', args)
        self.assertFalse(any('remote-debugging-port' in item for item in args))

    def test_status_checks_configuration_without_fork_or_network(self):
        session = Mock(session={'id': SESSION, 'generation': GENERATION})
        with patch.object(sys, 'argv', ['desktop-browser'] + arguments() + ['--probe']), \
                patch.object(browser.os, 'pidfd_open', create=True, return_value=12), \
                patch.object(browser.os, 'close'), patch.object(browser, 'browser_prctl'), \
                patch.object(browser.select, 'select', return_value=([], [], [])), \
                patch.object(browser, 'Session', return_value=session), \
                patch.object(browser, 'browser_configuration', return_value={'network': 'browser-proxy-only'}), \
                patch.object(browser.os, 'fork') as fork, \
                patch.object(browser, 'loopback_listener') as network, contextlib.redirect_stdout(io.StringIO()) as output:
            browser.browser_main()
            self.assertEqual(json.loads(output.getvalue())['session'], session.session)
            fork.assert_not_called()
            network.assert_not_called()
            session.current.assert_called_once()
            session.close.assert_called_once()

    def test_supervisor_restores_host_namespaces_while_child_keeps_separate_network(self):
        session = Mock(ns={'ipc': 10, 'mount': 11, 'pid': 12},
                       value={'cgroupPath': '/sys/fs/cgroup/test', 'namespaces': {'network': 'net:[1]'}})
        listener = Mock()
        with patch.object(browser.os, 'mkdir'), patch.object(browser.os, 'open', side_effect=range(30, 40)), \
                patch.object(browser.os, 'pidfd_open', create=True, return_value=90), \
                patch.object(browser.os, 'close'), patch.object(browser.os, 'fork', return_value=123), \
                patch.object(browser.os, 'readlink', return_value='net:[2]'), \
                patch.object(browser, 'loopback_listener', return_value=listener), \
                patch.object(browser, 'browser_setns') as enter:
            child, actual, group = browser.launch_isolated(session, {}, LEASE)
            self.assertEqual((child, actual), (123, listener))
            self.assertTrue(group.endswith('/browser-' + LEASE))
            self.assertEqual([call.args[0] for call in enter.call_args_list], [10, 11, 12, 33, 32, 31, 30])

    def test_parent_death_requires_cleanup_receipt_and_never_claims_unknown_cleanup(self):
        args = types.SimpleNamespace(lease=LEASE, proxy_port=18000)
        for confirmed in (True, False):
            session, listener = Mock(), Mock()
            with patch.object(browser.os, 'setsid'), patch.object(browser, 'browser_prctl'), \
                    patch.object(browser.signal, 'signal'), patch.object(browser, 'launch_isolated', return_value=(123, listener, '/cg')), \
                    patch.object(browser, 'BrowserRelay') as relay, \
                    patch.object(browser.select, 'select', return_value=([70], [], [])), \
                    patch.object(browser.os, 'kill') as kill, \
                    patch.object(browser.os, 'waitpid', side_effect=[(123, 0), ChildProcessError()]), \
                    patch.object(browser.os, 'close'), patch.object(browser, 'cleanup_browser', return_value=confirmed) as cleanup, \
                    patch.object(browser, 'receipt') as receipt:
                browser.supervise_browser(args, session, {}, 70)
                relay.return_value.poll.assert_not_called()
                relay.return_value.close.assert_called_once()
                kill.assert_called_once()
                cleanup.assert_called_once_with('/cg')
                receipt.assert_called_once_with(args, confirmed)

    def test_session_cleanup_race_is_idempotent_only_when_exact_cgroup_is_gone(self):
        for exists in (False, True):
            with patch.object(browser.pathlib.Path, 'write_text', side_effect=FileNotFoundError()), \
                    patch.object(browser.pathlib.Path, 'exists', return_value=exists):
                self.assertEqual(browser.cleanup_browser('/trusted/browser-' + LEASE), not exists)

    def test_workspace_configuration_change_stops_before_forwarding_and_still_drains(self):
        args = types.SimpleNamespace(lease=LEASE, proxy_port=18000)
        with patch.object(browser.os, 'setsid'), patch.object(browser, 'browser_prctl'), \
                patch.object(browser.signal, 'signal'), patch.object(browser, 'launch_isolated', return_value=(123, Mock(), '/cg')), \
                patch.object(browser, 'BrowserRelay') as relay, \
                patch.object(browser.select, 'select', return_value=([], [], [])), \
                patch.object(browser.os, 'kill'), \
                patch.object(browser.os, 'waitpid', side_effect=[(0, 0), (123, 0), ChildProcessError()]), \
                patch.object(browser.os, 'close'), patch.object(browser, 'cleanup_browser', return_value=True), \
                patch.object(browser, 'private_file', return_value={'workspaceScopeId': 'changed'}), \
                patch.object(browser, 'receipt') as receipt:
            with self.assertRaises(browser.Failure):
                browser.supervise_browser(args, Mock(), {'workspaceScopeId': SCOPE}, 70)
            relay.return_value.poll.assert_not_called()
            receipt.assert_called_once_with(args, True)


class RelayTests(unittest.TestCase):
    def test_large_bidirectional_payload_and_half_close_use_only_fixed_loopback_proxy(self):
        upstream = socket.socket()
        upstream.bind(('127.0.0.1', 0))
        upstream.listen()
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        listener.setblocking(False)
        relay = browser.BrowserRelay(listener, upstream.getsockname()[1])
        stop = threading.Event()
        errors, received = [], []
        payload = b'bounded synthetic payload\n' * 15000

        def origin():
            try:
                stream, _ = upstream.accept()
                with stream:
                    stream.settimeout(5)
                    data = bytearray()
                    while True:
                        part = stream.recv(8192)
                        if not part:
                            break
                        data.extend(part)
                    received.append(bytes(data))
                    stream.sendall(bytes(data)[::-1])
            except BaseException as error:
                errors.append(error)

        def forward():
            try:
                while not stop.is_set():
                    relay.poll()
                    self.assertTrue(all(len(buffer) <= 65536 for buffer in relay.pending.values()))
            except BaseException as error:
                errors.append(error)

        serving, forwarding = threading.Thread(target=origin), threading.Thread(target=forward)
        serving.start()
        forwarding.start()
        try:
            with socket.create_connection(listener.getsockname(), timeout=5) as client:
                client.sendall(payload)
                client.shutdown(socket.SHUT_WR)
                actual = bytearray()
                while True:
                    part = client.recv(8192)
                    if not part:
                        break
                    actual.extend(part)
                self.assertEqual(bytes(actual), payload[::-1])
            serving.join(5)
            self.assertEqual(received, [payload])
            self.assertEqual(errors, [])
        finally:
            stop.set()
            forwarding.join(5)
            relay.close()
            upstream.close()


if __name__ == '__main__':
    unittest.main()
