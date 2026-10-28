#!/usr/bin/env python3
"""Serve route-bounded OSM pedestrian data from a prepared local extract."""
import argparse
import json
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

BOX = re.compile(r'\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\);')
MAX_REQUEST = 100_000
MAX_ELEMENTS = 200_000
MAX_RESPONSE = 8 * 1024 * 1024


class ExtractServer(ThreadingHTTPServer):
    def __init__(self, address, database):
        super().__init__(address, Handler)
        self.database = Path(database).resolve()
        with sqlite3.connect(self.database.as_uri() + '?mode=ro', uri=True) as db:
            row = db.execute("SELECT value FROM metadata WHERE key='snapshot'").fetchone()
            if not row:
                raise ValueError('Extract snapshot timestamp missing')
            self.snapshot = row[0]


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body, content_type='text/plain; charset=utf-8'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != '/api/interpreter':
            self.reply(404, b'not found')
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > MAX_REQUEST:
                raise ValueError('invalid request size')
            values = parse_qs(self.rfile.read(length).decode('utf-8'), strict_parsing=True)
            query = values.get('data', [''])[0]
            boxes = [tuple(map(float, item)) for item in BOX.findall(query)]
            if not boxes or len(boxes) > 128:
                raise ValueError('invalid request bounds')
            if any(south > north or west > east or not (-90 <= south <= north <= 90 and -180 <= west <= east <= 180) or north - south > 0.1 or east - west > 0.1 for south, west, north, east in boxes):
                raise ValueError('invalid request bounds')
            with sqlite3.connect(self.server.database.as_uri() + '?mode=ro', uri=True) as db:
                ways = {}
                for south, west, north, east in boxes:
                    cursor = db.execute('SELECT w.id,w.payload FROM way_bounds b JOIN ways w ON w.id=b.id WHERE b.min_lon<=? AND b.max_lon>=? AND b.min_lat<=? AND b.max_lat>=?', (east, west, north, south))
                    for way_id, payload in cursor:
                        if way_id not in ways:
                            ways[way_id] = json.loads(payload)
                        if len(ways) > MAX_ELEMENTS:
                            self.reply(413, b'result too large')
                            return
                ids = sorted({node for way in ways.values() for node in way['nodes']})
                if len(ids) + len(ways) > MAX_ELEMENTS:
                    self.reply(413, b'result too large')
                    return
                nodes = []
                for index in range(0, len(ids), 500):
                    chunk = ids[index:index + 500]
                    marks = ','.join('?' for _ in chunk)
                    for node_id, lon, lat, tags in db.execute(f'SELECT id,lon,lat,tags FROM nodes WHERE id IN ({marks})', chunk):
                        node = {'type': 'node', 'id': node_id, 'lon': lon, 'lat': lat}
                        if tags != '{}':
                            node['tags'] = json.loads(tags)
                        nodes.append(node)
                if len(nodes) != len(ids):
                    raise ValueError('extract is missing referenced nodes')
                body = json.dumps({'version': 0.6, 'generator': 'Gileum local pedestrian extract', 'osm3s': {'timestamp_osm_base': self.server.snapshot, 'copyright': '© OpenStreetMap contributors, ODbL'}, 'elements': [*nodes, *ways.values()]}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                if len(body) > MAX_RESPONSE:
                    self.reply(413, b'result too large')
                    return
                self.reply(200, body, 'application/json; charset=utf-8')
        except (ValueError, UnicodeDecodeError):
            self.reply(400, b'invalid or incomplete request')
        except sqlite3.Error:
            self.reply(503, b'extract unavailable')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('database', type=Path)
    parser.add_argument('--port', type=int, default=8789)
    args = parser.parse_args()
    if not args.database.is_file():
        parser.error('prepared extract does not exist')
    server = ExtractServer(('127.0.0.1', args.port), args.database)
    print(f'OSM extract ready on http://127.0.0.1:{server.server_address[1]}, snapshot {server.snapshot}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
