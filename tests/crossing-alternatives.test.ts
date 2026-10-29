import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossingChoices, discoverCrossingAlternatives, validateCrossingProposal } from '../lib/crossing-alternatives.ts';
import { meters, type BlockedPassage, type Coord, type Place, type Route } from '../lib/domain.ts';
import { buildPedestrianGraph, type PedestrianGraph } from '../lib/osm-graph.ts';

const snapshotAt = '2026-01-01T00:00:00Z';
const coordinates: Record<number, Coord> = {
  1: [127, 37], 2: [127.0001, 37], 3: [127.0003, 37], 4: [127.0004, 37],
  5: [127.0001, 37.0002], 6: [127.0003, 37.0002],
  7: [127.0001, 36.9998], 8: [127.0003, 36.9998],
  9: [127.0001, 37.00023], 10: [127.0003, 37.00023],
};
const start: Place = { id: 'start', name: '출발', address: '', coord: coordinates[1] };
const end: Place = { id: 'end', name: '도착', address: '', coord: coordinates[4] };

function graphWith(options: { northAccess?: Record<string, string>; south?: boolean; disconnected?: boolean; reverseOnly?: boolean; sharedRoadBypass?: boolean; parallelNorth?: boolean } = {}): PedestrianGraph {
  const ways = [
    { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'footway', footway: 'sidewalk' } },
    { type: 'way', id: 11, nodes: [3, 4], tags: { highway: 'footway', footway: 'sidewalk' } },
    { type: 'way', id: 100, nodes: [2, 3], tags: { highway: 'footway', footway: 'crossing' } },
    ...(options.sharedRoadBypass ? [{ type: 'way', id: 205, nodes: [2, 3], tags: { highway: 'residential' } }] : []),
    { type: 'way', id: 201, nodes: [2, 5], tags: { highway: 'footway', ...options.northAccess } },
    { type: 'way', id: 101, nodes: [5, 6], tags: { highway: 'footway', footway: 'crossing', ...(options.reverseOnly ? { 'oneway:foot': '-1' } : {}) } },
    ...(!options.disconnected ? [{ type: 'way', id: 202, nodes: [6, 3], tags: { highway: 'footway' } }] : []),
    ...(options.parallelNorth ? [
      { type: 'way', id: 206, nodes: [2, 9], tags: { highway: 'footway' } },
      { type: 'way', id: 103, nodes: [9, 10], tags: { highway: 'footway', footway: 'crossing' } },
      { type: 'way', id: 207, nodes: [10, 3], tags: { highway: 'footway' } },
    ] : []),
    ...(options.south ? [
      { type: 'way', id: 203, nodes: [2, 7], tags: { highway: 'footway' } },
      { type: 'way', id: 102, nodes: [7, 8], tags: { highway: 'footway', footway: 'crossing' } },
      { type: 'way', id: 204, nodes: [8, 3], tags: { highway: 'footway' } },
    ] : []),
  ];
  return buildPedestrianGraph({
    osm3s: { timestamp_osm_base: snapshotAt },
    elements: [
      ...Object.entries(coordinates).map(([id, coord]) => ({ type: 'node', id: Number(id), lon: coord[0], lat: coord[1] })),
      ...ways,
    ],
  });
}

function routeFor(nodeIds: number[], id = 'baseline'): Route {
  const coords = nodeIds.map(node => coordinates[node]);
  return {
    id, name: id, options: [], coords,
    distance: coords.slice(1).reduce((sum, coord, index) => sum + meters(coords[index], coord), 0),
    seconds: 0, samples: [], steps: [], fetchedAt: snapshotAt,
  };
}
const baseline: Route = {
  ...routeFor([1, 2, 3, 4]),
  crossingSources: [{ provider: 'openstreetmap', snapshotAt, wayIds: [100], along: meters(coordinates[1], coordinates[2]) }],
};

function excluded(coords: Coord[]): BlockedPassage {
  return { id: 'observed-obstacle', routeId: 'earlier-route', sampleId: 'observed', fromAlong: 0, toAlong: 30, coords };
}

test('a reachable alternative uses real crossing entry and exit nodes, not arbitrary lateral offsets', () => {
  const graph = graphWith();
  const proposals = discoverCrossingAlternatives(start, end, [baseline], graph);
  assert.equal(proposals.length, 1);
  const proposal = proposals[0];
  assert.deepEqual(proposal.crossingWayIds, [101]);
  assert.deepEqual(proposal.via, [coordinates[5], coordinates[6]]);
  assert.deepEqual(proposal.crossings, [{ wayId: 101, entry: coordinates[5], exit: coordinates[6] }]);
  assert.ok(proposal.distanceMeters > baseline.distance);
  assert.equal(proposal.graphSegment.startGapMeters, 0);
  assert.equal(proposal.graphSegment.endGapMeters, 0);
  assert.equal(proposal.graphSegment.snapshotAt, snapshotAt);
  assert.ok(validateCrossingProposal(routeFor([1, 2, 5, 6, 3, 4], 'north'), proposal, graph));
});

test('a shorter road bypass without crossings does not hide a connected alternative crossing', () => {
  const graph = graphWith({ sharedRoadBypass: true });
  const proposals = discoverCrossingAlternatives(start, end, [baseline], graph);
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0].crossingWayIds, [101]);
  assert.deepEqual(proposals[0].via, [coordinates[5], coordinates[6]]);
  assert.ok(proposals[0].distanceMeters > baseline.distance);
  assert.equal(proposals[0].graphSegment.sharedRoadMeters, 0);
  assert.ok(validateCrossingProposal(routeFor([1, 2, 5, 6, 3, 4]), proposals[0], graph));
});

test('forcing a dead-end crossing cannot manufacture an alternative by backtracking to a road bypass', () => {
  assert.deepEqual(discoverCrossingAlternatives(start, end, [baseline], graphWith({ sharedRoadBypass: true, disconnected: true })), []);
});

test('steps and access-blocked connections cannot be used to reach another crossing', () => {
  assert.deepEqual(discoverCrossingAlternatives(start, end, [baseline], graphWith({ northAccess: { highway: 'steps' } })), []);
  assert.deepEqual(discoverCrossingAlternatives(start, end, [baseline], graphWith({ northAccess: { wheelchair: 'no' } })), []);
});

test('an observed excluded crossing is blocked in both directions, including a reversed passage geometry', () => {
  const graph = graphWith();
  const passage = excluded([coordinates[6], coordinates[5]]);
  assert.deepEqual(discoverCrossingAlternatives(start, end, [baseline], graph, [passage]), []);
  const reversed: Route = { ...baseline, coords: [...baseline.coords].reverse(), crossingSources: undefined };
  assert.deepEqual(discoverCrossingAlternatives(end, start, [reversed], graph, [passage]), []);
});

test('a uniquely aligned observed crossing offset by four meters is excluded in both directions', () => {
  const graph = graphWith();
  const passage = excluded([[127.0003, 37.000236], [127.0001, 37.000236]]);
  assert.deepEqual(discoverCrossingAlternatives(start, end, [baseline], graph, [passage]), []);
  const reversed: Route = { ...baseline, coords: [...baseline.coords].reverse(), crossingSources: undefined };
  assert.deepEqual(discoverCrossingAlternatives(end, start, [reversed], graph, [passage]), []);
});

test('crossing offset matching does not widen exclusions onto an adjacent ordinary approach path', () => {
  const passage = excluded([[127.00013, 37], [127.00013, 37.0002]]);
  assert.deepEqual(discoverCrossingAlternatives(start, end, [baseline], graphWith(), [passage]).map(proposal => proposal.crossingWayIds), [[101]]);
});

test('an offset observation between parallel mapped crossings does not guess which crossing is blocked', () => {
  const passage = excluded([[127.0001, 37.000215], [127.0003, 37.000215]]);
  const proposals = discoverCrossingAlternatives(start, end, [baseline], graphWith({ parallelNorth: true }), [passage]);
  assert.deepEqual(proposals.map(proposal => proposal.crossingWayIds[0]).sort((a, b) => a - b), [101, 103]);
});

test('an exclusion inside a longer graph edge prevents use of that physical passage', () => {
  const passage = excluded([[127.00025, 37.0002], [127.00015, 37.0002]]);
  assert.deepEqual(discoverCrossingAlternatives(start, end, [baseline], graphWith(), [passage]), []);
});

test('an excluded origin approach cannot be bypassed by silently choosing a new graph anchor', () => {
  const passage = excluded([coordinates[2], coordinates[1]]);
  assert.deepEqual(discoverCrossingAlternatives(start, end, [baseline], graphWith(), [passage]), []);
});

test('a perpendicular exclusion touching at a point does not erase an unrelated crossing', () => {
  const passage = excluded([[127.0002, 37.00015], [127.0002, 37.00025]]);
  assert.deepEqual(discoverCrossingAlternatives(start, end, [baseline], graphWith(), [passage]).map(proposal => proposal.crossingWayIds), [[101]]);
});

test('a disconnected map never manufactures an edge between the crossing and destination sidewalk', () => {
  assert.deepEqual(discoverCrossingAlternatives(start, end, [baseline], graphWith({ disconnected: true })), []);
});

test('a crossing connected only in the wrong direction is not an alternative', () => {
  assert.deepEqual(discoverCrossingAlternatives(start, end, [baseline], graphWith({ reverseOnly: true })), []);
});

test('distinct reachable crossing choices remain bounded and never repeat the baseline wayplan', () => {
  const graph = graphWith({ south: true });
  const proposals = discoverCrossingAlternatives(start, end, [baseline], graph);
  assert.equal(proposals.length, 2);
  assert.deepEqual(proposals.map(proposal => proposal.crossingWayIds[0]).sort((a, b) => a - b), [101, 102]);
  assert.equal(new Set(proposals.map(proposal => proposal.id)).size, proposals.length);
  assert.ok(proposals.every(proposal => proposal.via.length <= 5 && !proposal.crossingWayIds.includes(100)));
});

test('a nearby but unconnected endpoint is disclosed as a graph gap rather than appended geometry', () => {
  const nearbyStart: Place = { ...start, coord: [126.99999, 37] };
  const proposals = discoverCrossingAlternatives(nearbyStart, end, [baseline], graphWith());
  assert.equal(proposals.length, 1);
  assert.ok(proposals[0].graphSegment.startGapMeters > 0);
  assert.deepEqual(proposals[0].via, [coordinates[5], coordinates[6]]);
  assert.deepEqual(discoverCrossingAlternatives({ ...start, coord: [126.99, 37] }, end, [baseline], graphWith()), []);
});

test('an already offered crossing plan is not rediscovered under a different route id', () => {
  const north = {
    ...routeFor([1, 2, 5, 6, 3, 4], 'north'),
    crossingSources: [{ provider: 'openstreetmap' as const, snapshotAt, wayIds: [101], along: meters(coordinates[1], coordinates[2]) + meters(coordinates[2], coordinates[5]) }],
  };
  assert.deepEqual(discoverCrossingAlternatives(start, end, [baseline, north], graphWith()), []);
});

test('crossings can be derived from real baseline geometry when crossing source metadata is absent', () => {
  const proposals = discoverCrossingAlternatives(start, end, [routeFor([1, 2, 3, 4])], graphWith());
  assert.deepEqual(proposals.map(proposal => proposal.crossingWayIds), [[101]]);
});

test('provider validation rejects nearby, wrong-way, and baseline crossing routes', () => {
  const graph = graphWith(), proposal = discoverCrossingAlternatives(start, end, [baseline], graph)[0];
  assert.equal(validateCrossingProposal(baseline, proposal, graph), false);
  assert.equal(validateCrossingProposal(routeFor([4, 3, 6, 5, 2, 1]), proposal, graph), false);
  const nearby = routeFor([1, 2, 9, 10, 3, 4]);
  assert.equal(validateCrossingProposal(nearby, proposal, graphWith({parallelNorth:true})), false);
});

test('unique mapped crossings tolerate bounded provider centerline offsets but not a different corridor',()=>{
  const graph=graphWith(),proposal=discoverCrossingAlternatives(start,end,[baseline],graph)[0];
  const aligned=routeFor([1,2,5,6,3,4]);
  aligned.coords=aligned.coords.map(coord=>[coord[0],coord[1]+.00002]);
  assert.equal(validateCrossingProposal(aligned,proposal,graph),true);
  const far=routeFor([1,2,5,6,3,4]);
  far.coords=far.coords.map(coord=>[coord[0],coord[1]+.00012]);
  assert.equal(validateCrossingProposal(far,proposal,graph),false);
});

test('crossing choices expose a position on the provider route without inventing a side offset', () => {
  const choices = crossingChoices(baseline);
  assert.equal(choices.length, 1);
  assert.deepEqual(choices[0].wayIds, [100]);
  assert.ok(meters(choices[0].coord, coordinates[2]) < 0.001);
  assert.equal(choices[0].along, baseline.crossingSources?.[0].along);
  assert.deepEqual(crossingChoices(routeFor([1, 2, 3, 4])), []);
});

test('a perpendicular midpoint intersection is not a traversal of a ten metre crossing',()=>{
  const entry:Coord=[127,37],exit:Coord=[127.0001125,37];
  const graph=buildPedestrianGraph({osm3s:{timestamp_osm_base:snapshotAt},elements:[
    {type:'node',id:1,lon:entry[0],lat:entry[1]},
    {type:'node',id:2,lon:exit[0],lat:exit[1]},
    {type:'node',id:3,lon:127.00005625,lat:36.999955},
    {type:'node',id:4,lon:127.00005625,lat:37.000045},
    {type:'way',id:10,nodes:[1,2],tags:{highway:'footway',footway:'crossing'}},
    {type:'way',id:11,nodes:[3,4],tags:{highway:'footway',footway:'crossing'}},
  ]});
  const proposal={id:'ten-metres',label:'다른 횡단보도',via:[entry,exit],crossingWayIds:[10],distanceMeters:meters(entry,exit),crossings:[{wayId:10,entry,exit}],graphSegment:{provider:'openstreetmap' as const,snapshotAt,startGapMeters:0,endGapMeters:0,sharedRoadMeters:0}};
  const perpendicular={...baseline,coords:[[127.00005,36.9998],[127.0000625,37.0002]] as Coord[]};
  assert.equal(validateCrossingProposal(perpendicular,proposal,graph),false);
  const offset={...baseline,coords:[[126.9999,37.00002],[127.0002125,37.00002]] as Coord[]};
  assert.equal(validateCrossingProposal(offset,proposal,graph),true);
});

test('a selected crossing can be traversed in its permitted direction despite the opposite restriction',()=>{
  const original=graphWith(),proposal=discoverCrossingAlternatives(start,end,[baseline],original)[0];
  const graph:PedestrianGraph={...original,edges:original.edges.map(edge=>edge.wayId===101&&edge.from.startsWith('5@')?{...edge,access:'blocked'}:edge)};
  assert.equal(validateCrossingProposal(routeFor([1,2,5,6,3,4]),proposal,graph),false);
  const reverse={...proposal,via:[coordinates[6],coordinates[5]],crossings:[{wayId:101,entry:coordinates[6],exit:coordinates[5]}]};
  assert.equal(validateCrossingProposal(routeFor([4,3,6,5,2,1]),reverse,graph),true);
});
