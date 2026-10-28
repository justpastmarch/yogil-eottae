import {test} from 'node:test';
import assert from 'node:assert/strict';
import {kakaoPanoramaId} from '../lib/roadview-source.ts';

test('only a matching Kakao panorama can open in the Kakao viewer',()=>{
 const kakao={url:'https://map.kakao.com/?panoid=1212368406',panoId:'1212368406'};
 assert.equal(kakaoPanoramaId(kakao),1212368406);
 assert.equal(kakaoPanoramaId({...kakao,url:'https://map.naver.com/?panoid=1212368406'}),null);
 assert.equal(kakaoPanoramaId({...kakao,panoId:'not-a-number'}),null);
 assert.equal(kakaoPanoramaId({...kakao,panoId:'123'}),null);
 assert.equal(kakaoPanoramaId({url:'https://map.kakao.com/?panoid=99999999999999999999',panoId:'99999999999999999999'}),null);
});
