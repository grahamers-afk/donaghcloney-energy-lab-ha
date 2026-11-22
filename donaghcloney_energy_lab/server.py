#!/usr/bin/env python3
"""Ingress-only simulator and private replay storage."""
import html
import json
import math
import os
import re
import tempfile
import threading
import time
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
SYNC_INTERVAL_SECONDS = 6 * 60 * 60
SYNC_LOCK = threading.Lock()


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
    if len(historic) + len(recent) > 10000 or not all(hourly_row(row) for row in historic + recent):
        raise ValueError('Invalid hourly replay rows')
    if not isinstance(points, list) or not points or len(points) > 20000 or not all(five_point(row) for row in points):
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


def save_sync_status(status):
    status_path = DATA / 'import-status.json'
    DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=DATA, prefix='.sync-', mode='w', encoding='utf-8', delete=False) as file:
        temporary = Path(file.name)
        try:
            json.dump(status, file, separators=(',', ':'), allow_nan=False)
            file.flush()
            os.fsync(file.fileno())
            file.close()
            temporary.replace(status_path)
        finally:
            temporary.unlink(missing_ok=True)


def load_sync_status():
    try:
        return json.loads((DATA / 'import-status.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {'ok': False, 'last_success': None, 'status': 'not yet synced'}


def sync_home_assistant():
    if not SYNC_LOCK.acquire(blocking=False):
        return {'ok': False, 'error': 'A Home Assistant history sync is already running.'}
    try:
        previous = load_sync_status()
        started = datetime.now().astimezone().isoformat()
        from ha_sync import sync_once
        result = sync_once()
        result['started_at'] = started
        result['status'] = 'connected' if result.get('ok') else 'error'
        result['last_attempt'] = datetime.now().astimezone().isoformat()
        if not result.get('ok'):
            result = {**previous, **result}
        save_sync_status(result)
        return result
    except Exception as error:
        result = {'ok': False, 'status': 'error', 'error': str(error)[:400],
                  'last_attempt': datetime.now().astimezone().isoformat(),
                  'last_success': load_sync_status().get('last_success')}
        save_sync_status(result)
        return result
    finally:
        SYNC_LOCK.release()


class Handler(BaseHTTPRequestHandler):
    server_version = 'DonaghcloneyEnergyLab/0.3.1'

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
        request_url = urlsplit(self.path)
        path = request_url.path
        if path == '/api/sync-status':
            self._json(load_sync_status())
            return
        if path != '/api/replay':
            self._static(path)
            return
        try:
            try:
                replay_name = 'recorder-replay.json' if request_url.query == 'source=recorder' else 'replay-bundle.json'
                body = (DATA / replay_name).read_bytes()
            except FileNotFoundError:
                if replay_name == 'recorder-replay.json':
                    raise
                body = (DATA / 'recorder-replay.json').read_bytes()
        except FileNotFoundError:
            self._json({'error': 'Import a private replay bundle to begin'}, 404)
        except OSError:
            self._json({'error': 'Private replay storage could not be read'}, 500)
        else:
            self._body(body)

    def do_POST(self):
        if not self._ingress_only():
            return
        path = urlsplit(self.path).path
        if path == '/api/sync':
            if self.headers.get('X-Energy-Lab-Sync') != '1' or self.headers.get_content_type() != 'application/json':
                self._json({'error': 'Use the Energy Lab history sync control.'}, 415)
                return
            length_header = self.headers.get('Content-Length', '0')
            if not re.fullmatch(r'[0-9]{1,5}', length_header) or int(length_header) > 1024:
                self._json({'error': 'Sync request is too large.'}, 413)
                return
            if int(length_header):
                self.rfile.read(int(length_header))
            result = sync_home_assistant()
            self._json(result, 200 if result.get('ok') else 502)
            return
        if path != '/api/replay':
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
    def scheduled_sync():
        time.sleep(10)
        while True:
            options = {}
            try:
                from ha_sync import _read_options
                options = _read_options()
            except Exception:
                pass
            if options.get('bridge_url') and options.get('bridge_secret'):
                sync_home_assistant()
            time.sleep(SYNC_INTERVAL_SECONDS)
    threading.Thread(target=scheduled_sync, name='energy-lab-history-sync', daemon=True).start()
    print('Energy Lab Ingress server listening on port 8099', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
