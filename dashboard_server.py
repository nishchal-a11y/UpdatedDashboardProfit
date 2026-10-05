"""Static server for the profitability dashboard plus a source-file rebuild endpoint.

POST /api/regenerate accepts multipart uploads for any of the source files,
writes them into the project folder and re-runs build_eda.py.
"""

import json
import re
import subprocess
import sys
from email.parser import BytesParser
from email.policy import HTTP
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).parent
PORT = 8765
MAX_UPLOAD_BYTES = 200 * 1024 * 1024

# field name -> (destination filename, allowed extensions)
ALLOWED_FILES = {
    "projects": ("Projects.csv", {".csv"}),
    "timesheet": ("TimeSheet_Row_data.csv", {".csv"}),
    "employees": ("All Employees - Finanshels.com.xlsx", {".xlsx"}),
    "payroll": ("All Employees Month-on-Month YTD Report_Jan 2026 - Aug 2026 _.xlsx", {".xlsx"}),
    "revisions": ("Emp_Salary_Revisions_Finanshels.com_.xlsx", {".xlsx"}),
}
NO_STORE = {".csv", ".json", ".js", ".css", ".html"}


class UploadError(Exception):
    pass


def parse_multipart(content_type, body):
    """Minimal multipart/form-data reader.

    Built on email.parser because cgi.FieldStorage was removed in Python 3.13.
    Returns {field_name: (filename, bytes)} for parts that carry a filename.
    """
    if "multipart/form-data" not in (content_type or ""):
        raise UploadError("Expected a multipart/form-data upload.")
    headers = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
    message = BytesParser(policy=HTTP).parsebytes(headers + body)
    if not message.is_multipart():
        raise UploadError("Upload payload was not multipart.")
    files, values = {}, {}
    for part in message.iter_parts():
        disposition = part.get("Content-Disposition", "")
        name = re.search(r'name="([^"]*)"', disposition)
        if not name:
            continue
        filename = re.search(r'filename="([^"]*)"', disposition)
        payload = part.get_payload(decode=True) or b""
        if filename and filename.group(1):
            files[name.group(1)] = (filename.group(1), payload)
        else:
            values[name.group(1)] = payload.decode("utf-8", "replace").strip()
    return files, values


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if self.command == "POST" or not self.path.endswith((".css", ".js", ".ico")):
            super().log_message(fmt, *args)

    def end_headers(self):
        # The dashboard re-reads the EDA files after every rebuild.
        if Path(self.path.split("?")[0]).suffix.casefold() in NO_STORE:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/regenerate":
            self.respond(404, {"ok": False, "error": "Unknown endpoint."})
            return
        try:
            replaced, window = self.store_uploads()
            command = [sys.executable, str(ROOT / "build_eda.py")]
            if window.get("start"):
                command += ["--start", window["start"]]
            if window.get("end"):
                command += ["--end", window["end"]]
            result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=False)
            if result.returncode:
                self.respond(500, {"ok": False, "replaced": replaced, "error": (result.stderr or result.stdout or "build_eda.py failed").strip()[-1200:]})
                return
            self.respond(200, {"ok": True, "replaced": replaced, "message": result.stdout.strip()})
        except UploadError as error:
            self.respond(400, {"ok": False, "error": str(error)})
        except Exception as error:  # noqa: BLE001 - surface the failure to the browser
            self.respond(500, {"ok": False, "error": f"{type(error).__name__}: {error}"})

    def store_uploads(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise UploadError("Empty upload.")
        if length > MAX_UPLOAD_BYTES:
            raise UploadError(f"Upload is {length / 1048576:.0f} MB; the limit is {MAX_UPLOAD_BYTES // 1048576} MB.")
        files, values = parse_multipart(self.headers.get("Content-Type"), self.rfile.read(length))
        window = {key: values.get(key, "") for key in ("start", "end")}
        for key, value in window.items():
            if value and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                raise UploadError(f"Window {key} must be an ISO date, e.g. 2026-07-22.")
        if window["start"] and window["end"] and window["start"] > window["end"]:
            raise UploadError("Window start must be on or before window end.")
        # Every part is checked before anything lands on disk, so a bad file in a
        # multi-file upload cannot leave the folder half replaced.
        pending = []
        for field, (filename, payload) in files.items():
            if field not in ALLOWED_FILES:
                raise UploadError(f"Unexpected upload field '{field}'.")
            target, extensions = ALLOWED_FILES[field]
            suffix = Path(filename).suffix.casefold()
            if suffix not in extensions:
                raise UploadError(f"{filename} must be one of {', '.join(sorted(extensions))}.")
            if not payload:
                raise UploadError(f"{filename} is empty.")
            pending.append((field, target, extensions, ROOT / target, payload))

        replaced = []
        for field, target, extensions, destination, payload in pending:
            destination.write_bytes(payload)
            replaced.append(destination.name)
        return replaced, window

    def respond(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("", PORT), DashboardHandler)
    print(f"Dashboard running at http://localhost:{PORT}/index.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
