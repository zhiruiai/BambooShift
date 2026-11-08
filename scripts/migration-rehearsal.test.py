"""Frozen Node schemas migrate offline and a verified snapshot restores original data."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from data_backup.sqlite_copy import fingerprint

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('backup_data', ROOT / 'scripts/backup-data.py')
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)


def query(path, sql, parameters=()):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    try:
        return connection.execute(sql, parameters).fetchall()
    finally:
        connection.close()


def records(path, table):
    return {key: json.loads(value) for key, value in query(path, 'SELECT id,data FROM "' + table + '"')}


class MigrationRehearsalTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.source = cls.root / 'node-source'
        cls.snapshot = cls.root / 'snapshot'
        cls.migrated = cls.root / 'rust-copy'
        cls.probe = Path(os.environ.get('OPENBOT_MIGRATION_PROBE', str(ROOT / '.build/rust/debug/openbot-migration-probe')))
        result = subprocess.run(['node',str(ROOT/'scripts/run.mjs'),str(ROOT/'scripts/node-migration-fixture.ts'),str(cls.source)], cwd=ROOT, capture_output=True)
        if result.returncode:
            raise AssertionError('Synthetic legacy-schema fixture failed: ' + result.stderr.decode())
        cls.original = {str(p.relative_to(cls.source)): fingerprint(p) for p in cls.source.rglob('*.sqlite')}
        backup.backup(cls.source, cls.snapshot, quiesced=True)
        backup.restore(cls.snapshot, cls.migrated, rehearsal=True)
        result = subprocess.run([str(cls.probe),'--rehearsal-dir',str(cls.migrated),'--report',str(cls.root/'report.json')], cwd=ROOT, capture_output=True)
        if result.returncode:
            raise AssertionError('Offline Rust migration probe failed: ' + result.stderr.decode())
        cls.report = json.loads((cls.root/'report.json').read_text())
        cls.identity = json.loads((cls.source/'fixture-private.json').read_text())

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_accounts_and_central_publications_retain_every_original_row_and_key(self):
        for relative in ['platform/identity.sqlite','platform/bot-templates.sqlite','platform/shared-bots.sqlite']:
            current = fingerprint(self.migrated/relative)
            for table, before in self.original[relative].items():
                self.assertEqual(current[table], before, (relative, table))
        self.assertFalse(self.report['schedulerStarted'])
        self.assertFalse(self.report['listenersStarted'])
        self.assertEqual(len(self.report['workspaces']), 4)
        self.assertTrue(all(row['activeTasks'] == 0 for row in self.report['workspaces']))

    def test_business_content_files_and_avatars_survive_while_uncertain_work_is_interrupted(self):
        for relative in [p for p in self.original if p.endswith('openbot.sqlite')]:
            old, new = self.source/relative, self.migrated/relative
            for table in ['conversations','memories','routines','skills','files','avatar_assets']:
                self.assertEqual(fingerprint(new)[table], self.original[relative][table], (relative,table))
            before, after = records(old,'messages'),records(new,'messages')
            self.assertEqual(set(before),set(after))
            self.assertEqual(before['completed'],after['completed'])
            self.assertEqual(after['queued']['delivery']['state'],'interrupted')
            self.assertEqual(after['queued']['content'],before['queued']['content'])
            self.assertEqual(after['started']['delivery']['state'],'interrupted')
            self.assertEqual(after['unfinished']['status'],'error')
            self.assertTrue(after['unfinished']['content'].startswith(before['unfinished']['content']))
            self.assertEqual(records(new,'agents').keys(),records(old,'agents').keys())
            for key,bot in records(old,'agents').items():
                expected=dict(bot,status='idle')
                self.assertEqual(records(new,'agents')[key],expected)
            runs=[json.loads(row[0]) for row in query(new,'select data from routine_runs')]
            self.assertTrue(all(run['status']=='interrupted' for run in runs))
            actions=[json.loads(row[0]) for row in query(new,'select data from app_actions')]
            self.assertTrue(all(action['action']['status']=='error' for action in actions))
            self.assertEqual((new.parent/'workspace/report.md').read_bytes(),(old.parent/'workspace/report.md').read_bytes())
            self.assertEqual((new.parent/'pi/fixture.jsonl').read_bytes(),(old.parent/'pi/fixture.jsonl').read_bytes())

    def test_private_credentials_move_out_of_database_without_changing_schema_hash_order(self):
        for relative in [p for p in self.original if p.endswith('openbot.sqlite')]:
            old,new=self.source/relative,self.migrated/relative
            settings=records(new,'settings')
            self.assertFalse(any(key=='secrets' or key.startswith('model-profile-secret:') for key in settings))
            self.assertFalse(any('apiKey' in value for value in settings.values()))
            profiles=[v for key,v in settings.items() if key.startswith('model-profile:')]
            self.assertEqual(len(profiles),1)
            self.assertIsInstance(profiles[0]['credentialRef'],str)
            models=json.loads((new.parent/'config/models.private.json').read_text())
            self.assertEqual(models['entries'][profiles[0]['credentialRef']]['apiKey'],'SYNTHETIC_LEGACY_MODEL_KEY')
            applications=records(new,'app_connections')
            self.assertEqual(set(applications),set(records(old,'app_connections')))
            for app in applications.values():
                self.assertNotIn('token',app)
                self.assertNotIn('oauth',app)
                self.assertIsInstance(app['credentialRef'],str)
            self.assertEqual(query(old,"select json_extract(data,'$.tools') from app_connections"),query(new,"select json_extract(data,'$.tools') from app_connections"))
            for name in ['models.private.json','apps.private.json']:
                self.assertEqual((new.parent/'config'/name).stat().st_mode & 0o777,0o600)
        self.assertTrue(all(w['credentials']['activeModelKeyReadable'] for w in self.report['workspaces']))

    def test_rollback_and_repeat_initialization_preserve_the_correct_side_of_the_boundary(self):
        rollback=self.root/'rollback'
        backup.restore(self.snapshot,rollback)
        for relative,before in self.original.items():
            self.assertEqual(fingerprint(rollback/relative),before)
            self.assertEqual(fingerprint(self.source/relative),before)
        before={str(p.relative_to(self.migrated)):fingerprint(p) for p in self.migrated.rglob('*.sqlite')}
        result=subprocess.run([str(self.probe),'--rehearsal-dir',str(self.migrated),'--report',str(self.root/'second-report.json')],cwd=ROOT,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr.decode())
        for relative,data in before.items():
            self.assertEqual(fingerprint(self.migrated/relative),data)
        denied=subprocess.run([str(self.probe),'--rehearsal-dir',str(self.source),'--report',str(self.root/'forbidden.json')],cwd=ROOT,capture_output=True)
        self.assertNotEqual(denied.returncode,0)
        self.assertFalse((self.root/'forbidden.json').exists())
        for relative,data in self.original.items():
            self.assertEqual(fingerprint(self.source/relative),data)


if __name__ == '__main__':
    unittest.main()
