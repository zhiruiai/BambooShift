"""Run the standalone tooling suites with the same interpreter and stop on failure."""
import os
from pathlib import Path
import subprocess
import sys


def main():
    root = Path(__file__).resolve().parent.parent
    suites = sorted((root / 'tests' / 'scripts').rglob('*.test.py'))
    if not suites:
        raise SystemExit('No Python tooling tests found.')
    environment = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}
    for suite in suites:
        print(suite.relative_to(root), flush=True)
        subprocess.run([sys.executable, str(suite)], cwd=root, env=environment, check=True)


if __name__ == '__main__':
    main()
