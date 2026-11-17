"""Vercel function: GET /api/window?start=YYYY-MM-DD&end=YYYY-MM-DD

Rebuilds the EDA for the requested window inside the function (the deployed
filesystem is read-only, so outputs go to a temp folder) and returns every
dataset as gzipped JSON. The source files ship with this function only; they
are not part of the static site.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import window_bundle  # noqa: E402  (needs the project root on sys.path)


class handler(BaseHTTPRequestHandler):  # noqa: N801 - Vercel looks for this name
    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        try:
            payload, window = window_bundle.build_bundle(query.get("start", [""])[0], query.get("end", [""])[0])
        except window_bundle.WindowError as error:
            self._json(400, {"ok": False, "error": str(error)})
            return
        except Exception as error:  # noqa: BLE001 - surface the failure to the browser
            self._json(500, {"ok": False, "error": f"{type(error).__name__}: {error}"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(payload)))
        # Salary data: never let a shared cache keep it. Repeat windows are
        # served from the function's own /tmp cache instead.
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-EDA-Cache", "hit" if window["cached"] else "miss")
        self.end_headers()
        self.wfile.write(payload)

    def _json(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)
