#!/usr/bin/env python3
"""Verify portable Windows distribution integrity and credential hygiene."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "dist/windows/OraforgePOS-Windows-x64.zip"
STAGE = ROOT / "dist/windows/OraforgePOS"
NEEDED = [
    "OraforgePOS.exe", "pos.sqlite3", "Stop POS.cmd", "runtime/node.exe",
    "app/capacitor/dev-server.js", "app/capacitor/www/sqlite-bridge.js",
    "app/capacitor/www/index.html", "app/capacitor/www/admin.html",
    "app/capacitor/sozuri-config.json", "app/swifta.txt", "build-info.json",
]


def verify():
    with zipfile.ZipFile(ARCHIVE) as z:
        assert z.testzip() is None, "Archive integrity check failed"
        names = set(z.namelist())
        for name in NEEDED:
            assert "OraforgePOS/" + name in names, f"Missing {name}"
        assert not any(name.endswith("/paystack.txt") for name in names), "Payment key file bundled"
        assert z.read("OraforgePOS/app/swifta.txt").strip() == b"", "Swifta key bundled"
        sms = json.loads(z.read("OraforgePOS/app/capacitor/sozuri-config.json"))
        assert not sms.get("apiKey"), "Sozuri key bundled"
        assert not sms.get("project"), "SMS provider configuration bundled"
        bundled_bridge = z.read("OraforgePOS/app/capacitor/www/sqlite-bridge.js")
        assert len(bundled_bridge) > 1000, "Browser bridge is empty"
        info = json.loads(z.read("OraforgePOS/build-info.json"))
        assert info["platform"] == "windows-x64" and info["provider_keys_included"] is False
        assert z.read("OraforgePOS/OraforgePOS.exe")[:2] == b"MZ", "Launcher not Windows PE"
        assert z.read("OraforgePOS/runtime/node.exe")[:2] == b"MZ", "Runtime not Windows PE"
        assert (STAGE / "build-info.json").is_file(), "Extracted stage missing"
        expected = ARCHIVE.with_suffix(".zip.sha256").read_text().split()[0]
        actual = hashlib.sha256(ARCHIVE.read_bytes()).hexdigest()
        assert expected == actual, "Archive SHA256 mismatch"
    print("PASS: Windows PE binaries, archive integrity, runtime manifest, no bundled merchant keys")


if __name__ == "__main__":
    try:
        verify()
    except (AssertionError, OSError, ValueError, zipfile.BadZipFile) as exc:
        sys.exit(f"Package verification failed: {exc}")
