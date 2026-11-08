"""No namespaces/process signals: regression tests for the trusted launch protocol."""
import importlib.util
import json
import os
import pathlib
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch

from python_tool_build import build_tool

spec = importlib.util.spec_from_file_location('desktop_session', build_tool('desktop-session'))
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='openbot-desktop-lifecycle-')
        self.base = pathlib.Path(self.temporary.name)
        (self.base / 'sessions').mkdir()
        self.base_patch = patch.object(desktop, 'BASE', self.base)
        self.base_patch.start()
        self.cfg = {'cgroupRoot': str(self.base / 'cgroups')}

    def tearDown(self):
        self.base_patch.stop()
        self.temporary.cleanup()

    def test_session_cleanup_removes_verified_empty_browser_groups_before_parent(self):
        group = self.base / 'group'
        child = group / ('browser-' + str(uuid.uuid4()))
        child.mkdir(parents=True, mode=0o700)
        for path in (group, child):
            (path / 'cgroup.kill').write_text('')
            (path / 'cgroup.events').write_text('populated 0\n')
        removed = []
        original_lstat, original_rmdir = pathlib.Path.lstat, pathlib.Path.rmdir
        def trusted(path):
            value = original_lstat(path)
            return types.SimpleNamespace(st_uid=0, st_mode=value.st_mode)
        def cgroup_remove(path):
            for item in path.iterdir():
                if item.is_file():
                    item.unlink()
            removed.append(path)
            original_rmdir(path)
        with patch.object(pathlib.Path, 'lstat', trusted), patch.object(pathlib.Path, 'rmdir', cgroup_remove):
            desktop.clean_cgroup(group)
        self.assertEqual(removed, [child, group])
        self.assertFalse(group.exists())

    def test_session_cleanup_does_not_remove_unknown_child_directory(self):
        group = self.base / 'unknown-group'
        (group / 'not-a-browser').mkdir(parents=True)
        (group / 'cgroup.events').write_text('populated 0\n')
        with self.assertRaises(RuntimeError):
            desktop.clean_cgroup(group)
        self.assertTrue((group / 'not-a-browser').exists())

    def request(self, kind='release'):
        original = {'id': str(uuid.uuid4()), 'generation': str(uuid.uuid4())}
        target = {'id': original['id'] if kind == 'reset' else str(uuid.uuid4()), 'generation': str(uuid.uuid4())}
        return {'version': 1, 'operationId': str(uuid.uuid4()), 'kind': kind,
                'expectedSession': original, 'nextSession': target}

    def test_lifecycle_rejects_stale_generation_without_stopping_anything(self):
        request = self.request()
        with patch.object(desktop, 'private', return_value={'generation': str(uuid.uuid4())}), \
             patch.object(desktop, 'stop_session') as stop, patch.object(desktop, 'start') as start:
            with self.assertRaises(RuntimeError):
                desktop.lifecycle(self.cfg, request)
            stop.assert_not_called()
            start.assert_not_called()

    def test_release_and_reset_preserve_home_and_use_the_persisted_generation(self):
        for kind in ['release', 'reset']:
            with self.subTest(kind=kind):
                request = self.request(kind)
                previous, target = request['expectedSession'], request['nextSession']
                record = {'generation': previous['generation']}
                ready = {'state': 'ready', 'sessionId': target['id'], 'generation': target['generation']}
                with patch.object(desktop, 'private', return_value=record), \
                     patch.object(desktop, 'stop_session') as stop, patch.object(desktop, 'start', return_value=ready) as start:
                    result = desktop.lifecycle(self.cfg, request)
                    stop.assert_called_once_with(self.cfg, previous['id'], previous['generation'])
                    start.assert_called_once_with(self.cfg, target['id'], target['generation'])
                    self.assertTrue(result['oldStopped'])
                    self.assertTrue(result['homePreserved'])
                    self.assertEqual(result['session'], target)

    def test_reset_can_adopt_only_its_already_started_generation(self):
        request = self.request('reset')
        target = request['nextSession']
        directory = self.base / 'sessions' / target['id']
        directory.mkdir()
        (directory / 'control.json').touch()
        record = {'generation': target['generation'], 'supervisor': {'pid': 123, 'startTime': '456'}}
        ready = {'state': 'ready', 'sessionId': target['id'], 'generation': target['generation']}
        with patch.object(desktop, 'private', return_value=record), patch.object(desktop, 'identity', return_value='456'), \
             patch.object(desktop, 'stop_session') as stop, patch.object(desktop, 'start', return_value=ready):
            self.assertTrue(desktop.lifecycle(self.cfg, request)['oldStopped'])
            stop.assert_not_called()

    def test_empty_cgroup_is_not_proof_that_the_external_supervisor_exited(self):
        session_id = str(uuid.uuid4())
        record = {'sessionId': session_id, 'generation': str(uuid.uuid4()), 'supervisor': {'pid': 123, 'startTime': '456'}}
        clock = iter(range(0, 1000, 10))
        with patch.object(desktop, 'private', return_value=record), patch.object(desktop, 'identity', return_value='456'), \
             patch.object(desktop.os, 'pidfd_open', side_effect=ProcessLookupError, create=True), \
             patch.object(desktop, 'clean_cgroup') as clean, patch.object(desktop.time, 'monotonic', side_effect=lambda: next(clock)):
            with self.assertRaises(RuntimeError):
                desktop.stop_session(self.cfg, session_id, record['generation'])
            clean.assert_called_once()

    def test_zombie_identity_is_exited_even_before_pid1_reaps_it(self):
        with patch.object(pathlib.Path, 'read_text', return_value='123 (supervisor) Z ' + '0 ' * 18 + '456'):
            self.assertIsNone(desktop.identity(123))
        with patch.object(pathlib.Path, 'read_text', return_value='123 (supervisor) S ' + '0 ' * 18 + '456'):
            self.assertEqual(desktop.identity(123), '456')

    def test_launch_gate_opens_only_after_exact_control_identity_is_durable(self):
        session_id, generation = str(uuid.uuid4()), str(uuid.uuid4())
        events = []
        original_stat, original_write, original_private = pathlib.Path.stat, desktop.os.write, desktop.write_private
        def trusted_stat(path, *args, **kwargs):
            value = original_stat(path, *args, **kwargs)
            return types.SimpleNamespace(st_uid=0, st_mode=value.st_mode)
        def persist(path, value):
            original_private(path, value)
            events.append(('persisted', path.name))
        def acknowledge(fd, value):
            record = json.loads((self.base / 'sessions' / session_id / 'control.json').read_text())
            self.assertEqual(record['generation'], generation)
            self.assertEqual(record['supervisor'], {'pid': 123, 'startTime': '456'})
            events.append(('gate', value))
            original_private(self.base / 'sessions' / session_id / 'manifest.json',
                             {'state': 'ready', 'sessionId': session_id, 'generation': generation})
            return original_write(fd, value)
        process = types.SimpleNamespace(pid=123, poll=lambda: None)
        with patch.object(pathlib.Path, 'stat', trusted_stat), patch.object(desktop, 'identity', return_value='456'), \
             patch.object(desktop.os, 'chown'), \
             patch.object(desktop, 'write_private', persist), patch.object(desktop.os, 'write', acknowledge), \
             patch.object(desktop, 'private', side_effect=lambda path: json.loads(path.read_text())), \
             patch.object(desktop.subprocess, 'Popen', return_value=process) as launch:
            result = desktop.start(self.cfg, session_id, generation)
            self.assertEqual(result['generation'], generation)
            self.assertEqual(events[0], ('persisted', 'control.json'))
            self.assertEqual(events[1], ('gate', b'1'))
            argv = launch.call_args.args[0]
            self.assertEqual(argv[-2], generation)
            with self.assertRaises(OSError):
                os.fstat(int(argv[-1]))


if __name__ == '__main__':
    unittest.main()
