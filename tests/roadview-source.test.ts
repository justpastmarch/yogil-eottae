import {test} from 'node:test';
import assert from 'node:assert/strict';
import {kakaoPanoramaId,naverPanoramaPose} from '../lib/roadview-source.ts';
import {capturePreviewSchema} from '../lib/capture-contract.ts';
import {entranceEvidenceSchema} from '../lib/place-entrance.ts';
import type {EvidenceSource} from '../lib/domain.ts';

test('Kakao identity is recognized only from a genuine matching Kakao source',()=>{
 const kakao={url:'https://map.kakao.com/?panoid=1212368406',panoId:'1212368406'};
 assert.equal(kakaoPanoramaId(kakao),1212368406);
 assert.equal(kakaoPanoramaId({...kakao,url:'https://map.naver.com/?panoid=1212368406'}),null);
 assert.equal(kakaoPanoramaId({...kakao,panoId:'not-a-number'}),null);
 assert.equal(kakaoPanoramaId({...kakao,panoId:'123'}),null);
 assert.equal(kakaoPanoramaId({url:'https://map.kakao.com/?panoid=99999999999999999999',panoId:'99999999999999999999'}),null);
});

const source={
 provider:'naver',url:'https://viewer.map.naver.com/panorama?id=1wo1KkbslxgmTWAI88_T7w&heading=-166&tilt=-7&fov=60',
 panoId:'1wo1KkbslxgmTWAI88_T7w',coord:[127.0756348,37.247666],heading:194,tilt:7,fov:60,zoom:1,capturedAt:null,capturedMonth:'2026-06',distance:17,
} satisfies EvidenceSource;
test('persisted actual NAVER pose restores opaque pano ID, native pan, upward-positive tilt and actual FOV',()=>{
 assert.deepEqual(naverPanoramaPose(source),{panoId:'1wo1KkbslxgmTWAI88_T7w',pan:-166,tilt:-7,fov:60});
 const differentRequest={...source,zoom:2};
 assert.deepEqual(naverPanoramaPose(differentRequest),naverPanoramaPose(source));
});
test('native viewing requires complete matching actual metadata rather than coordinates or requested zoom',()=>{
 for(const changes of [
  {provider:undefined},{panoId:undefined},{heading:undefined},{tilt:undefined},{fov:undefined},
  {url:source.url.replace('viewer.map.naver.com','viewer.map.naver.com.attacker.test')},
  {url:source.url.replace('https://','http://')},
  {url:source.url.replace('https://','https://user:password@')},
  {url:source.url.replace('/panorama?','/map?')},
  {url:source.url.replace(source.panoId,'different-id')},
  {url:source.url.replace('&heading=-166','')},
  {url:source.url+'&heading=-166'},
  {url:source.url.replace('heading=-166','heading=')},
  {url:source.url.replace('tilt=-7','tilt=7')},
  {url:source.url.replace('fov=60','fov=90')},
  {heading:90},{tilt:-7},{fov:90},
 ]){
  assert.equal(naverPanoramaPose({...source,...changes}),null,JSON.stringify(changes));
 }
 const archived={...source,provider:undefined,url:'https://map.kakao.com/?panoid=1212368406',panoId:'1212368406'};
 assert.equal(naverPanoramaPose(archived),null);
});
test('route previews and entrance response parsing retain actual NAVER provenance without replacing archived sources',()=>{
 const preview=capturePreviewSchema.parse({id:'00000000-0000-4000-8000-000000000001',evidenceId:'route:point',viewId:'initial',url:'/api/journey-image?id=one',source,createdAt:'2026-10-29T00:00:00Z'});
 assert.deepEqual(preview.source,source);
 const {distance,...entranceSource}=source;
 void distance;
 const evidence={id:'entrance-1',image:{mime:'image/jpeg',data:'/9j/AAAA'},source:entranceSource,input:{coord:source.coord,target:source.coord,heading:194,tilt:7,zoom:2}};
 assert.deepEqual(entranceEvidenceSchema.parse(evidence).source,entranceSource);
 const archived={url:'https://map.kakao.com/?panoid=1212368406',panoId:'1212368406',capturedAt:1700000000000,coord:source.coord,heading:194,tilt:7,zoom:1};
 assert.deepEqual(entranceEvidenceSchema.parse({...evidence,source:archived}).source,archived);
 assert.equal(naverPanoramaPose(archived),null);
});
