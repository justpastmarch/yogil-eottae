import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzePlaceEntrance,decidePlaceEntrance,entranceResponseSchema,entranceReviewSchema,entranceViewReviewSchema,type EntranceReview,type EntranceResponse} from '../lib/place-entrance.ts';
import type {Place} from '../lib/domain.ts';
import {entranceObservationSummary} from '../lib/entrance-observation.ts';
import type {ServerConfig} from '../lib/server-config.ts';

const place:Place={id:'cafe-fixture',name:'오늘 카페 수원점',address:'테스트 주소',coord:[127.04,37.26]};
function view(changes:Partial<EntranceReview['views'][number]>={}):EntranceReview['views'][number]{
    const id=changes.id??'photo-1';
    return entranceReviewSchema.shape.views.element.parse({id,linkage:{kind:'anchor',anchorId:id,reason:'브랜드 간판과 같은 점포 외관입니다.'},visibleName:place.name,matchesTarget:true,nameMatch:'exact',identityReason:'간판과 해당 출입문이 이어집니다.',branchMatch:'unknown',visibleBranch:'',visibleAddress:'',entranceVisible:true,samePassage:true,connection:'flat',continuousConnection:true,bypass:'none-observed',bypassSamePassage:false,entirePassageVisible:true,reason:'선택한 점포 간판 아래 문과 보도의 연결이 보입니다.',nextAction:'출입문 하단과 보도가 함께 보이도록 왼쪽에서 촬영해 주세요.',...changes});
}
function review(views:EntranceReview['views'],status:EntranceReview['targetRecognition']['status']='recognized'):EntranceReview {
    return {targetRecognition:{status,anchorViewIds:status==='recognized'?views.filter(view=>view.linkage.kind==='anchor').map(view=>view.id):[],brandEvidence:status==='recognized'?'간판 또는 브랜드 로고가 선택한 장소의 브랜드에 대응합니다.':'',spatialReason:status==='recognized'?'실제 촬영 방향이 선택한 건물 외관을 향하며 간판과 문이 같은 외관에 있습니다.':'',reason:status==='recognized'?'선택한 장소를 확인했습니다.':'선택한 점포의 외관으로 확인하지 못했습니다.'},views};
}
type CaptureInput={coord:[number,number];heading:number;target:[number,number];tilt:number;zoom:number;maxDistance:number};
function naverSource(input:CaptureInput):EntranceResponse['evidence'][number]['source']{
    const pan=((input.heading+180)%360+360)%360-180,fov=[90,60,40][input.zoom];
    return {provider:'naver',url:`https://viewer.map.naver.com/panorama?id=fixture&heading=${pan}&tilt=${-input.tilt}&fov=${fov}`,capturedAt:null,panoId:'fixture',coord:input.coord,heading:input.heading,tilt:input.tilt,zoom:input.zoom,fov};
}

test('brand or logo plus real spatial correspondence recognizes a branch without printed branch or address',()=>{
    const target={...place,name:'맥도날드 경희대국제캠퍼스점'};
    const observation=view({visibleName:'',nameMatch:'unreadable',branchMatch:'unknown'});
    const input=review([observation]);
    input.targetRecognition.brandEvidence='노란 M 브랜드 로고가 선택한 맥도날드의 로고에 대응합니다.';
    assert.equal(decidePlaceEntrance(target,input).verdict,'flat');
});
test('different store or explicitly different branch cannot clear the selected entrance',()=>{
    for(const changes of [{nameMatch:'different'},{branchMatch:'different'}] satisfies Partial<EntranceReview['views'][number]>[]){
        const decision=decidePlaceEntrance(place,review([view({...changes,linkage:{kind:'different',anchorId:'',reason:'다른 점포 외관입니다.'}})],'different'));
        assert.equal(decision.verdict,'unknown');
        assert.equal(decision.uncertainty,'identity');
    }
});
test('coordinates without visible brand or logo correspondence do not establish identity',()=>{
    assert.equal(decidePlaceEntrance(place,review([view({visibleName:'',linkage:{kind:'unresolved',anchorId:'',reason:'간판이나 기준 외관을 확인할 수 없습니다.'}})],'unresolved')).uncertainty,'identity');
});
test('a signless low view can use the accepted anchor only through the same facade',()=>{
    const anchor=view({id:'sign',entranceVisible:false,samePassage:false,connection:'unobservable',continuousConnection:false,entirePassageVisible:false});
    const floor=view({id:'floor',visibleName:'',nameMatch:'unreadable',linkage:{kind:'same-facade',anchorId:'sign',reason:'같은 유리문과 외벽 기둥이 기준 사진에서 이어집니다.'}});
    assert.equal(decidePlaceEntrance(place,review([anchor,floor])).verdict,'flat');
    assert.equal(decidePlaceEntrance(place,review([anchor,{...floor,linkage:{kind:'unresolved',anchorId:'',reason:'다른 문인지 확인할 수 없습니다.'}}])).verdict,'unknown');
});
test('a target sign without visible complete entrance connection cannot clear',()=>{
    assert.equal(decidePlaceEntrance(place,review([view({entranceVisible:false})])).verdict,'unknown');
    assert.equal(decidePlaceEntrance(place,review([view({continuousConnection:false})])).verdict,'unknown');
});
test('directly observed flat and same-passage ramp connections retain their results',()=>{
    assert.equal(decidePlaceEntrance(place,review([view()])).verdict,'flat');
    assert.equal(decidePlaceEntrance(place,review([view({connection:'stairs',bypass:'ramp',bypassSamePassage:true})])).verdict,'ramp');
});
test('an unlinked neighboring ramp cannot erase the selected entrance stairs',()=>{
    const neighbor=view({id:'neighbor',connection:'ramp',linkage:{kind:'different',anchorId:'',reason:'이웃 점포 문입니다.'}});
    assert.equal(decidePlaceEntrance(place,review([view({connection:'stairs',continuousConnection:false}),neighbor])).verdict,'raised');
});
test('a second flat view cannot erase stairs without a same-passage bypass',()=>{
    assert.equal(decidePlaceEntrance(place,review([view({connection:'stairs',continuousConnection:false}),view({id:'flat-view'})])).verdict,'unknown');
});
test('observed approach stairs with a hidden door stay recognized and connection unknown',()=>{
    const reason='접근 계단은 보이지만 주차 차량이 문 아래 연결부를 가립니다.';
    const result=decidePlaceEntrance(place,review([view({connection:'stairs',continuousConnection:false,bypass:'unobservable',entirePassageVisible:false,reason})]));
    assert.equal(result.verdict,'unknown');
    assert.equal(result.uncertainty,'connection');
    assert.equal(result.reason,reason);
});
test('a raised threshold requires a fully visible same passage with no observed bypass',()=>{
    assert.equal(decidePlaceEntrance(place,review([view({connection:'raised',continuousConnection:false})])).verdict,'raised');
    assert.equal(decidePlaceEntrance(place,review([view({connection:'raised',continuousConnection:false,entirePassageVisible:false})])).verdict,'unknown');
});

test('independent entrance analysis retains real capture inputs and rejects the wrong target through four views',async t=>{
    const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererUrl:'https://renderer.example/capture',rendererToken:'test'};
    const captures:CaptureInput[]=[];
    let jointReviews=0;
    t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
        const body=JSON.parse(String(init?.body));
        if(String(input)===config.rendererUrl){
            captures.push(body);
            return Response.json({image:{mime:'image/jpeg',data:btoa(String.fromCharCode(255,216,255,captures.length,0,0))},source:{...naverSource(body),capturedAt:1700000000000}});
        }
        jointReviews++;
        assert.equal(body.generationConfig.responseSchema.type,'OBJECT');
        assert.deepEqual(body.generationConfig.responseSchema.required,['targetRecognition','views']);
        assert.equal(body.generationConfig.responseSchema.properties.views.items.properties.continuousConnection.type,'BOOLEAN');
        const ids=body.contents[0].parts.filter((part:{text?:string})=>part.text?.startsWith('사진 ID: ')).map((part:{text:string})=>part.text.slice('사진 ID: '.length));
        return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(review(ids.map((id:string)=>view({id,visibleName:'옆집 카페',nameMatch:'different',linkage:{kind:'different',anchorId:'',reason:'이웃 점포입니다.'}})),'different'))}]}}]});
    });
    const result=entranceResponseSchema.parse(await analyzePlaceEntrance(place,config,new AbortController().signal));
    assert.equal(result.verdict,'unknown');
    assert.equal(captures.length,4);
    assert.equal(jointReviews,2);
    assert.equal(result.evidence.length,4);
    assert.equal(new Set(result.evidence.map(photo=>photo.id)).size,4);
    for(const photo of result.evidence){
        assert.deepEqual(photo.input.target,place.coord);
        assert.equal(photo.source.capturedAt,1700000000000);
        assert.equal(photo.source.provider,'naver');
        assert.equal(photo.source.fov,[90,60,40][photo.input.zoom]);
        assert.ok(captures.every(capture=>capture.maxDistance===60));
        assert.ok(captures.some(capture=>JSON.stringify(capture.coord)===JSON.stringify(photo.input.coord)&&capture.heading===photo.input.heading&&capture.tilt===photo.input.tilt&&capture.zoom===photo.input.zoom));
    }
});

test('an unavailable analysis service retains captured original evidence without clearing an entrance',async t=>{
    const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererUrl:'https://renderer.example/capture',rendererToken:'test'};
    const image={mime:'image/jpeg',data:'/9j/AAAA'};
    t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
        if(String(input)!==config.rendererUrl)return new Response('',{status:503});
        const body=JSON.parse(String(init?.body));
        return Response.json({image,source:naverSource(body)});
    });
    const result=await analyzePlaceEntrance(place,config,new AbortController().signal);
    assert.equal(result.verdict,'unknown');
    assert.equal(result.uncertainty,'technical');
    assert.match(result.reason,/HTTP 503/);
    assert.doesNotMatch(result.reason,/사진 근거가 부족|가림|근처 점포/);
    assert.equal(result.evidence.length,1);
    assert.deepEqual(result.evidence[0].image,image);
    assert.equal(result.evidence[0].source.capturedAt,null);
    assert.ok(result.limitations.some(limitation=>limitation.includes('HTTP 503')));
});

test('a malformed later joint review retains earlier occlusion observations and all captured views',async t=>{
    const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererUrl:'https://renderer.example/capture',rendererToken:'test'};
    let captures=0,reviews=0;
    const reason='간판은 보이지만 주차 차량이 출입문 하단과 보도 연결부를 가립니다.';
    t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
        const body=JSON.parse(String(init?.body));
        if(String(input)===config.rendererUrl){
            captures++;
            return Response.json({image:{mime:'image/jpeg',data:btoa(String.fromCharCode(255,216,255,captures,0,0))},source:naverSource(body)});
        }
        reviews++;
        const ids=body.contents[0].parts.filter((part:{text?:string})=>part.text?.startsWith('사진 ID: ')).map((part:{text:string})=>part.text.slice('사진 ID: '.length));
        const text=reviews===1?JSON.stringify(review(ids.map((id:string)=>view({id,reason,connection:'stairs',continuousConnection:false,entirePassageVisible:false,bypass:'unobservable'})))):'{\"views\": [';
        return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]});
    });
    const result=await analyzePlaceEntrance(place,config,new AbortController().signal);
    assert.equal(result.verdict,'unknown');
    assert.equal(result.reason,reason);
    assert.equal(result.uncertainty,'connection');
    assert.equal(result.targetRecognition?.status,'recognized');
    assert.ok(result.observations?.some(observation=>observation.targetLinked&&observation.connection==='stairs'));
    assert.equal(result.evidence.length,4);
    assert.equal(result.evidence.filter(photo=>photo.identity?.reason===reason).length,2);
    assert.ok(result.limitations.some(message=>message.includes('JSON 문법')));
});

test('joint review reports the failed field instead of conflating malformed data with occlusion',async t=>{
    const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererUrl:'https://renderer.example/capture',rendererToken:'test'};
    t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
        const body=JSON.parse(String(init?.body));
        if(String(input)===config.rendererUrl)return Response.json({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:naverSource(body)});
        const invalid={...view({id:'entrance-1'}),connection:'unknown'};
        return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({...review([view({id:'entrance-1'})]),views:[invalid]})}]}}]});
    });
    const result=await analyzePlaceEntrance(place,config,new AbortController().signal);
    assert.equal(result.verdict,'unknown');
    assert.ok(result.limitations.some(message=>message.includes('views.0.connection')));
});

test('a top-level model array is reported as a root protocol error, not silently accepted as storefront evidence',async t=>{
    const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererUrl:'https://renderer.example/capture',rendererToken:'test'};
    t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
        const body=JSON.parse(String(init?.body));
        if(String(input)===config.rendererUrl)return Response.json({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:naverSource(body)});
        return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify([view({id:'entrance-1'})])}]}}]});
    });
    const result=await analyzePlaceEntrance(place,config,new AbortController().signal);
    assert.equal(result.verdict,'unknown');
    assert.equal(result.evidence[0].identity,undefined);
    assert.ok(result.limitations.some(message=>message.includes('응답 루트')));
});

test('entrance authentication failure explains the service problem and does not retry or invent physical evidence',async t=>{
 const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererUrl:'https://renderer.example/capture',rendererToken:'test'};
 let reviews=0;
 t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
  if(String(input)!==config.rendererUrl){reviews++;return new Response('private provider payload',{status:401});}
  const body=JSON.parse(String(init?.body));
  return Response.json({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:naverSource(body)});
 });
 const result=await analyzePlaceEntrance(place,config,new AbortController().signal);
 assert.equal(reviews,1);
 assert.equal(result.verdict,'unknown');
 assert.equal(result.uncertainty,'technical');
 assert.match(result.reason,/키|권한/);
 assert.match(result.reason,/HTTP 401/);
 assert.ok(result.evidence.length>0);
 assert.ok(result.evidence.every(photo=>!photo.identity));
 assert.doesNotMatch(JSON.stringify(result),/private provider payload/);
});

const serviceConfig:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererUrl:'https://renderer.example/capture',rendererToken:'test'};
function fakeSession(t:import('node:test').TestContext,reply:(ids:string[],round:number,prompt:string)=>unknown,duplicate=false){
    const captures:CaptureInput[]=[];
    let rounds=0;
    t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
        const body=JSON.parse(String(init?.body));
        if(String(input)===serviceConfig.rendererUrl){
            captures.push(body);
            return Response.json({image:{mime:'image/jpeg',data:btoa(String.fromCharCode(255,216,255,duplicate?1:captures.length,0,0))},source:naverSource(body)});
        }
        const ids=body.contents[0].parts.filter((part:{text?:string})=>part.text?.startsWith('사진 ID: ')).map((part:{text:string})=>part.text.slice('사진 ID: '.length));
        return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(reply(ids,++rounds,body.contents[0].parts[0].text))}]}}]});
    });
    return captures;
}

test('accepted anchors and original photographs accompany a second low-angle review',async t=>{
    const captures=fakeSession(t,(ids,round,prompt)=>{
        const anchor=ids[0];
        if(round===2){
            assert.match(prompt,/이전 완료 관찰:.*"status":"recognized"/);
            assert.match(prompt,/새 낮은 바닥 사진에서 로고·지점명·주소를 다시 읽을 필요가 없다/);
            return review(ids.map(id=>view({id,visibleName:id===anchor?place.name:'',nameMatch:id===anchor?'exact':'unreadable',linkage:{kind:id===anchor?'anchor':'same-facade',anchorId:anchor,reason:'기준 사진의 같은 유리문과 외벽 모서리가 이어집니다.'}})));
        }
        return review(ids.map(id=>view({id,connection:'unobservable',continuousConnection:false,entirePassageVisible:false})));
    });
    const result=await analyzePlaceEntrance(place,serviceConfig,new AbortController().signal);
    assert.equal(result.verdict,'flat');
    assert.equal(result.targetRecognition?.status,'recognized');
    assert.equal(captures.length,4);
    assert.ok(captures.slice(2).every(input=>input.tilt===18));
    assert.ok(result.evidence.some(photo=>photo.identity?.linkage?.kind==='same-facade'&&photo.identity.visibleName===''));
});

test('a later unresolved review preserves accepted recognition and earlier physical observations',async t=>{
    fakeSession(t,(ids,round)=>review(ids.map(id=>view({id,connection:round===1?'stairs':'unobservable',continuousConnection:false,entirePassageVisible:false,bypass:'unobservable',...(round===2?{linkage:{kind:'unresolved',anchorId:'',reason:'새 사진에서는 기준 외관 대응이 불분명합니다.'}}:{})})),round===1?'recognized':'unresolved'));
    const result=await analyzePlaceEntrance(place,serviceConfig,new AbortController().signal);
    assert.equal(result.verdict,'unknown');
    assert.equal(result.uncertainty,'connection');
    assert.equal(result.targetRecognition?.status,'recognized');
    assert.equal(result.observations?.filter(observation=>observation.targetLinked&&observation.connection==='stairs').length,2);
});

test('an explicit different-store review can revoke earlier recognition',async t=>{
    fakeSession(t,(ids,round)=>review(ids.map(id=>view({id,connection:'unobservable',continuousConnection:false,entirePassageVisible:false,...(round===2?{nameMatch:'different',linkage:{kind:'different',anchorId:'',reason:'다른 브랜드 문임을 확인했습니다.'}}:{})})),round===1?'recognized':'different'));
    const result=await analyzePlaceEntrance(place,serviceConfig,new AbortController().signal);
    assert.equal(result.targetRecognition?.status,'different');
    assert.equal(result.verdict,'unknown');
    assert.equal(result.uncertainty,'identity');
    assert.ok(result.observations?.every(observation=>!observation.targetLinked));
});

test('an unresolved later review cannot restore explicitly contradicted anchors',async t=>{
    fakeSession(t,(ids,round)=>review(ids.map(id=>view({id,connection:'unobservable',continuousConnection:false,entirePassageVisible:false,...(round===2?{nameMatch:'different',linkage:{kind:'different',anchorId:'',reason:'기준 사진은 다른 브랜드 외관입니다.'}}:{})})),round===1?'recognized':'unresolved'));
    const result=await analyzePlaceEntrance(place,serviceConfig,new AbortController().signal);
    assert.equal(result.targetRecognition?.status,'unresolved');
    assert.equal(result.uncertainty,'identity');
    assert.ok(result.observations?.every(observation=>!observation.targetLinked));
});

test('same facade stairs retain their observation without claiming the selected doorway passage',async t=>{
    fakeSession(t,ids=>review(ids.map(id=>view({id,connection:'stairs',samePassage:false,entranceVisible:false,continuousConnection:false,entirePassageVisible:false}))));
    const result=await analyzePlaceEntrance(place,serviceConfig,new AbortController().signal);
    assert.equal(result.verdict,'unknown');
    assert.equal(result.targetRecognition?.status,'recognized');
    assert.ok(result.observations?.every(observation=>observation.targetLinked&&!observation.samePassage&&observation.connection==='stairs'));
});

test('recognition persistence does not restore a contradicted same-facade passage',async t=>{
    fakeSession(t,(ids,round)=>review(ids.map((id,index)=>view({id,connection:index===1?'stairs':'unobservable',continuousConnection:false,entirePassageVisible:false,...(round===1?{linkage:{kind:index===0?'anchor':'same-facade',anchorId:ids[0],reason:'동일 외관으로 관찰했습니다.'}}:{linkage:{kind:index===1?'different':'unresolved',anchorId:'',reason:index===1?'바닥 사진은 옆집 문입니다.':'간판이 가려졌습니다.'}})})),round===1?'recognized':'unresolved'));
    const result=await analyzePlaceEntrance(place,serviceConfig,new AbortController().signal);
    assert.equal(result.targetRecognition?.status,'recognized');
    assert.equal(result.verdict,'unknown');
    const floor=result.observations?.find(observation=>observation.viewId==='entrance-2');
    assert.equal(floor?.connection,'stairs');
    assert.equal(floor?.targetLinked,false);
    assert.equal(result.evidence[1].identity?.linkage?.kind,'different');
});

test('nonexistent anchor IDs and invented same-facade references are rejected at the service boundary',async t=>{
    for(const corrupt of ['anchor','reference','duplicate-id','brand','spatial']){
        fakeSession(t,ids=>{
            const result=review(ids.map(id=>view({id})));
            if(corrupt==='anchor')result.targetRecognition.anchorViewIds=['missing-photo'];
            if(corrupt==='reference')result.views[0].linkage={kind:'same-facade',anchorId:'missing-photo',reason:'참조가 잘못되었습니다.'};
            if(corrupt==='duplicate-id')result.views[1].id=result.views[0].id;
            if(corrupt==='brand')result.targetRecognition.brandEvidence='';
            if(corrupt==='spatial')result.targetRecognition.spatialReason='';
            return result;
        });
        const result=await analyzePlaceEntrance(place,serviceConfig,new AbortController().signal);
        assert.equal(result.verdict,'unknown',corrupt);
        assert.equal(result.uncertainty,'technical',corrupt);
        assert.ok(result.evidence.every(photo=>!photo.identity),corrupt);
        t.mock.restoreAll();
    }
});

test('duplicate source pictures consume the four-request budget without inventing extra views',async t=>{
    const captures=fakeSession(t,ids=>review(ids.map(id=>view({id,connection:'unobservable',continuousConnection:false,entirePassageVisible:false}))),true);
    const result=await analyzePlaceEntrance(place,serviceConfig,new AbortController().signal);
    assert.equal(captures.length,4);
    assert.equal(result.evidence.length,1);
    assert.equal(result.verdict,'unknown');
});

test('canceling capture aborts the analysis without buying a model review',async t=>{
    const controller=new AbortController();
    let reviews=0,captures=0;
    t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
        if(String(input)!==serviceConfig.rendererUrl){reviews++;throw new Error('Model must not run after cancellation');}
        captures++;
        controller.abort();
        const body=JSON.parse(String(init?.body));
        return Response.json({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:naverSource(body)});
    });
    await assert.rejects(analyzePlaceEntrance(place,serviceConfig,controller.signal),{name:'AbortError'});
    assert.equal(reviews,0);
    assert.ok(captures<=2);
});

test('legacy genuine archived response fields remain readable without new recognition metadata',()=>{
    const legacy={place,verdict:'unknown',uncertainty:'identity',reason:'이전 관찰',nextAction:'사진 확인',checkedAt:'2026-10-29T08:17:00.000Z',model:'legacy',limitations:[],evidence:[{id:'legacy-photo',image:{mime:'image/jpeg',data:'/9j/AAAA'},input:{coord:place.coord,target:place.coord,heading:0,tilt:0,zoom:1},source:naverSource({coord:place.coord,target:place.coord,heading:0,tilt:0,zoom:1,maxDistance:60}),identity:entranceViewReviewSchema.parse({...view({id:'legacy-photo'}),linkage:undefined})}]};
    assert.equal(entranceResponseSchema.parse(legacy).evidence[0].identity?.linkage,undefined);
});

function physicalResult(views:EntranceReview['views']):EntranceResponse{
    const input=review(views,'unresolved');
    return {place,...decidePlaceEntrance(place,input),checkedAt:'2026-10-30T00:00:00Z',model:'fixture',targetRecognition:input.targetRecognition,limitations:[],evidence:views.map(identity=>({id:identity.id,identity,image:{mime:'image/jpeg',data:'/9j/AAAA'},input:{coord:place.coord,target:place.coord,heading:0,tilt:12,zoom:1},source:naverSource({coord:place.coord,target:place.coord,heading:0,tilt:12,zoom:1,maxDistance:60})}))};
}
const unnamed={visibleName:'',nameMatch:'unreadable',matchesTarget:false,entranceVisible:false,samePassage:false,continuousConnection:false,entirePassageVisible:false,linkage:{kind:'unresolved',anchorId:'',reason:'명칭을 판독할 수 없습니다.'}} satisfies Partial<EntranceReview['views'][number]>;
test('an unnamed identity-unresolved building still reports a physically observed ramp',()=>{
    const result=physicalResult([view({...unnamed,connection:'ramp',bypass:'unobservable',reason:'선택 좌표 쪽 건물 앞에 난간이 있는 경사로가 보입니다.'})]);
    const before=structuredClone(result),summary=entranceObservationSummary(result);
    assert.equal(summary.title,'진입 가능 · 경사로 있음');
    assert.match(summary.reason,/난간이 있는 경사로/);
    assert.doesNotMatch(summary.title+summary.reason+summary.action,/장소인지 미확인|간판|명칭|선택한 장소 확인/);
    assert.equal(result.verdict,'unknown');
    assert.deepEqual(result,before);
});
test('stairs with a visible side ramp report the ramp without requiring identity or same-door correspondence',()=>{
    const result=physicalResult([view({...unnamed,connection:'stairs',bypass:'ramp',bypassSamePassage:false,reason:'전면 계단 왼쪽에 난간을 갖춘 경사로가 출입문 높이의 데크로 이어집니다.'})]);
    const summary=entranceObservationSummary(result);
    assert.equal(summary.title,'진입 가능 · 경사로 있음');
    assert.match(summary.reason,/전면 계단 왼쪽/);
    assert.equal(result.verdict,'unknown');
    assert.equal(result.uncertainty,'identity');
});
test('occluded ground does not become a missing-ramp or flat observation',()=>{
    const result=physicalResult([view({...unnamed,connection:'unobservable',bypass:'unobservable',reason:'촬영 당시 차량이 건물 쪽 바닥을 가립니다.'})]);
    const summary=entranceObservationSummary(result);
    assert.equal(summary.title,'진입에 유의 · 사진 확인 어려움');
    assert.match(summary.reason,/차량.*가립/);
    assert.doesNotMatch(summary.title,/미관찰|경사로 관찰|평탄/);
});
test('visible steps without an observed ramp describe only the photographed area',()=>{
    const result=physicalResult([view({...unnamed,connection:'stairs',bypass:'none-observed',reason:'사진에 건물 앞 계단이 보입니다.'})]);
    const summary=entranceObservationSummary(result);
    assert.equal(summary.title,'진입에 유의 · 계단·턱 있음');
    assert.match(summary.reason,/계단이 보입니다/);
    assert.doesNotMatch(summary.reason,/경사로가 없|다른 입구가 없/);
    assert.equal(result.verdict,'unknown');
});
test('a physically flat approach can be shown without claiming a verified doorway connection',()=>{
    const result=physicalResult([view({...unnamed,connection:'flat',bypass:'unobservable',reason:'건물 앞에 평탄한 포장 접근로가 보입니다.'})]);
    assert.equal(entranceObservationSummary(result).title,'진입 가능 · 평탄한 접근로');
    assert.equal(result.verdict,'unknown');
});
test('an explicit different facade cannot contribute its ramp to the selected-location summary',()=>{
    const other=view({...unnamed,id:'other',connection:'ramp',linkage:{kind:'different',anchorId:'',reason:'명확히 다른 건물 외관입니다.'}});
    const hidden=view({...unnamed,id:'target',connection:'unobservable',bypass:'unobservable',reason:'선택 위치 쪽 접근로가 차량에 가려져 있습니다.'});
    const result=physicalResult([other,hidden]);
    assert.equal(entranceObservationSummary(result).title,'진입에 유의 · 사진 확인 어려움');
    assert.equal(entranceObservationSummary(physicalResult([other])).title,'진입에 유의 · 사진 근거 부족');
});
test('physical metadata must refer to an actual evidence photograph',()=>{
    const result=physicalResult([view({...unnamed,connection:'unobservable',bypass:'unobservable'})]);
    result.observations=[{viewId:'invented-photo',targetLinked:false,samePassage:false,connection:'ramp',reason:'존재하지 않는 사진'}];
    assert.equal(entranceObservationSummary(result).title,'진입에 유의 · 사진 확인 어려움');
});
test('technical failures retain their retryable service explanation without inventing physical observations',()=>{
    const result={...physicalResult([]),uncertainty:'technical'} satisfies EntranceResponse;
    assert.equal(entranceObservationSummary(result).title,'입구 사진 연결 실패');
    assert.match(entranceObservationSummary(result).action,/다시 확인/);
});


test('a different tenant name or branch does not suppress a physical ramp on an unresolved facade',()=>{
    const result=physicalResult([view({...unnamed,nameMatch:'different',branchMatch:'different',visibleName:'다른 입주 점포',connection:'ramp',bypass:'unobservable',reason:'선택 위치 쪽 건물 앞에 난간이 있는 경사로가 보입니다.'})]);
    assert.equal(entranceObservationSummary(result).title,'진입 가능 · 경사로 있음');
    assert.equal(result.verdict,'unknown');
    assert.equal(result.uncertainty,'identity');
});
