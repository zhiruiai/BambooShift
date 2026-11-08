#!/usr/bin/env python3
"""Local source entrypoint; deploy only the verified single-file build artifact."""
import os
import sys
from python_tool_build import build_tool

if __name__ == '__main__':
    artifact = build_tool('desktop-control')
    os.execv(sys.executable, [sys.executable, str(artifact), *sys.argv[1:]])
