#!/usr/bin/env python3
"""Report pedestrian ways that a regional extract cannot index completely."""
import importlib.util
import argparse
import json
import sqlite3
from pathlib import Path

import osmium

spec = importlib.util.spec_from_file_location('prepare_osm_extract', Path(__file__).with_name('prepare-osm-extract.py'))
if spec is None or spec.loader is None:
    raise RuntimeError('Cannot load the extract indexer')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class Audit(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.missing = []

    def way(self, way):
        tags = {tag.k: tag.v for tag in way.tags}
        if tags.get('highway') not in prepare.WALKING or tags.get('area') == 'yes':
            return
        refs = list(way.nodes)
        invalid = [ref.ref for ref in refs if not ref.location.valid()]
        if len(refs) < 2 or len(refs) > 10_000 or invalid:
            coords = [[ref.location.lon, ref.location.lat] for ref in refs if ref.location.valid()]
            self.missing.append({'id': way.id, 'highway': tags.get('highway'), 'invalid_nodes': len(invalid), 'node_count': len(refs), 'known_bounds': [min(p[0] for p in coords), min(p[1] for p in coords), max(p[0] for p in coords), max(p[1] for p in coords)] if coords else None})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('database', type=Path)
    args = parser.parse_args()
    audit = Audit()
    audit.apply_file(str(args.source), locations=True, idx='flex_mem')
    with sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        row = db.execute("SELECT value FROM metadata WHERE key='missing_ways'").fetchone()
        if not row or int(row[0]) != len(audit.missing):
            raise ValueError('Index omission count does not match the source extract')
    print(json.dumps({'missing_ways': audit.missing}, ensure_ascii=False))


if __name__ == '__main__':
    main()
