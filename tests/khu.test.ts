import {test} from 'node:test';
import assert from 'node:assert/strict';
import {imageInput,parseKhuGeminiResponse,parseKhuClaudeResponse} from '../lib/khu.ts';

const finding={status:'clear',reason:'보행 공간 관찰',evidence:['보도'],limitations:['사진 밖 연결'],pathVisible:true,routeMatch:'same-path'};
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
