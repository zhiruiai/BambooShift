"""Verify fresh, complete, reproducible deployment programs without starting a GUI."""
import ast
import hashlib
import importlib.util
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

import python_tool_build as builder


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='openbot-python-build-')
        self.root = pathlib.Path(self.temporary.name) / 'source'
        self.output = pathlib.Path(self.temporary.name) / 'artifacts'
        self.root.mkdir()
        spec, sources = builder.sources()
        for relative, content in sources.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        shutil.copyfile(builder.ROOT / builder.LOCK, self.root / builder.LOCK)
        self.tools = list(spec['tools'])

    def tearDown(self):
        self.temporary.cleanup()

    def test_builds_match_each_definition_and_the_pinned_reviewed_program(self):
        # Shell remains byte-identical to its original program. Reviewed desktop
        # programs include browser admission and empty child-cgroup cleanup.
        original = {
            'desktop-control': '7046296b2d1f6cad358cb203fff5124387cbcf7774433c4dd2b391e2985eb2fa',
            'desktop-browser': '6e09be6cc9a99b12d4e7ffaf04af5476c177b687c790fc9901ca3a5c74877625',
            'desktop-session': 'a69c6270fc87e0df4af00ce108027dbe3dac8d670704827351c5c81ad77552bb',
            'isolated-shell': '66b8c0c23417695d5b0de48cc162ff0c2467c48ee9854dc07cd807039b19744c',
        }
        for tool in self.tools:
            path = builder.build_tool(tool, self.output, self.root)
            ast.parse(path.read_bytes())
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), original[tool])
            self.assertEqual(builder.build_tool(tool, self.output, self.root, verify=True), path)
            record = json.loads(path.with_suffix('.manifest.json').read_bytes())
            self.assertEqual(record['sha256'], original[tool])
            self.assertIn('python_tool_build.py', record['sources'])
            self.assertTrue(all(not name.startswith('/') for name in record['sources']))

    def test_source_change_is_rejected_before_using_an_existing_artifact(self):
        path = builder.build_tool('desktop-control', self.output, self.root)
        original = path.read_bytes()
        unit = self.root / 'python_tools/desktop_control/operations.py'
        unit.write_bytes(unit.read_bytes() + b'\n# Reviewed source change requires a new lock.\n')
        with self.assertRaisesRegex(ValueError, 'source lock is stale'):
            builder.build_tool('desktop-control', self.output, self.root)
        self.assertEqual(path.read_bytes(), original)
        builder.update_lock(self.root)
        with self.assertRaisesRegex(ValueError, 'artifact does not match'):
            builder.build_tool('desktop-control', self.output, self.root, verify=True)
        builder.build_tool('desktop-control', self.output, self.root)
        builder.build_tool('desktop-control', self.output, self.root, verify=True)

    def test_missing_undeclared_and_linked_sources_fail_closed(self):
        folder = self.root / 'python_tools/desktop_control'
        extra = folder / 'unexpected.py'
        extra.write_text('pass\n')
        with self.assertRaisesRegex(ValueError, 'manifest is incomplete'):
            builder.assemble('desktop-control', self.root)
        extra.unlink()
        original = folder / 'operations.py'
        data = original.read_bytes()
        original.unlink()
        with self.assertRaisesRegex(ValueError, 'manifest is incomplete'):
            builder.assemble('desktop-control', self.root)
        replacement = self.root / 'replacement.py'
        replacement.write_bytes(data)
        original.symlink_to(replacement)
        with self.assertRaisesRegex(ValueError, 'symbolic links'):
            builder.assemble('desktop-control', self.root)

    def test_artifact_or_provenance_tampering_is_rejected_and_build_replaces_links(self):
        path = builder.build_tool('desktop-control', self.output, self.root)
        path.write_bytes(path.read_bytes() + b'\n# tampered\n')
        with self.assertRaisesRegex(ValueError, 'artifact does not match'):
            builder.build_tool('desktop-control', self.output, self.root, verify=True)
        builder.build_tool('desktop-control', self.output, self.root)
        record = path.with_suffix('.manifest.json')
        record.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'provenance does not match'):
            builder.build_tool('desktop-control', self.output, self.root, verify=True)
        outside = self.output / 'outside.py'
        outside.write_text('untouched')
        path.unlink()
        path.symlink_to(outside)
        builder.build_tool('desktop-control', self.output, self.root)
        self.assertFalse(path.is_symlink())
        self.assertEqual(outside.read_text(), 'untouched')

    def test_real_cli_build_verify_and_source_entrypoint_use_complete_program(self):
        result = subprocess.run([sys.executable, str(builder.ROOT / 'python_tool_build.py'),
                                 'all', '--output', str(self.output)], capture_output=True, check=True)
        self.assertEqual({line.split(':', 1)[0] for line in result.stdout.decode().splitlines()},
                         {'desktop-control', 'desktop-session', 'desktop-browser', 'isolated-shell'})
        subprocess.run([sys.executable, str(builder.ROOT / 'python_tool_build.py'),
                        'all', '--output', str(self.output), '--verify'], capture_output=True, check=True)
        # An invalid desktop request fails before any manifest, GUI or tool access.
        wrapper = subprocess.run([sys.executable, str(builder.ROOT / 'desktop-control.py')],
                                 input=b'{}', capture_output=True)
        direct = subprocess.run([sys.executable, str(self.output / 'desktop-control.py')],
                                input=b'{}', capture_output=True)
        self.assertEqual(wrapper.returncode, direct.returncode)
        self.assertEqual(wrapper.stdout, direct.stdout)
        self.assertFalse(json.loads(wrapper.stdout)['ok'])
        self.assertIn(json.loads(wrapper.stdout)['error']['code'], ['INVALID_REQUEST', 'CANCELLED'])



if __name__ == '__main__':
    unittest.main()
