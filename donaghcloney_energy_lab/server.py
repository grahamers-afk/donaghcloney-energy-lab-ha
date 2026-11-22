#!/usr/bin/env python3
"""Ingress-only simulator and private replay storage."""
import html
import json
import math
import os
import re
import tempfile
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

APP_DIR = Path(__file__).resolve().parent
ROOT = APP_DIR / 'dist'
if not ROOT.is_dir():
    ROOT = APP_DIR / 'app/dist'
DATA = Path('/data')
INGRESS_PROXY_IP = '172.30.32.2'
MAX_REPLAY_BYTES = 8 * 1024 * 1024
FIVE_POINT_LENGTH = 25
FIVE_SOURCES = {'audit', 'ha-history'}


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and abs(value) <= 1e9


def optional_number(value):
    return value is None or number(value)


def day_value(value):
    return isinstance(value, str) and bool(re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value)) and bool(date.fromisoformat(value))


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(
        r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|\+00:00)', value
    ):
        return False
    datetime.fromisoformat(value.replace('Z', '+00:00'))
    return True


def hourly_row(row):
    if not isinstance(row, dict):
        return False
    rooms = row.get('rooms')
    return (
        timestamp(row.get('z')) and day_value(row.get('day'))
        and row['z'][:10] == row['day'] and number(row.get('hr'))
        and row['hr'] == int(row['z'][11:13])
        and isinstance(rooms, list) and len(rooms) == 4
        and number(rooms[0]) and all(optional_number(value) for value in rooms)
        and all(optional_number(value) for key, value in row.items()
                if key not in {'z', 'day', 'rooms'})
    )


def five_point(row):
    if isinstance(row, list):
        return (
            len(row) == FIVE_POINT_LENGTH and timestamp(row[0])
            and isinstance(row[1], str) and row[1] in FIVE_SOURCES
            and all(optional_number(value) for value in row[2:])
        )
    return (
        isinstance(row, dict) and timestamp(row.get('t'))
        and isinstance(row.get('source'), str) and row['source'] in FIVE_SOURCES
        and all(optional_number(value) for key, value in row.items() if key not in {'t', 'source'})
    )


def validated_replay(raw):
    bundle = json.loads(raw)
    if not isinstance(bundle, dict):
        raise ValueError('Replay must be a JSON object')
    historic, recent, points, fit = (bundle.get(key) for key in ('historicHours', 'recentHours', 'fiveMinute', 'fit'))
    if not isinstance(historic, list) or not isinstance(recent, list) or not historic or not recent:
        raise ValueError('Replay requires historic and recent hourly rows')
    if len(historic) + len(recent) > 2500 or not all(hourly_row(row) for row in historic + recent):
        raise ValueError('Invalid hourly replay rows')
    if not isinstance(points, list) or not points or len(points) > 12000 or not all(five_point(row) for row in points):
        raise ValueError('Invalid five-minute replay rows')
    params = fit.get('params') if isinstance(fit, dict) else None
    if not isinstance(params, list) or len(params) != 4 or not all(
        isinstance(row, list) and len(row) == 7 and all(number(value) for value in row) for row in params
    ):
        raise ValueError('Replay requires four seven-coefficient room fits')
    # Retain only the model inputs used by the app. Free-text provenance stays in the user's original export.
    return json.dumps(
        {'historicHours': historic, 'recentHours': recent, 'fiveMinute': points, 'fit': {'params': params}},
        separators=(',', ':'), allow_nan=False,
    ).encode()


def save_replay(body):
    # Write and replace on the same filesystem so readers always see a complete bundle.
    with tempfile.NamedTemporaryFile(dir=DATA, prefix='.replay-', delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(body)
            file.flush()
            os.fsync(file.fileno())
            file.close()
            temporary.replace(DATA / 'replay-bundle.json')
        finally:
            temporary.unlink(missing_ok=True)


class Handler(BaseHTTPRequestHandler):
    server_version = 'DonaghcloneyEnergyLab/0.3.0'

    def _headers(self, status, content_type):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'")
        self.send_header('Cache-Control', 'no-store' if urlsplit(self.path).path.startswith('/api/') else 'no-cache')

    def _body(self, body, status=200, content_type='application/json; charset=utf-8'):
        self._headers(status, content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload, status=200):
        self._body(json.dumps(payload).encode(), status)

    def _ingress_only(self):
        if self.client_address[0] != INGRESS_PROXY_IP:
            self._json({'error': 'Ingress proxy only'}, 403)
            return False
        return True

    def do_GET(self):
        if not self._ingress_only():
            return
        path = urlsplit(self.path).path
        if path != '/api/replay':
            self._static(path)
            return
        try:
            body = (DATA / 'replay-bundle.json').read_bytes()
        except FileNotFoundError:
            self._json({'error': 'Import a private replay bundle to begin'}, 404)
        except OSError:
            self._json({'error': 'Private replay storage could not be read'}, 500)
        else:
            self._body(body)

    def do_POST(self):
        if not self._ingress_only():
            return
        if urlsplit(self.path).path != '/api/replay':
            self._json({'error': 'Not found'}, 404)
            return
        if self.headers.get('X-Energy-Lab-Import') != '1' or self.headers.get_content_type() != 'application/json':
            self._json({'error': 'Use the app’s replay import form'}, 415)
            return
        lengths = self.headers.get_all('Content-Length', [])
        if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,10}', lengths[0]):
            self._json({'error': 'A bounded upload length is required'}, 411)
            return
        length = int(lengths[0])
        if not 0 < length <= MAX_REPLAY_BYTES:
            self._json({'error': 'The replay file must be between 1 byte and 8 MiB'}, 413)
            return
        try:
            self.connection.settimeout(30)
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('Incomplete upload')
            body = validated_replay(raw)
        except (ValueError, OverflowError, RecursionError, TimeoutError):
            self._json({'error': 'Invalid replay bundle. Select the original replay-bundle.json export.'}, 400)
            return
        try:
            save_replay(body)
        except OSError:
            self._json({'error': 'Private replay could not be saved'}, 500)
        else:
            self._body(body, 201)

    def _static(self, path):
        assets = {
            '/': ('index.html', 'text/html'),
            '/index.html': ('index.html', 'text/html'),
            '/style.css': ('style.css', 'text/css'),
            '/app.mjs': ('app.mjs', 'text/javascript'),
            '/model.mjs': ('model.mjs', 'text/javascript'),
            '/heating.mjs': ('heating.mjs', 'text/javascript'),
        }
        if path not in assets:
            self._json({'error': 'Not found'}, 404)
            return
        filename, content_type = assets[path]
        body = (ROOT / filename).read_bytes()
        if filename == 'index.html':
            ingress_path = self.headers.get('X-Ingress-Path', '/')
            if not re.fullmatch(r'/api/hassio_ingress/[A-Za-z0-9_-]+/?', ingress_path):
                ingress_path = '/'
            base = html.escape(ingress_path.rstrip('/') + '/', quote=True)
            body = body.replace(b'<head>', f'<head><base href="{base}">'.encode(), 1)
        self._body(body, content_type=f'{content_type}; charset=utf-8')

    def _method_not_allowed(self):
        if self._ingress_only():
            self._json({'error': 'Method not allowed'}, 405)

    do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _method_not_allowed

    def log_message(self, fmt, *args):
        # Request paths and headers can contain private Ingress identifiers.
        pass

def main():
    if not ROOT.is_dir():
        raise SystemExit('Required simulator directory is missing')
    DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('0.0.0.0', 8099), Handler)
    print('Energy Lab Ingress server listening on port 8099', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
