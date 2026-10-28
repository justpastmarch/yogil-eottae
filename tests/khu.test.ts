import {test} from 'node:test';
import assert from 'node:assert/strict';
import {imageInput,parseKhuGeminiResponse,parseKhuClaudeResponse} from '../lib/khu.ts';
import type {Finding} from '../lib/domain.ts';

const finding={status:'clear',reason:'보행 공간 관찰',evidence:['보도 연결부와 이어지는 포장면'],limitations:[],pathVisible:true,routeMatch:'same-path',visibility:'visible',reviewReason:'none',observation:{connection:'flush',surface:'continuous',uncertainty:'none',target:'sidewalk',reason:'지정 보도의 연결부와 노면이 직접 보임'}} satisfies Finding;
test('interrupted Gemini response is rejected even when JSON looks complete',()=>{
  assert.throws(()=>parseKhuGeminiResponse({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:JSON.stringify(finding)}]}}]}));
});
test('Gemini hidden thoughts are not used as findings and tokens include reasoning',()=>{
  const result=parseKhuGeminiResponse({candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'not a finding'},{text:JSON.stringify(finding)}]}}],usageMetadata:{promptTokenCount:50,candidatesTokenCount:20,thoughtsTokenCount:30}});
  assert.equal(result.finding.status,'clear');assert.equal(result.usage.output,50);
});
test('Claude refusal or truncated output cannot become a clear verdict',()=>{
  for(const stop_reason of ['max_tokens','refusal'])assert.throws(()=>parseKhuClaudeResponse({stop_reason,content:[{type:'text',text:JSON.stringify(finding)}],usage:{input_tokens:1,output_tokens:1}}));
});
test('a normal Claude response with invisible path becomes unknown',()=>{
  const result=parseKhuClaudeResponse({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({...finding,pathVisible:false})}],usage:{input_tokens:10,output_tokens:20}});
  assert.equal(result.finding.status,'unknown');
});
test('image type must agree with actual bytes and malformed base64 is rejected',()=>{
  assert.equal(imageInput.safeParse({mime:'image/png',data:btoa('not a png image')}).success,false);
  assert.equal(imageInput.safeParse({mime:'image/png',data:'invalid!'}).success,false);
  assert.equal(imageInput.safeParse({mime:'image/png',data:'iVBORw0KGgo='}).success,true);
});

test('native AI parsers retain structured observations without a numeric grade',()=>{
  const features={stairs:{state:'present',reason:'통로에 계단이 보임'},incline:{state:'not-observed',reason:'사진에 경사가 보이지 않음'}};
  const text=JSON.stringify({...finding,status:'blocked',features,grade:12});
  const gemini=parseKhuGeminiResponse({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]});
  const claude=parseKhuClaudeResponse({stop_reason:'end_turn',content:[{type:'text',text}],usage:{input_tokens:1,output_tokens:1}});
  for(const result of [gemini,claude]){
    assert.deepEqual(result.finding.features,features);
    assert.equal('grade' in result.finding,false);
  }
});

test('both network parsers require visibility, review reason, and structured observation',()=>{
 const {visibility,reviewReason,observation,...legacy}=finding;
 for(const raw of [legacy,{...legacy,reviewReason,observation},{...legacy,visibility,observation},{...legacy,visibility,reviewReason}]){
  const text=JSON.stringify(raw);
  assert.throws(()=>parseKhuGeminiResponse({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]}));
  assert.throws(()=>parseKhuClaudeResponse({stop_reason:'end_turn',content:[{type:'text',text}],usage:{input_tokens:1,output_tokens:1}}));
 }
});
test('native AI observations distinguish connecting ramps, physical obstacles, and hidden connections',()=>{
 const cases=[
  {observation:{...finding.observation,connection:'ramp'},status:'clear'},
  {observation:{...finding.observation,connection:'stairs'},status:'blocked'},
  {observation:{...finding.observation,connection:'raised'},status:'blocked'},
  {observation:{...finding.observation,connection:'unobservable',uncertainty:'framing'},status:'unknown'},
  {observation:{...finding.observation,connection:'unobservable',uncertainty:'occlusion'},visibility:'occluded',reviewReason:'occlusion',status:'caution'},
 ];
 for(const expected of cases){
  const {status,...observation}=expected;
  const text=JSON.stringify({...finding,...observation});
  const results=[
   parseKhuGeminiResponse({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]}),
   parseKhuClaudeResponse({stop_reason:'end_turn',content:[{type:'text',text}],usage:{input_tokens:1,output_tokens:1}}),
  ];
  for(const result of results){
   assert.equal(result.finding.status,status);
   assert.deepEqual(result.finding.observation,expected.observation);
  }
 }
});
test('native AI parsers retain an honest outdoor arrival without inventing a building connection',()=>{
 const observation={...finding.observation,target:'arrival',connection:'not-applicable',reason:'The requested outdoor endpoint is on the continuous walkway; no building entrance is being assessed.'} satisfies NonNullable<Finding['observation']>;
 const text=JSON.stringify({...finding,observation});
 const results=[
  parseKhuGeminiResponse({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]}),
  parseKhuClaudeResponse({stop_reason:'end_turn',content:[{type:'text',text}],usage:{input_tokens:1,output_tokens:1}}),
 ];
 for(const result of results){
  assert.equal(result.finding.status,'clear');
  assert.deepEqual(result.finding.observation,observation);
 }
});
