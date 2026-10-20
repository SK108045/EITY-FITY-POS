#!/usr/bin/env python3
"""Build an offline-first Windows x64 portable POS with no merchant credentials."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CAP = ROOT / "capacitor"
VERSION = "v24.21.0"
CACHE = ROOT / "windows/.cache"
OUT = ROOT / "dist/windows"
STAGE = OUT / "OraforgePOS"
NODE_ARCHIVE = f"node-{VERSION}-win-x64.zip"
NODE_BASE = f"https://nodejs.org/dist/{VERSION}"
EMPTY_SOZURI = {"project": "", "apiKey": "", "from": "", "channel": "sms", "type": "transactional"}
EMPTY_NATIVE = {"swifta": "", "sozuri": EMPTY_SOZURI}


def download(name):
    dest = CACHE / name
    if not dest.exists():
        temp = dest.with_suffix(dest.suffix + ".part")
        subprocess.run(
            ["curl", "-fsSL", "--retry", "3", "--retry-all-errors", "--max-time", "900",
             f"{NODE_BASE}/{name}", "-o", str(temp)],
            check=True,
        )
        temp.replace(dest)
    return dest


def build_desktop_bridge():
    """Native providers are unused on Windows. Never embed real Android API keys."""
    config_file = CAP / "src/provider-config.json"
    original = config_file.read_bytes() if config_file.exists() else None
    esbuild = CAP / "node_modules/esbuild/bin/esbuild"
    if not esbuild.is_file():
        raise SystemExit("Missing esbuild. Run 'npm ci' in capacitor/ first.")
    try:
        config_file.write_text(json.dumps(EMPTY_NATIVE) + "\n", encoding="utf-8")
        subprocess.run(
            # On Windows npm leaves bin/esbuild as a Node script, so run it through node.
            (["node"] if os.name == "nt" else []) + [str(esbuild), "src/sqlite-bridge.js", "--bundle", "--format=iife",
             "--platform=browser", "--outfile=www/sqlite-bridge.js"],
            cwd=CAP, check=True,
        )
    finally:
        if original is None:
            config_file.unlink(missing_ok=True)
        else:
            config_file.write_bytes(original)


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    print("Downloading and verifying official Windows Node runtime...", flush=True)
    lines = download("SHASUMS256.txt").read_text(encoding="utf-8").splitlines()
    matches = [line.split()[0] for line in lines if line.split()[-1] == NODE_ARCHIVE]
    if len(matches) != 1:
        raise SystemExit(f"Node checksum not listed: {NODE_ARCHIVE}")
    expected = matches[0]
    node_zip = download(NODE_ARCHIVE)
    if hashlib.sha256(node_zip.read_bytes()).hexdigest() != expected:
        raise SystemExit("Node ZIP checksum mismatch. Delete windows/.cache and retry.")

    build_desktop_bridge()
    if STAGE.exists():
        for _ in range(5):
            try:
                shutil.rmtree(STAGE)
                break
            except Exception:
                time.sleep(0.5)
        else:
            shutil.rmtree(STAGE, ignore_errors=True)
    (STAGE / "runtime").mkdir(parents=True)
    with zipfile.ZipFile(node_zip) as z:
        if z.testzip() is not None:
            raise SystemExit("Node runtime ZIP is corrupt.")
        for name in ("node.exe", "LICENSE"):
            (STAGE / "runtime" / name).write_bytes(z.read(f"node-{VERSION}-win-x64/{name}"))

    app = STAGE / "app/capacitor"
    app.mkdir(parents=True)
    # In particular, do not ship the tracked www/paystack.txt or development credentials.
    shutil.copytree(CAP / "www", app / "www", ignore=shutil.ignore_patterns("paystack.txt", "*.map"))
    shutil.copytree(ROOT / "chrome-extension", STAGE / "chrome-extension")
    for name in ("dev-server.js", "auto-backup.js", "sms.js", "swifta.js",
                 "swifta-config.js", "swifta-contract.js", "etims-windows.js"):
        shutil.copy2(CAP / name, app / name)
    (STAGE / "app/swifta.txt").write_text("", encoding="utf-8")
    (app / "sozuri-config.json").write_text(json.dumps(EMPTY_SOZURI, indent=2) + "\n", encoding="utf-8")

    # Include default shop SQLite database in the build folder
    src_db = ROOT / "data/pos.sqlite3"
    if src_db.exists():
        (STAGE / "data").mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_db, STAGE / "data/pos.sqlite3")
        shutil.copy2(src_db, STAGE / "pos.sqlite3")
        print(f"Bundled {src_db.name} ({src_db.stat().st_size:,} bytes) into build package", flush=True)

    fingerprint = hashlib.sha256((VERSION + (ROOT / "windows/launcher_windows.go").read_text()).encode())
    for file in sorted((STAGE / "app").rglob("*")):
        if file.is_file():
            fingerprint.update(file.relative_to(STAGE).as_posix().encode())
            fingerprint.update(file.read_bytes())
    build_id = fingerprint.hexdigest()[:16]
    print("Cross-compiling Windows launcher...", flush=True)
    subprocess.run(
        ["go", "build", "-trimpath", "-ldflags", f"-s -w -H windowsgui -X main.buildID={build_id}",
         "-o", str(STAGE / "OraforgePOS.exe"), str(ROOT / "windows/launcher_windows.go")],
        env={**os.environ, "GOOS": "windows", "GOARCH": "amd64", "CGO_ENABLED": "0"},
        cwd=ROOT, check=True,
    )
    (STAGE / "Stop POS.cmd").write_bytes(b'@echo off\r\n"%~dp0OraforgePOS.exe" --stop\r\n')
    shutil.copy2(ROOT / "windows/START-HERE.txt", STAGE / "START-HERE.txt")
    (STAGE / "build-info.json").write_text(
        json.dumps({"platform": "windows-x64", "node": VERSION,
                    "node_zip_sha256": expected, "node_source": f"{NODE_BASE}/{NODE_ARCHIVE}",
                    "build": build_id, "provider_keys_included": False}, indent=2) + "\n",
        encoding="utf-8",
    )

    output = OUT / "OraforgePOS-Windows-x64.zip"
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for file in sorted(STAGE.rglob("*")):
            if file.is_file():
                z.write(file, file.relative_to(OUT))
    sha = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(".zip.sha256").write_text(f"{sha}  {output.name}\n", encoding="utf-8")
    print(f"Built {output} ({output.stat().st_size / 1024 / 1024:.1f} MiB); build {build_id}", flush=True)


if __name__ == "__main__":
    main()
