"""Build-only normalized archives using Python already required by Meson.

No application dependency. Source archives remain intact, checksum-bound inputs.
Never archive build logs, environment captures, arbitrary absolute links or owners.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path
import sys
import tarfile


def create_archive(root, output, names):
    root = Path(root).resolve()
    output = Path(output)
    entries = []
    private = [str(root).encode(), str(Path.home()).encode()]
    account = os.environ.get("USER", "")
    # Generic system/CI account words are not personal identifiers. Their full
    # home and build paths remain forbidden, as do other local account names.
    if account and len(account) >= 4 and account not in {"runner", "ubuntu", "root"}:
        private.append(account.encode())
    for name in names:
        path = root / name
        if Path(name).is_absolute() or ".." in Path(name).parts:
            raise ValueError("Archive member must stay within the staged artifact")
        entries.extend([path, *sorted(path.rglob("*"))] if path.is_dir() else [path])
    included = set(entries)
    for path in entries:
        if any(value in path.relative_to(root).as_posix().encode() for value in private):
            raise ValueError("Archive member name contains a private build/account value")
        resolved = path.resolve()
        if resolved != root and root not in resolved.parents:
            raise ValueError("Archive contains an external link")
        if path.is_symlink():
            link = os.readlink(path)
            if any(value in link.encode() for value in private):
                raise ValueError("Archive link name contains a private build/account value")
            if Path(link).is_absolute() or resolved not in included:
                raise ValueError("Archive links must be relative and resolve to an included member")
        if path.is_file() and not path.is_symlink():
            content = path.read_bytes()
            if any(value in content for value in private):
                raise ValueError("Archive contains a private build/account value")
        elif not path.is_dir() and not path.is_symlink():
            raise ValueError("Unsupported archive entry")

    def neutral(info):
        info.uid = info.gid = 0
        info.uname = info.gname = "root"
        info.mtime = 0
        info.pax_headers = {}
        info.mode = 0o755 if info.isdir() or info.mode & 0o111 else 0o644
        return info

    # Exclusive creation prevents accidental replacement of an accepted artifact.
    with output.open("xb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for path in entries:
                    archive.add(path, arcname=path.relative_to(root), recursive=False, filter=neutral)
    with tarfile.open(output, "r:gz") as archive:
        members = archive.getmembers()
        for info in members:
            if info.uid or info.gid or info.mtime or info.uname != "root" or info.gname != "root":
                raise ValueError("Archive metadata normalization failed")
            if any(key in info.pax_headers for key in ["atime", "ctime"]):
                raise ValueError("Archive contains private timestamps")
    return {"entries": len(entries), "bytes": output.stat().st_size,
            "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}


if __name__ == "__main__":
    if len(sys.argv) < 4:
        raise SystemExit("usage: archive.py ROOT OUTPUT MEMBER...")
    print(json.dumps(create_archive(sys.argv[1], sys.argv[2], sys.argv[3:])))
