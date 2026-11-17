"""Build the EDA for one date window and return every output as gzipped JSON.

Shared by the local dashboard_server.py and the Vercel function in api/, so a
window change behaves the same in both: nothing in the project folder is
rewritten, the browser just reads the datasets from the returned bundle.
"""

import contextlib
import gzip
import hashlib
import io
import json
import tempfile
import threading
from datetime import date
from pathlib import Path

import build_eda

ROOT = Path(__file__).parent
SOURCES = (build_eda.PROJECTS_FILE, build_eda.TIMESHEET_FILE, build_eda.EMPLOYEES_FILE,
           build_eda.PAYROLL_FILE, build_eda.SALARY_REVISIONS_FILE)
CACHE_DIR = Path(tempfile.gettempdir()) / "eda-window-cache"
# build_eda keeps its output folder in a module global, so builds in one process
# take turns rather than writing into each other's folders.
_LOCK = threading.Lock()


class WindowError(ValueError):
    """The requested window is malformed or outside the timesheet history."""


def data_bounds():
    """First and last timesheet dates, from the full-history manifest."""
    manifest = json.loads((ROOT / build_eda.OUT_MANIFEST).read_text(encoding="utf-8"))
    window = manifest["window"]
    return date.fromisoformat(window["data_start"]), date.fromisoformat(window["data_end"])


def parse_window(start, end):
    low, high = data_bounds()
    try:
        start_date = date.fromisoformat(start) if start else low
        end_date = date.fromisoformat(end) if end else high
    except ValueError as error:
        raise WindowError("Dates must look like 2026-04-01.") from error
    if start_date > end_date:
        raise WindowError("Start date must be on or before the end date.")
    if start_date < low or end_date > high:
        raise WindowError(f"Pick dates between {low.isoformat()} and {high.isoformat()}.")
    return start_date, end_date


def _sources_fingerprint():
    digest = hashlib.sha256()
    for name in SOURCES:
        path = ROOT / name
        if path.exists():
            stat = path.stat()
            digest.update(f"{name}:{stat.st_size}:{stat.st_mtime_ns}".encode())
    return digest.hexdigest()[:16]


def build_bundle(start, end):
    """Return (gzipped JSON bytes, window dict) for the requested window."""
    start_date, end_date = parse_window(start, end)
    key = f"{start_date.isoformat()}_{end_date.isoformat()}_{_sources_fingerprint()}"
    cached = CACHE_DIR / f"{key}.json.gz"
    if cached.exists():
        return cached.read_bytes(), {"start": start_date.isoformat(), "end": end_date.isoformat(), "cached": True}

    with _LOCK, tempfile.TemporaryDirectory(prefix="eda-") as folder:
        previous = build_eda.OUT_DIR
        build_eda.OUT_DIR = Path(folder)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                build_eda.main(["--start", start_date.isoformat(), "--end", end_date.isoformat()])
        finally:
            build_eda.OUT_DIR = previous
        files = {path.name: path.read_text(encoding="utf-8") for path in sorted(Path(folder).glob("EDA_*"))}

    payload = gzip.compress(json.dumps({"ok": True, "files": files}).encode("utf-8"), compresslevel=6)
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(payload)
    except OSError:
        pass  # A cache miss next time is fine; the response is already built.
    return payload, {"start": start_date.isoformat(), "end": end_date.isoformat(), "cached": False}
