import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchTerrain} from '../lib/elevation.ts';

const coord:[number,number]=[127.071,37.245];
test('terrain transport failure cannot fabricate elevations or a passable slope',async()=>{
    const original=globalThis.fetch;
    globalThis.fetch=async()=>{throw new Error('offline');};
    try {
        const result=await fetchTerrain([coord],new AbortController().signal);
        assert.deepEqual(result,{status:'unavailable',dataset:'srtm30m',resolutionMeters:30,reason:'transport'});
    } finally {globalThis.fetch=original;}
});
test('terrain missing heights remain missing and coordinates must match the requested path',async()=>{
    const original=globalThis.fetch;
    globalThis.fetch=async()=>Response.json({status:'OK',results:[{dataset:'srtm30m',elevation:null,location:{lng:coord[0],lat:coord[1]}}]});
    try {
        assert.deepEqual(await fetchTerrain([coord],new AbortController().signal),{status:'unavailable',dataset:'srtm30m',resolutionMeters:30,reason:'no-data'});
        globalThis.fetch=async()=>Response.json({status:'OK',results:[{dataset:'srtm30m',elevation:50,location:{lng:127.2,lat:37.2}}]});
        assert.deepEqual(await fetchTerrain([coord],new AbortController().signal),{status:'unavailable',dataset:'srtm30m',resolutionMeters:30,reason:'invalid-response'});
    } finally {globalThis.fetch=original;}
});
test('terrain cancellation propagates instead of returning an invented fallback',async()=>{
    const original=globalThis.fetch;
    globalThis.fetch=async()=>{throw new Error('canceled');};
    try {
        const controller=new AbortController();controller.abort();
        await assert.rejects(fetchTerrain([coord],controller.signal),{name:'AbortError'});
    } finally {globalThis.fetch=original;}
});
