#!/usr/bin/env python3
"""Build macOS app ZIPs from verified, prebuilt runtime distributions."""
import argparse
import hashlib
import os
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parents[1]
ELECTRON_VERSION = "45.4.1"
NODE_VERSION = "24.22.3"
CHECKSUMS = {
    "arm64": (
        "d080c3b05a01bd16137f2c12ab9ebf083c577757fe846844ba325bafa8e8bdf4",
        "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd",
    ),
    "x64": (
        "1c80d2ccf71b02c8fd9940fd09cafe88090a48c1bab0193c79b597b08d890e79",
        "977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7",
    ),
}


def run(*args, cwd=ROOT):
    subprocess.run(args, cwd=cwd, check=True)


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def download(url, expected, cache):
    target = cache / url.rsplit("/", 1)[1]
    if target.is_file() and digest(target) == expected:
        return target
    partial = target.with_suffix(target.suffix + ".download")
    try:
        run("curl", "--fail", "--location", "--silent", "--show-error", "--retry", "2", "--max-time", "300", "-o", partial, url)
        if digest(partial) != expected:
            raise RuntimeError(f"Checksum mismatch for {target.name}")
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return target


def stage_server(target):
    for name in ("package.json", "package-lock.json"):
        shutil.copy2(ROOT / name, target / name)
    for name in ("server", "web"):
        (target / name).mkdir()
        shutil.copy2(ROOT / name / "package.json", target / name / "package.json")
        shutil.copytree(ROOT / name / "dist", target / name / "dist")
    shutil.copy2(ROOT / ".env.example", target / ".env.example")
    shutil.copy2(ROOT / "THIRD_PARTY_NOTICES.md", target)
    shutil.copytree(ROOT / "desktop", target / "desktop")
    run("npm", "ci", "--workspace=server", "--include-workspace-root=false", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", cwd=target)


def app_info(contents):
    plist_path = contents / "Info.plist"
    with plist_path.open("rb") as file:
        info = plistlib.load(file)
    info.update({
        "CFBundleName": "Marion Agent",
        "CFBundleDisplayName": "Marion Agent",
        "CFBundleIdentifier": "com.henlyfilms.marion-agent",
        "CFBundleShortVersionString": "1.0.0",
        "CFBundleVersion": "1.0.0",
        "CFBundleIconFile": "MarionAgent.icns",
        "NSMicrophoneUsageDescription": "Marion Agent uses your microphone when you dictate or start a voice call.",
    })
    with plist_path.open("wb") as file:
        plistlib.dump(info, file)
    icon = (ROOT / "web" / "public" / "app-512.png").read_bytes()
    icon_chunk = b"ic09" + struct.pack(">I", len(icon) + 8) + icon
    (contents / "Resources" / "MarionAgent.icns").write_bytes(
        b"icns" + struct.pack(">I", len(icon_chunk) + 8) + icon_chunk
    )


def sign(bundle, rcodesign):
    if rcodesign:
        run(rcodesign, "sign", bundle)
    elif shutil.which("codesign"):
        # The Electron bundle includes signed frameworks. Seal the embedded runtime and the updated app.
        run("codesign", "--force", "--sign", "-", bundle / "Contents" / "Resources" / "runtime" / "node")
        run("codesign", "--force", "--deep", "--sign", "-", bundle)
        run("codesign", "--verify", "--deep", "--strict", bundle)
    else:
        raise RuntimeError("Use macOS codesign or supply --rcodesign with a trusted local signer")


def package(arch, cache, work, server, output, rcodesign):
    electron_sha, node_sha = CHECKSUMS[arch]
    electron = download(
        f"https://github.com/electron/electron/releases/download/v{ELECTRON_VERSION}/electron-v{ELECTRON_VERSION}-darwin-{arch}.zip",
        electron_sha, cache,
    )
    node = download(
        f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-darwin-{arch}.tar.gz",
        node_sha, cache,
    )
    stage = work / arch
    stage.mkdir()
    run("unzip", "-q", electron, "-d", stage)
    bundle = stage / "Marion Agent.app"
    (stage / "Electron.app").rename(bundle)
    contents = bundle / "Contents"
    resources = contents / "Resources"
    shutil.copytree(ROOT / "macos", resources / "app")
    shutil.copytree(server, resources / "marion", symlinks=True)
    prebuilds = resources / "marion" / "node_modules" / "better-sqlite3" / "prebuilds"
    assert (prebuilds / f"darwin-{arch}.node").is_file(), "SQLite package lacks the target build"
    for library in prebuilds.glob("*.node"):
        if library.name != f"darwin-{arch}.node":
            library.unlink()
    runtime = resources / "runtime"
    runtime.mkdir()
    with tarfile.open(node, "r:gz") as archive:
        prefix = f"node-v{NODE_VERSION}-darwin-{arch}"
        for source, target in (("bin/node", "node"), ("LICENSE", "LICENSE")):
            with archive.extractfile(f"{prefix}/{source}") as data, (runtime / target).open("wb") as file:
                shutil.copyfileobj(data, file)
    (runtime / "node").chmod(0o755)
    app_info(contents)
    sign(bundle, rcodesign)
    label = {"arm64": "Apple silicon", "x64": "Intel"}[arch]
    destination = output / f"Marion Agent for Mac ({label}).zip"
    temporary = output / f".marion-{arch}.zip"
    temporary.unlink(missing_ok=True)
    try:
        run("zip", "-q", "-r", "-y", temporary, bundle.name, cwd=stage)
        run("unzip", "-tq", temporary)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"{digest(destination)}  {destination}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arch", action="append", choices=CHECKSUMS, help="Architecture to package. Default is both.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--rcodesign", type=Path, help="Trusted signer for a cross-build on Linux.")
    args = parser.parse_args()
    output, cache = args.output.resolve(), args.cache.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    run("npm", "run", "build")
    with tempfile.TemporaryDirectory(prefix="Marion Packaging ") as directory:
        work = Path(directory)
        server = work / "server-payload"
        server.mkdir()
        stage_server(server)
        for arch in dict.fromkeys(args.arch or CHECKSUMS):
            package(arch, cache, work, server, output, args.rcodesign.resolve() if args.rcodesign else None)


if __name__ == "__main__":
    main()
