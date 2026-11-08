#!/usr/bin/env python3
"""Build fixed Python definition units into dependency-free deployment programs.

Assembly happens only during development/deployment. The generated program uses
ordinary definitions, not exec/import hooks, and retains the original __file__
identity for namespace re-entry and manifest/verification hashes.
"""
import argparse
import ast
import hashlib
import json
import os
import pathlib
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent
SPEC = 'python-tools.json'
LOCK = 'python-tools.lock.json'
OUTPUT = ROOT.parent / '.build' / 'python-tools'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_source(root, relative):
    parts = pathlib.PurePosixPath(relative).parts
    if not parts or any(part in ('..', '.') for part in parts):
        raise ValueError('Invalid build source path')
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('Build sources cannot be symbolic links')
    if not current.is_file() or not current.resolve().is_relative_to(root.resolve()):
        raise ValueError('Build source is outside the source root')
    return current.read_bytes()


def sources(root=ROOT):
    spec_bytes = read_source(root, SPEC)
    spec = json.loads(spec_bytes)
    if set(spec) != {'version', 'tools'} or spec['version'] != 1:
        raise ValueError('Unsupported Python tool specification')
    expected = {'desktop-control', 'desktop-session', 'desktop-browser', 'isolated-shell'}
    if set(spec['tools']) != expected:
        raise ValueError('Unexpected Python tool set')
    paths = [SPEC, 'python_tool_build.py']
    for name, units in spec['tools'].items():
        if not isinstance(units, list) or not units or len(units) != len(set(units)):
            raise ValueError('Invalid definition unit list')
        prefix = 'python_tools/' + name.replace('-', '_') + '/'
        dependencies = {'python_tools/desktop_control/protocol.py', 'python_tools/desktop_control/session.py'} if name == 'desktop-browser' else set()
        if any(not isinstance(unit, str) or (not unit.startswith(prefix) and unit not in dependencies) or not unit.endswith('.py') for unit in units):
            raise ValueError('Unexpected definition unit')
        paths.extend(units)
        paths.append(name + '.py')
    discovered = {str(path.relative_to(root)) for path in (root / 'python_tools').rglob('*.py')}
    declared = {path for units in spec['tools'].values() for path in units}
    if discovered != declared:
        raise ValueError('Definition unit manifest is incomplete')
    content = {path: read_source(root, path) for path in paths}
    for path, data in content.items():
        if path.endswith('.py') and len(data.splitlines()) > 500:
            raise ValueError('Source exceeds the 500-line limit: ' + path)
    return spec, content


def update_lock(root=ROOT):
    _, content = sources(root)
    record = {'version': 1, 'sources': {path: sha(data) for path, data in sorted(content.items())}}
    atomic_write(root / LOCK, (json.dumps(record, indent=2) + '\n').encode(), 0o644)


def verified_sources(root=ROOT):
    spec, content = sources(root)
    lock = json.loads(read_source(root, LOCK))
    expected = {path: sha(data) for path, data in sorted(content.items())}
    if lock != {'version': 1, 'sources': expected}:
        raise ValueError('Python tool source lock is stale; review changes and explicitly update the lock')
    return spec, content


def assemble(tool, root=ROOT):
    spec, content = verified_sources(root)
    if tool not in spec['tools']:
        raise ValueError('Unknown Python tool')
    # Ordered definition units preserve the established global state and signal
    # handlers. No source rewriting or runtime module loading is performed.
    program = b''.join(content[path] for path in spec['tools'][tool])
    compile(program, tool + '.py', 'exec')
    ast.parse(program)
    provenance = {
        'version': 1, 'tool': tool, 'sha256': sha(program),
        'sources': {path: sha(data) for path, data in sorted(content.items())},
    }
    return program, provenance


def atomic_write(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def build_tool(tool, output=OUTPUT, root=ROOT, verify=False):
    program, provenance = assemble(tool, root)
    artifact = pathlib.Path(output) / (tool + '.py')
    record = artifact.with_suffix('.manifest.json')
    if verify:
        if artifact.is_symlink() or record.is_symlink() or artifact.read_bytes() != program:
            raise ValueError('Deployment artifact does not match current verified sources')
        if json.loads(record.read_bytes()) != provenance:
            raise ValueError('Deployment provenance does not match current verified sources')
    else:
        atomic_write(artifact, program, 0o700)
        atomic_write(record, (json.dumps(provenance, indent=2) + '\n').encode(), 0o600)
    return artifact


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tool', nargs='?', choices=['all', 'desktop-control', 'desktop-session', 'desktop-browser', 'isolated-shell'], default='all')
    parser.add_argument('--output', type=pathlib.Path, default=OUTPUT)
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--update-lock', action='store_true')
    args = parser.parse_args()
    if args.update_lock:
        if args.verify:
            parser.error('--update-lock and --verify cannot be combined')
        update_lock()
    tools = ['desktop-control', 'desktop-session', 'desktop-browser', 'isolated-shell'] if args.tool == 'all' else [args.tool]
    for tool in tools:
        artifact = build_tool(tool, args.output, verify=args.verify)
        print(tool + ': ' + sha(artifact.read_bytes()))


if __name__ == '__main__':
    main()
