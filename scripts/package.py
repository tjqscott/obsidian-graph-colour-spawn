#!/usr/bin/env python3
"""Package only the declared plugin files, with reproducible ZIP metadata."""

import argparse
import json
from pathlib import Path
import re
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
INSTALL_FILES = ("main.js", "manifest.json", "LICENSE")
SOURCE_FILES = (
    *INSTALL_FILES,
    "README.md",
    "package.json",
    "versions.json",
    ".gitignore",
    ".editorconfig",
    ".github/workflows/check.yml",
    "tests/test-layout.js",
    "tests/test-session-linked-colours.js",
    "scripts/package.py",
)


def archive(destination, prefix, names):
    with ZipFile(destination, "w", compression=ZIP_DEFLATED) as output:
        for name in sorted(names):
            source = ROOT / name
            if source.is_symlink() or not source.is_file():
                raise ValueError(f"Expected a regular source file: {name}")
            entry = ZipInfo(f"{prefix}/{name}", date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            output.writestr(entry, source.read_bytes())
    with ZipFile(destination) as output:
        if output.testzip() is not None:
            raise ValueError(f"Archive verification failed: {destination}")
        for name in names:
            if output.read(f"{prefix}/{name}") != (ROOT / name).read_bytes():
                raise ValueError(f"Packaged content differs from source: {name}")
    print(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "manifest.json").read_text())
    package = json.loads((ROOT / "package.json").read_text())
    versions = json.loads((ROOT / "versions.json").read_text())
    plugin_id, version = manifest["id"], manifest["version"]
    if not re.fullmatch(r"[a-z0-9-]+", plugin_id):
        raise ValueError("Plugin ID must be a simple directory name")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Version must use major.minor.patch")
    if package["version"] != version:
        raise ValueError("package.json and manifest.json versions differ")
    if versions.get(version) != manifest["minAppVersion"]:
        raise ValueError("versions.json must match the current manifest")
    args.out.mkdir(parents=True, exist_ok=True)
    archive(args.out / f"{plugin_id}-{version}.zip", plugin_id, INSTALL_FILES)
    archive(
        args.out / f"obsidian-{plugin_id}-{version}-source.zip",
        f"obsidian-{plugin_id}",
        SOURCE_FILES,
    )


if __name__ == "__main__":
    main()
