"""Consistent per-database copies and content-free SQLite fingerprints."""
import hashlib
import json
import sqlite3
from pathlib import Path


def quoted(name):
    return '"' + name.replace('"', '""') + '"'


def encoded(value, column=None):
    if isinstance(value, bytes):
        return {"blobSha256": hashlib.sha256(value).hexdigest(), "length": len(value)}
    if column == "data" and isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            pass
    return value


def digest(rows):
    hashes = [hashlib.sha256(json.dumps(row, ensure_ascii=False, sort_keys=True,
              separators=(',', ':')).encode()).digest() for row in rows]
    return hashlib.sha256(b''.join(sorted(hashes))).hexdigest()


def fingerprint(path):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')
        if connection.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('SQLite integrity check failed')
        result = {}
        tables = connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
        for (name,) in tables:
            columns = connection.execute('PRAGMA table_info(' + quoted(name) + ')').fetchall()
            names = [row[1] for row in columns]
            keys = [row[1] for row in sorted(columns, key=lambda row: row[5]) if row[5]]
            rows = connection.execute('SELECT * FROM ' + quoted(name)).fetchall()
            normalized = [[encoded(v, col) for col, v in zip(names, row)] for row in rows]
            primary = [[encoded(row[names.index(key)]) for key in keys] for row in rows]
            result[name] = {'count': len(rows), 'columns': names, 'primaryKey': keys,
                            'rowsSha256': digest(normalized), 'keysSha256': digest(primary)}
        connection.rollback()
        return result
    finally:
        connection.close()


def copy_database(source, destination):
    reader = sqlite3.connect(Path(source).resolve().as_uri() + '?mode=ro', uri=True, timeout=10)
    writer = sqlite3.connect(str(destination))
    try:
        reader.execute('PRAGMA query_only=ON')
        reader.backup(writer, pages=256, sleep=0.05)
        if writer.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('SQLite backup integrity check failed')
        writer.commit()
        if writer.execute('PRAGMA journal_mode=DELETE').fetchone()[0] != 'delete':
            raise ValueError('Backup must be a self-contained rollback-journal database')
    finally:
        writer.close()
        reader.close()
    # Some SQLite builds leave an unused shared-memory file after switching modes.
    for suffix in ('-shm', '-wal', '-journal'):
        sidecar = Path(str(destination) + suffix)
        if sidecar.exists():
            if suffix != '-shm' and sidecar.stat().st_size:
                raise ValueError('Backup has an unexpected nonempty SQLite sidecar')
            sidecar.unlink()
