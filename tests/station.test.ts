import test from 'node:test';
import assert from 'node:assert/strict';
import {stationFacilityInfo} from '../lib/station.ts';
import type {Place} from '../lib/domain.ts';

const place:Place={id:'1',name:'답십리역',address:'서울 동대문구 답십리동',coord:[127.05,37.56]};

test('station links point to the local operator without claiming a station result',()=>{
 const seoul=stationFacilityInfo(place);
 assert.equal(seoul?.operator,'서울교통공사');
 assert.equal(seoul?.url,'https://seoulmetro.co.kr/kr/equipmentList.do?menuIdx=367');
 const busan=stationFacilityInfo({...place,name:'부산역',address:'부산 동구 중앙대로 206'});
 assert.equal(busan?.operator,'부산교통공사');
 assert.equal(busan?.url,'https://www.humetro.busan.kr/homepage/default/subwayElevator/list.do?menu_no=1001010710');
 const other=stationFacilityInfo({...place,name:'수원역',address:'경기 수원시 팔달구'});
 assert.equal(other?.url,undefined);
 assert.equal(other?.operator,undefined);
});

test('ordinary destinations are not presented as stations',()=>{
 assert.equal(stationFacilityInfo({...place,name:'역삼동 주민센터'}),null);
 assert.equal(stationFacilityInfo({...place,name:'경희대학교'}),null);
});
