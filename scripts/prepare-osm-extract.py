#!/usr/bin/env python3
"""Build a local, spatially indexed pedestrian extract from an OSM PBF file."""
import argparse
import datetime
import json
import os
import sqlite3
from pathlib import Path
from uuid import uuid4

import osmium

WALKING = frozenset(('footway', 'path', 'pedestrian', 'steps', 'cycleway', 'living_street', 'residential', 'service', 'unclassified', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link', 'track'))


def snapshot_time(source):
    reader = osmium.io.Reader(str(source))
    try:
        value = reader.header().get('osmosis_replication_timestamp')
    finally:
        reader.close()
    if not value:
        raise ValueError('The PBF header does not contain a replication timestamp')
    datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    return value


class Indexer(osmium.SimpleHandler):
    def __init__(self, db):
        super().__init__()
        self.db = db
        self.node_tags = {}
        self.nodes, self.ways, self.bounds = [], [], []
        self.way_count = 0
        self.missing = 0

    def node(self, node):
        tags = {tag.k: tag.v for tag in node.tags if tag.k in ('access', 'foot', 'wheelchair', 'barrier')}
        if tags:
            self.node_tags[node.id] = tags

    def way(self, way):
        tags = {tag.k: tag.v for tag in way.tags}
        if tags.get('highway') not in WALKING or tags.get('area') == 'yes':
            return
        refs = list(way.nodes)
        if len(refs) < 2 or len(refs) > 10_000 or any(not ref.location.valid() for ref in refs):
            self.missing += 1
            return
        coords = [(ref.ref, ref.location.lon, ref.location.lat) for ref in refs]
        self.nodes.extend((node_id, lon, lat, json.dumps(self.node_tags.get(node_id, {}), ensure_ascii=False)) for node_id, lon, lat in coords)
        payload = json.dumps({'type': 'way', 'id': way.id, 'nodes': [ref.ref for ref in refs], 'tags': tags}, ensure_ascii=False, separators=(',', ':'))
        self.ways.append((way.id, payload))
        self.bounds.append((way.id, min(p[1] for p in coords), max(p[1] for p in coords), min(p[2] for p in coords), max(p[2] for p in coords)))
        self.way_count += 1
        if len(self.ways) >= 4000:
            self.flush()

    def flush(self):
        self.db.executemany('INSERT OR IGNORE INTO nodes VALUES (?,?,?,?)', self.nodes)
        self.db.executemany('INSERT INTO ways VALUES (?,?)', self.ways)
        self.db.executemany('INSERT INTO way_bounds VALUES (?,?,?,?,?)', self.bounds)
        self.nodes.clear()
        self.ways.clear()
        self.bounds.clear()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    timestamp = snapshot_time(args.source)
    temporary = args.destination.with_name(args.destination.name + '.building-' + uuid4().hex)
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        db = sqlite3.connect(temporary)
        try:
            db.executescript('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE nodes(id INTEGER PRIMARY KEY,lon REAL NOT NULL,lat REAL NOT NULL,tags TEXT NOT NULL); CREATE TABLE ways(id INTEGER PRIMARY KEY,payload TEXT NOT NULL); CREATE VIRTUAL TABLE way_bounds USING rtree(id,min_lon,max_lon,min_lat,max_lat);')
            indexer = Indexer(db)
            indexer.apply_file(str(args.source), locations=True, idx='flex_mem')
            indexer.flush()
            if not indexer.way_count:
                raise ValueError('The source contains no pedestrian-network ways')
            db.executemany('INSERT INTO metadata VALUES (?,?)', [('snapshot', timestamp), ('missing_ways', str(indexer.missing)), ('ways', str(indexer.way_count))])
            db.commit()
        finally:
            db.close()
        os.replace(temporary, args.destination)
        print(json.dumps({'snapshot': timestamp, 'indexed_ways': indexer.way_count, 'ways_omitted_for_missing_geometry': indexer.missing, 'database': str(args.destination)}, ensure_ascii=False))
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


if __name__ == '__main__':
    main()
