import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendedRoute, samplesFor, inspectionOrder, type Route, type Evidence } from '../lib/domain.ts';
import { requestSchema } from '../lib/requests.ts';
import { serverConfig, runWithServerEnv } from '../lib/server-config.ts';
const place = { id: 'a', name: 'a', address: 'a', coord: [127, 37] };
const route: Route = { id: 'r', name: 'r', options: [], coords: [[127, 37], [127, 37.01]], distance: 1100, seconds: 600, steps: [], samples: samplesFor([[127, 37], [127, 37.01]]), fetchedAt: '' };
test('one clear observation cannot recommend an otherwise uninspected journey', () => {
    const evidence: Evidence = { sampleId: 's0', status: 'clear', reason: 'clear', checkedAt: '' };
    assert.equal(recommendedRoute([route], { 'r:s0': evidence }), null);
});
test('bounded inspection finishes a candidate instead of leaving every candidate incomplete', () => {
    const samples=samplesFor([[127,37],[127,37.004]]);
    const candidates=['a','b','c'].map(id=>({...route,id,samples}));
    const evidence:Record<string,Evidence>={};
    for(const {route:candidate,sample} of inspectionOrder(candidates).slice(0,24)){
        evidence[candidate.id+':'+sample.id]={sampleId:sample.id,status:'clear',reason:'observed',checkedAt:''};
    }
    assert.equal(recommendedRoute(candidates,evidence),'a');
    assert.ok(inspectionOrder([{...route,samples:samplesFor([[127,37],[127,37.012]])}]).length<120);
});
test('recommendation requires completion and rejects any blocked or unknown sample', () => {
    const evidence: Record<string, Evidence> = Object.fromEntries(route.samples.map(sample => ['r:' + sample.id, { sampleId: sample.id, status: 'clear', reason: 'observed', checkedAt: '' }]));
    assert.equal(recommendedRoute([route], evidence), 'r');
    evidence['r:s0'].status = 'blocked';
    assert.equal(recommendedRoute([route], evidence), null);
    evidence['r:s0'].status = 'unknown';
    assert.equal(recommendedRoute([route], evidence), null);
});
test('consumer requests reject keys, arbitrary models and manual analysis actions', () => {
    const valid = { action: 'journey', start: place, end: place, profile: '수동 휠체어' };
    assert.equal(requestSchema.safeParse(valid).success, true);
    for (const field of ['keys', 'model', 'provider', 'budget', 'apiKey'])
        assert.equal(requestSchema.safeParse({ ...valid, [field]: 'secret' }).success, false);
    assert.equal(requestSchema.safeParse({ action: 'inspect', sample: {} }).success, false);
    assert.equal(requestSchema.safeParse({ action: 'search', query: '경희대', keys: {} }).success, false);
});
test('request scoped secrets stay isolated and missing imagery cannot produce an analysis source', async () => {
    const config = { TMAP_API_KEY: 'tmap', CHATKHU_API_KEY: 'private', MAPILLARY_TOKEN: 'imagery' };
    assert.throws(() => runWithServerEnv({}, serverConfig));
    assert.equal(runWithServerEnv({ TMAP_API_KEY: 'a', CHATKHU_API_KEY: 'b' }, serverConfig).mapillary, '');
    await Promise.all(['one', 'two'].map(key => runWithServerEnv({ ...config, CHATKHU_API_KEY: key }, async () => { await Promise.resolve(); assert.equal(serverConfig().ai, key); })));
});

test('Kakao routing is selected only at configuration time and public map config excludes private keys', async () => {
    const {routingConfig,publicMapConfig}=await import('../lib/server-config.ts');
    runWithServerEnv({KAKAO_REST_API_KEY:'private-rest',KAKAO_JAVASCRIPT_KEY:'a'.repeat(32),CHATKHU_API_KEY:'private-ai',TMAP_API_KEY:'other'},()=>{
        assert.deepEqual(routingConfig(),{kind:'kakao',restKey:'private-rest'});
        assert.deepEqual(publicMapConfig(),{javascriptKey:'a'.repeat(32)});
    });
    assert.deepEqual(runWithServerEnv({TMAP_API_KEY:'fallback'},routingConfig),{kind:'tmap',apiKey:'fallback'});
});
