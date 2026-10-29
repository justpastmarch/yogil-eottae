import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzePlaceEntrance,decidePlaceEntrance,entranceResponseSchema,entranceViewReviewSchema,type EntranceReview} from '../lib/place-entrance.ts';
import type {Place} from '../lib/domain.ts';
import type {ServerConfig} from '../lib/server-config.ts';

const place:Place={id:'cafe-fixture',name:'오늘 카페 수원점',address:'테스트 주소',coord:[127.04,37.26]};
function view(changes:Partial<EntranceReview['views'][number]>={}){
    return entranceViewReviewSchema.parse({id:'photo-1',visibleName:place.name,matchesTarget:true,nameMatch:'exact',identityReason:'오늘 카페 수원점 간판과 해당 출입문이 이어집니다.',branchMatch:'matched',visibleBranch:'수원점',visibleAddress:'',entranceVisible:true,samePassage:true,connection:'flat',continuousConnection:true,bypass:'none-observed',bypassSamePassage:false,entirePassageVisible:true,reason:'선택한 점포 간판 아래 문과 보도의 연결이 보입니다.',nextAction:'간판 아래 출입문 하단과 보도가 함께 보이도록 왼쪽에서 촬영해 주세요.',...changes});
}

test('a neighboring storefront cannot clear the selected cafe entrance',()=>{
    const decision=decidePlaceEntrance(place,{views:[view({visibleName:'옆집 카페'})]});
    assert.equal(decision.verdict,'unknown');
    assert.match(decision.nextAction,/간판|출입문/);
    assert.equal(decision.uncertainty,'identity');
});
test('nearby coordinates without a readable target name do not establish identity',()=>{
    assert.equal(decidePlaceEntrance(place,{views:[view({visibleName:''})]}).verdict,'unknown');
});
test('another branch of the same brand cannot clear the selected entrance',()=>{
    assert.equal(decidePlaceEntrance(place,{views:[view({visibleName:'오늘 카페 서울점'})]}).verdict,'unknown');
});
test('a visible target sign without the actual entrance connection cannot clear',()=>{
    assert.equal(decidePlaceEntrance(place,{views:[view({entranceVisible:false})]}).verdict,'unknown');
    assert.equal(decidePlaceEntrance(place,{views:[view({continuousConnection:false})]}).verdict,'unknown');
});
test('a directly observed flat connection has its own result',()=>{
    assert.equal(decidePlaceEntrance(place,{views:[view()]}).verdict,'flat');
});
test('stairs with an observed continuous ramp bypass in the same passage are not blocked',()=>{
    const decision=decidePlaceEntrance(place,{views:[view({connection:'stairs',bypass:'ramp',bypassSamePassage:true})]});
    assert.equal(decision.verdict,'ramp');
});
test('a neighboring ramp cannot erase the selected entrance stairs',()=>{
    const decision=decidePlaceEntrance(place,{views:[view({connection:'stairs',continuousConnection:false}),view({id:'neighbor',visibleName:'옆집 카페',connection:'ramp'})]});
    assert.equal(decision.verdict,'raised');
});
test('a second flat view cannot silently erase stairs without a same-passage bypass',()=>{
    const decision=decidePlaceEntrance(place,{views:[view({connection:'stairs',continuousConnection:false}),view({id:'flat-view'})]});
    assert.equal(decision.verdict,'unknown');
});
test('stairs with an unobserved bypass area stay unknown rather than claiming no alternative',()=>{
    assert.equal(decidePlaceEntrance(place,{views:[view({connection:'stairs',continuousConnection:false,bypass:'unobservable',entirePassageVisible:false})]}).verdict,'unknown');
});
test('a raised threshold is reported only when the same passage has no observed bypass',()=>{
    assert.equal(decidePlaceEntrance(place,{views:[view({connection:'raised',continuousConnection:false})]}).verdict,'raised');
    assert.equal(decidePlaceEntrance(place,{views:[view({connection:'raised',continuousConnection:false,entirePassageVisible:false})]}).verdict,'unknown');
});

test('a visible Latin transliteration establishes the name but never invents an occluded connection',()=>{
    const cafe:Place={...place,name:'카페칸나'};
    const identity={visibleName:'CANNA COFFEE',nameMatch:'transliteration',identityReason:'CANNA COFFEE의 CANNA는 카페칸나의 칸나에 대응하는 음역이며 COFFEE는 업종 표기입니다.',branchMatch:'not-applicable',visibleBranch:''} satisfies Partial<EntranceReview['views'][number]>;
    assert.equal(decidePlaceEntrance(cafe,{views:[view(identity)]}).verdict,'flat');
    const reason='CANNA COFFEE 간판은 보이지만 차량과 차양막이 문 아래 연결부를 가립니다.';
    const nextAction='차량 왼쪽으로 이동해 차양막 아래 문 하단부터 보도까지 함께 촬영해 주세요.';
    const result=decidePlaceEntrance(cafe,{views:[view({...identity,entranceVisible:false,samePassage:false,connection:'unobservable',continuousConnection:false,entirePassageVisible:false,reason,nextAction})]});
    assert.equal(result.verdict,'unknown');
    assert.equal(result.reason,reason);
    assert.equal(result.uncertainty,'connection');
    assert.equal(result.nextAction,nextAction);
});
test('a claimed transliteration cannot admit an arbitrary brand or incomplete visible name',()=>{
    const cafe:Place={...place,name:'카페칸나'};
    for(const visibleName of ['STARBUCKS','ANNA COFFEE','KANNA ON COFFEE']){
        assert.equal(decidePlaceEntrance(cafe,{views:[view({visibleName,nameMatch:'transliteration',identityReason:`${visibleName}는 카페칸나의 음역입니다.`,branchMatch:'not-applicable',visibleBranch:''})]}).verdict,'unknown');
    }
});
test('transliterated brand still requires independently visible matching branch evidence',()=>{
    const target:Place={...place,name:'메가MGC커피 수원영통점',address:'경기 수원시 영통구 청명남로 31'};
    const brand={visibleName:'MEGA MGC COFFEE',nameMatch:'transliteration',identityReason:'MEGA MGC COFFEE는 메가MGC커피 수원영통점의 브랜드 음역입니다.'} satisfies Partial<EntranceReview['views'][number]>;
    assert.equal(decidePlaceEntrance(target,{views:[view({...brand,visibleBranch:'서울점',branchMatch:'matched'})]}).verdict,'unknown');
    assert.equal(decidePlaceEntrance(target,{views:[view({...brand,visibleBranch:'서울점',visibleAddress:'청명남로 31',branchMatch:'matched'})]}).verdict,'unknown');
    assert.equal(decidePlaceEntrance(target,{views:[view({...brand,visibleBranch:'',visibleAddress:'경기 수원시',branchMatch:'matched'})]}).verdict,'unknown');
    assert.equal(decidePlaceEntrance(target,{views:[view({...brand,visibleBranch:'',visibleAddress:'청명남로 31',branchMatch:'matched'})]}).verdict,'flat');
    assert.equal(decidePlaceEntrance(target,{views:[view({...brand,visibleBranch:'수원영통점',branchMatch:'different'})]}).verdict,'unknown');
    assert.equal(decidePlaceEntrance(target,{views:[view({...brand,visibleBranch:'수원영통점',branchMatch:'matched'})]}).verdict,'flat');
});

test('independent entrance analysis retains real capture inputs and rejects the wrong target through four views',async t=>{
    const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererUrl:'https://renderer.example/capture',rendererToken:'test'};
    const captures:{coord:[number,number];heading:number;target:[number,number];tilt:number;zoom:number}[]=[];
    let jointReviews=0;
    t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
        const body=JSON.parse(String(init?.body));
        if(String(input)===config.rendererUrl){
            captures.push(body);
            return Response.json({image:{mime:'image/jpeg',data:btoa(String.fromCharCode(255,216,255,captures.length,0,0))},source:{url:'https://map.kakao.com/?panoid=fixture',capturedAt:1700000000000,panoId:'fixture',coord:body.coord,heading:body.heading,tilt:body.tilt,zoom:body.zoom}});
        }
        jointReviews++;
        assert.equal(body.generationConfig.responseSchema.type,'OBJECT');
        assert.deepEqual(body.generationConfig.responseSchema.required,['views']);
        assert.equal(body.generationConfig.responseSchema.properties.views.items.properties.continuousConnection.type,'BOOLEAN');
        const ids=body.contents[0].parts.filter((part:{text?:string})=>part.text?.startsWith('사진 ID: ')).map((part:{text:string})=>part.text.slice('사진 ID: '.length));
        return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({views:ids.map((id:string)=>view({id,visibleName:'옆집 카페'}))})}]}}]});
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
        assert.ok(captures.some(capture=>JSON.stringify(capture.coord)===JSON.stringify(photo.input.coord)&&capture.heading===photo.input.heading&&capture.tilt===photo.input.tilt&&capture.zoom===photo.input.zoom));
    }
});

test('an unavailable analysis service retains captured original evidence without clearing an entrance',async t=>{
    const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererUrl:'https://renderer.example/capture',rendererToken:'test'};
    const image={mime:'image/jpeg',data:'/9j/AAAA'};
    t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
        if(String(input)!==config.rendererUrl)return new Response('',{status:503});
        const body=JSON.parse(String(init?.body));
        return Response.json({image,source:{url:'https://map.kakao.com/?panoid=fixture',capturedAt:null,coord:body.coord,heading:body.heading,tilt:body.tilt,zoom:body.zoom}});
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
            return Response.json({image:{mime:'image/jpeg',data:btoa(String.fromCharCode(255,216,255,captures,0,0))},source:{url:'https://map.kakao.com/?panoid=fixture',capturedAt:null,panoId:'fixture',coord:body.coord,heading:body.heading,tilt:body.tilt,zoom:body.zoom}});
        }
        reviews++;
        const ids=body.contents[0].parts.filter((part:{text?:string})=>part.text?.startsWith('사진 ID: ')).map((part:{text:string})=>part.text.slice('사진 ID: '.length));
        const text=reviews===1?JSON.stringify({views:ids.map((id:string)=>view({id,reason,connection:'unobservable',continuousConnection:false,entirePassageVisible:false}))}):'{\"views\": [';
        return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]});
    });
    const result=await analyzePlaceEntrance(place,config,new AbortController().signal);
    assert.equal(result.verdict,'unknown');
    assert.equal(result.reason,reason);
    assert.equal(result.uncertainty,'connection');
    assert.equal(result.evidence.length,4);
    assert.equal(result.evidence.filter(photo=>photo.identity?.reason===reason).length,2);
    assert.ok(result.limitations.some(message=>message.includes('JSON 문법')));
});

test('joint review reports the failed field instead of conflating malformed data with occlusion',async t=>{
    const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererUrl:'https://renderer.example/capture',rendererToken:'test'};
    t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
        const body=JSON.parse(String(init?.body));
        if(String(input)===config.rendererUrl)return Response.json({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid=fixture',capturedAt:null,coord:body.coord,heading:body.heading,tilt:body.tilt,zoom:body.zoom}});
        const invalid={...view({id:'entrance-1'}),connection:'unknown'};
        return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({views:[invalid]})}]}}]});
    });
    const result=await analyzePlaceEntrance(place,config,new AbortController().signal);
    assert.equal(result.verdict,'unknown');
    assert.ok(result.limitations.some(message=>message.includes('views.0.connection')));
});

test('a top-level model array is reported as a root protocol error, not silently accepted as storefront evidence',async t=>{
    const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererUrl:'https://renderer.example/capture',rendererToken:'test'};
    t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
        const body=JSON.parse(String(init?.body));
        if(String(input)===config.rendererUrl)return Response.json({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid=fixture',capturedAt:null,coord:body.coord,heading:body.heading,tilt:body.tilt,zoom:body.zoom}});
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
  return Response.json({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid=fixture',capturedAt:null,coord:body.coord,heading:body.heading,tilt:body.tilt,zoom:body.zoom}});
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
