import json
import re
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ExtractServiceTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        path = Path(self.directory.name) / 'map.sqlite'
        with sqlite3.connect(path) as db:
            db.executescript('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE nodes(id INTEGER PRIMARY KEY,lon REAL,lat REAL,tags TEXT); CREATE TABLE ways(id INTEGER PRIMARY KEY,payload TEXT); CREATE VIRTUAL TABLE way_bounds USING rtree(id,min_lon,max_lon,min_lat,max_lat);')
            db.execute('INSERT INTO metadata VALUES (?,?)', ('snapshot', '2026-01-01T00:00:00Z'))
            db.executemany('INSERT INTO nodes VALUES (?,?,?,?)', [(1, 127.0, 37.0, '{}'), (2, 127.0001, 37.0, '{"wheelchair":"no"}'), (3, 128.0, 36.0, '{}'), (4, 128.0001, 36.0, '{}')])
            ways = [(10, [1, 2], {'highway': 'footway', 'footway': 'crossing'}), (20, [3, 4], {'highway': 'footway'})]
            for way_id, nodes, tags in ways:
                db.execute('INSERT INTO ways VALUES (?,?)', (way_id, json.dumps({'type': 'way', 'id': way_id, 'nodes': nodes, 'tags': tags})))
            db.executemany('INSERT INTO way_bounds VALUES (?,?,?,?,?)', [(10, 127.0, 127.0001, 37.0, 37.0), (20, 128.0, 128.0001, 36.0, 36.0)])
        self.server = subprocess.Popen([sys.executable, str(ROOT / 'services/osm-extract/server.py'), str(path), '--port', '0'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        line = self.server.stdout.readline()
        match = re.search(r'http://127\.0\.0\.1:(\d+)', line)
        if not match:
            raise RuntimeError('Extract service did not start: ' + line)
        self.url = f'http://127.0.0.1:{match.group(1)}/api/interpreter'

    def tearDown(self):
        self.server.terminate()
        self.server.communicate(timeout=5)
        self.directory.cleanup()

    def query(self, query):
        data = urllib.parse.urlencode({'data': query}).encode()
        with urllib.request.urlopen(self.url, data=data, timeout=5) as response:
            return json.load(response)

    def test_spatial_query_returns_only_intersecting_ways_and_their_nodes(self):
        data = self.query('[out:json];(way["highway"](36.999,126.999,37.001,127.001););(._;>;);out body;')
        self.assertEqual(data['osm3s']['timestamp_osm_base'], '2026-01-01T00:00:00Z')
        ways = [item for item in data['elements'] if item['type'] == 'way']
        nodes = {item['id']: item for item in data['elements'] if item['type'] == 'node'}
        self.assertEqual([way['id'] for way in ways], [10])
        self.assertEqual(set(nodes), {1, 2})
        self.assertEqual(nodes[2]['tags']['wheelchair'], 'no')
        self.assertEqual(self.query('way["highway"](35.0,125.0,35.001,125.001);')['elements'], [])

    def test_invalid_or_unbounded_query_is_rejected(self):
        for query in ('', 'way["highway"](0,0,80,170);'):
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.query(query)
            self.assertEqual(error.exception.code, 400)


if __name__ == '__main__':
    unittest.main()
