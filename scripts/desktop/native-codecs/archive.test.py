"""Build-only artifact checks; synthetic files, no compilation or network."""
import hashlib
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from archive import create_archive


class CandidateArchiveTest(unittest.TestCase):
    def test_neutral_reproducible_archive_and_relative_internal_link(self):
        with tempfile.TemporaryDirectory(prefix="codec-archive-test-") as folder:
            root = Path(folder) / "stage"
            (root / "lib").mkdir(parents=True)
            (root / "lib" / "data").write_bytes(b"synthetic")
            (root / "lib" / "alias").symlink_to("data")
            first, second = Path(folder) / "a.tgz", Path(folder) / "b.tgz"
            a = create_archive(root, first, ["lib"])
            b = create_archive(root, second, ["lib"])
            self.assertEqual(a, b)
            self.assertEqual(hashlib.sha256(first.read_bytes()).digest(), hashlib.sha256(second.read_bytes()).digest())
            with tarfile.open(first) as archive:
                self.assertEqual(archive.getmember("lib/alias").linkname, "data")

    def test_rejects_absolute_internal_external_and_unincluded_links(self):
        for kind in ["absolute-internal", "external", "not-included"]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(prefix="codec-link-test-") as folder:
                root = Path(folder) / "stage"
                (root / "lib").mkdir(parents=True)
                (root / "data").write_bytes(b"synthetic")
                target = {"absolute-internal": str(root / "data"), "external": "../../outside", "not-included": "../data"}[kind]
                (root / "lib" / "alias").symlink_to(target)
                output = Path(folder) / "artifact.tgz"
                with self.assertRaises(ValueError):
                    create_archive(root, output, ["lib"])
                self.assertFalse(output.exists())

    def test_rejects_private_paths_in_regular_file_content(self):
        with tempfile.TemporaryDirectory(prefix="codec-private-test-") as folder:
            root = Path(folder) / "stage"
            root.mkdir()
            (root / "data").write_text(str(root.resolve()))
            with self.assertRaisesRegex(ValueError, "private"):
                create_archive(root, Path(folder) / "artifact.tgz", ["data"])

    def test_rejects_private_member_and_relative_link_names(self):
        with tempfile.TemporaryDirectory(prefix="codec-name-test-") as folder:
            root = Path(folder) / "stage"
            root.mkdir()
            (root / "private-person").write_bytes(b"synthetic")
            with patch.dict(os.environ, {"USER": "private-person"}):
                with self.assertRaisesRegex(ValueError, "member name"):
                    create_archive(root, Path(folder) / "a.tgz", ["private-person"])
            (root / "alias").symlink_to("private-person")
            with patch.dict(os.environ, {"USER": "private-person"}):
                with self.assertRaisesRegex(ValueError, "link name"):
                    create_archive(root, Path(folder) / "b.tgz", ["alias", "private-person"])


if __name__ == "__main__":
    unittest.main()
