import importlib.util
import json
import os
import stat
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    'app_server', Path(__file__).resolve().parents[1] / 'donaghcloney_energy_lab/server.py'
)
app = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(app)
IMPORT_HEADERS = {'Content-Type': 'application/json', 'X-Energy-Lab-Import': '1'}


def sample_bundle():
    def hour(day):
        return {'day': day, 'z': day + 'T00:00:00Z', 'hr': 0, 'rooms': [20]*4}
    return {
        'historicHours': [hour('2000-01-01')],
        'recentHours': [hour('2000-01-02')],
        'fiveMinute': [{'t': '2000-01-02T00:00:00Z', 'source': 'ha-history', 'room': 20}],
        'fit': {'params': [[0]*7 for _ in range(4)]},
    }


class ServerTest(unittest.TestCase):
    def setUp(self):
        data = tempfile.TemporaryDirectory()
        self.addCleanup(data.cleanup)
        self.addCleanup(patch.stopall)
        patch.object(app, 'DATA', Path(data.name)).start()
        patch.object(app, 'INGRESS_PROXY_IP', '127.0.0.1').start()
        self.start_server()
        self.addCleanup(self.stop_server)

    def start_server(self):
        self.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method, path, body=None, headers=None):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def test_clean_start_and_ingress_assets(self):
        status, headers, page = self.request('GET', '/', headers={'X-Ingress-Path': '/api/hassio_ingress/test_123'})
        self.assertEqual(status, 200)
        self.assertIn(b'<base href="/api/hassio_ingress/test_123/">', page)
        self.assertIn('frame-ancestors', headers['Content-Security-Policy'])
        self.assertEqual(self.request('GET', '/app.mjs')[0], 200)
        self.assertEqual(self.request('GET', '/api/replay')[0], 404)
        self.assertEqual(self.request('GET', '/api/ha/states')[0], 404)
        self.assertEqual(self.request('GET', '/../../server.py')[0], 404)

    def test_peer_and_import_policy(self):
        with patch.object(app, 'INGRESS_PROXY_IP', '172.30.32.2'):
            self.assertEqual(self.request('GET', '/')[0], 403)
            self.assertEqual(self.request('POST', '/api/replay', b'{}', IMPORT_HEADERS)[0], 403)
        self.assertEqual(self.request('POST', '/api/replay', b'{}')[0], 415)
        self.assertEqual(self.request('DELETE', '/api/replay')[0], 405)
        self.assertEqual(self.request('POST', '/api/replay', headers={
            **IMPORT_HEADERS, 'Content-Length': str(app.MAX_REPLAY_BYTES + 1),
        })[0], 413)

    def test_import_survives_restart_and_rejects_bad_replacement(self):
        bundle = sample_bundle()
        raw = json.dumps({**bundle, 'source': 'synthetic provenance'}).encode()
        status, headers, body = self.request('POST', '/api/replay', raw, IMPORT_HEADERS)
        self.assertEqual(status, 201)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(json.loads(body), bundle)
        self.assertEqual(stat.S_IMODE((app.DATA / 'replay-bundle.json').stat().st_mode), 0o600)
        bad = json.dumps({**bundle, 'fit': {'params': []}})
        self.assertEqual(self.request('POST', '/api/replay', bad, IMPORT_HEADERS)[0], 400)
        self.stop_server()
        self.start_server()
        self.assertEqual(self.request('GET', '/api/replay')[2], body)
        bundle['recentHours'][0]['rooms'][0] = 21
        self.assertEqual(self.request('POST', '/api/replay', json.dumps(bundle), IMPORT_HEADERS)[0], 201)
        self.assertEqual(json.loads(self.request('GET', '/api/replay')[2]), bundle)

    @unittest.skipUnless(os.environ.get('ENERGY_LAB_PRIVATE_REPLAY'), 'private file supplied separately')
    def test_recovered_bundle_upload(self):
        raw = Path(os.environ['ENERGY_LAB_PRIVATE_REPLAY']).read_bytes()
        status, _, body = self.request('POST', '/api/replay', raw, IMPORT_HEADERS)
        self.assertEqual(status, 201)
        self.assertEqual(self.request('GET', '/api/replay')[2], body)
