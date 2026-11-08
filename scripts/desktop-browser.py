#!/usr/bin/env python3
"""Development entrypoint; deploy the verified single-file browser launcher."""
import os
import sys
from python_tool_build import build_tool

if __name__ == '__main__':
    artifact = build_tool('desktop-browser')
    os.execv(sys.executable, [sys.executable, str(artifact), *sys.argv[1:]])
