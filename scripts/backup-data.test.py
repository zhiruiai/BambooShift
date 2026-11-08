"""Exercise real SQLite snapshots, private copying, verification, and rollback."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('backup_data', Path(__file__).with_name('backup-data.py'))
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)


class DataBackupTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'
        self.source.mkdir(mode=0o700)
        self.db = sqlite3.connect(self.source / 'openbot.sqlite')
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE messages(id TEXT PRIMARY KEY,data TEXT NOT NULL)')
        self.db.execute('INSERT INTO messages VALUES(?,?)', ('original', json.dumps({'content': 'Private synthetic text 🐷'})))
        self.db.commit()
        self.snapshot = self.root / 'snapshot'

    def tearDown(self):
        self.db.close()
        self.temporary.cleanup()

    def test_online_backup_sees_committed_wal_without_copying_uncommitted_work(self):
        self.db.execute('INSERT INTO messages VALUES(?,?)', ('uncommitted', '{}'))
        result = backup.backup(self.source, self.snapshot)
        self.assertEqual(result['databases'], 1)
        self.assertFalse(result['quiesced'])
        manifest = backup.verify(self.snapshot)
        self.assertEqual(manifest['files'][0]['tables']['messages']['count'], 1)
        self.assertFalse((self.snapshot / 'openbot.sqlite-wal').exists())
        copied = sqlite3.connect(self.snapshot / 'openbot.sqlite')
        self.assertEqual(copied.execute('select id from messages').fetchall(), [('original',)])
        copied.close()
        self.assertEqual(self.db.execute('select count(*) from messages').fetchone()[0], 2)
        self.db.rollback()

    def test_links_are_not_followed_and_opaque_setup_code_is_only_raw_copied(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'must-not-copy').write_text('synthetic outside data')
        (self.source / 'linked-directory').symlink_to(outside, target_is_directory=True)
        (self.source / 'linked-file').symlink_to(outside / 'must-not-copy')
        setup = self.source / 'operator-setup-code'
        setup.write_bytes(b'synthetic-opaque-setup-code\n')
        real_hash = backup.hash_file
        def no_setup_hash(path):
            self.assertNotEqual(Path(path).name, 'operator-setup-code')
            return real_hash(path)
        with patch.object(backup, 'hash_file', side_effect=no_setup_hash):
            backup.backup(self.source, self.snapshot)
            manifest = backup.verify(self.snapshot)
        item = next(item for item in manifest['files'] if item['path'] == 'operator-setup-code')
        self.assertTrue(item['opaque'])
        self.assertNotIn('sha256', item)
        self.assertEqual((self.snapshot / 'operator-setup-code').read_bytes(), setup.read_bytes())
        self.assertFalse((self.snapshot / 'linked-file').exists())
        self.assertFalse((self.snapshot / 'linked-directory').exists())
        self.assertEqual(len([s for s in manifest['skipped'] if s['reason'] == 'symlink']), 2)
        for directory, names, files in os.walk(self.snapshot):
            self.assertEqual(stat.S_IMODE(Path(directory).stat().st_mode), 0o700)
            for name in files:
                self.assertEqual(stat.S_IMODE(Path(directory,name).stat().st_mode), 0o600)

    def test_restoring_to_new_directory_preserves_rows_files_and_private_permissions(self):
        assets = self.source / 'workspace'
        assets.mkdir()
        (assets / 'report.csv').write_bytes(b'name,value\nsynthetic,42\n')
        backup.backup(self.source, self.snapshot, quiesced=True)
        original = backup.verify(self.snapshot)
        restored = self.root / 'rollback'
        backup.restore(self.snapshot, restored)
        self.assertEqual(backup.fingerprint(restored / 'openbot.sqlite'), original['files'][0]['tables'])
        self.assertEqual((restored / 'workspace/report.csv').read_bytes(), (assets / 'report.csv').read_bytes())
        with self.assertRaises(ValueError):
            backup.restore(self.snapshot, self.source)
        with self.assertRaises(ValueError):
            backup.backup(self.source, self.source / 'inside')
        self.assertFalse((restored / backup.REHEARSAL).exists())

    def test_tampered_snapshot_cannot_be_restored_or_used_as_a_rehearsal(self):
        (self.source / 'private.json').write_text('{"fixture":"secret"}')
        backup.backup(self.source, self.snapshot)
        (self.snapshot / 'private.json').write_text('{"fixture":"tampered"}')
        with self.assertRaises(ValueError):
            backup.restore(self.snapshot, self.root / 'bad', rehearsal=True)
        self.assertFalse((self.root / 'bad').exists())

    def test_rehearsal_marker_binds_separate_verified_snapshot(self):
        backup.backup(self.source, self.snapshot)
        copy = self.root / 'rehearsal'
        backup.restore(self.snapshot, copy, rehearsal=True)
        marker = json.loads((copy / backup.REHEARSAL).read_text())
        self.assertEqual(marker['purpose'], 'offline-migration-rehearsal')
        self.assertEqual(marker['manifestSha256'], backup.hash_file(self.snapshot / backup.MANIFEST))
        self.assertNotEqual(marker['backup'], str(copy))
        self.assertEqual(backup.verify(self.snapshot)['files'][0]['tables']['messages']['count'], 1)


if __name__ == '__main__':
    unittest.main()
