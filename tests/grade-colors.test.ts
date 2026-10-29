import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {gradeBand} from '../app/grade-colors.ts';
import type {Route} from '../lib/domain.ts';

const boundaries = [
  {value:-20,className:'grade-high',color:'#ef4444'},
  {value:-19.99,className:'grade-medium',color:'#eab308'},
  {value:-10,className:'grade-medium',color:'#eab308'},
  {value:-9.99,className:'grade-low',color:'#176b55'},
  {value:0,className:'grade-low',color:'#176b55'},
  {value:9.99,className:'grade-low',color:'#176b55'},
  {value:10,className:'grade-medium',color:'#eab308'},
  {value:19.99,className:'grade-medium',color:'#eab308'},
  {value:20,className:'grade-high',color:'#ef4444'},
];

for(const {value,className,color} of boundaries)test(`grade ${value}% uses the specified absolute-grade color`,()=>{
  const band=gradeBand(value);
  assert.equal(band.className,className);
  assert.equal(band.color,color);
});

test('missing and nonfinite grades remain gray instead of flat green',()=>{
  for(const value of [null,undefined,NaN,Infinity,-Infinity]){
    assert.equal(gradeBand(value).className,'grade-unknown');
    assert.equal(gradeBand(value).color,'#8b95a3');
    assert.equal(gradeBand(value).label,'자료 없음');
  }
});

const sourceUrl=new URL('../app/RouteTerrain.tsx',import.meta.url);
const compiled=ts.transpileModule(await readFile(sourceUrl,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const resolved=compiled.replace(/from (["'])([^"']+)\1/g,(_match,_quote,specifier:string)=>`from ${JSON.stringify(specifier.startsWith('.')?new URL(specifier,sourceUrl).href:import.meta.resolve(specifier))}`);
const {default:RouteTerrain}:typeof import('../app/RouteTerrain.tsx')=await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`);
const route:Route={
  id:'grade-boundaries',name:'경사 경계',options:[],coords:[[127,37],[127,37.002]],distance:222,seconds:180,steps:[],samples:[],fetchedAt:'2026-10-29T00:00:00.000Z',
  grade:{status:'partial',dataset:'srtm30m',resolutionMeters:30,baselineMeters:60,retrievedAt:'2026-10-29T00:00:00.000Z',maxAbsPercent:20,ascentMeters:20,descentMeters:20,coverageFraction:.9,segments:boundaries.map(({value},index)=>({fromAlong:index*20,toAlong:(index+1)*20,coords:[[127,37],[127,37.001]],gradePercent:value}))},
};

test('the real profile renders boundary colors and signed slopes independently of the statistics threshold',()=>{
  for(const threshold of [5,8,12]){
    const html=renderToStaticMarkup(createElement(RouteTerrain,{route,threshold,activeSegmentIndex:8,onSelectSegment:()=>{},onPoint:()=>{}}));
    const groups=[...html.matchAll(/<g\b([^>]*\bdata-grade-index="(\d+)"[^>]*)>(.*?)<\/g>/g)];
    assert.equal(groups.length,boundaries.length);
    for(const [index,group] of groups.entries()){
      assert.ok(group[1].includes(`color:${boundaries[index].color}`));
      assert.ok(group[1].includes(boundaries[index].className));
    }
    const zero=Number(html.match(/class="terrain-zero"[^>]*y1="([^"]+)"/)?.[1]);
    const downhill=Number(groups[0][3].match(/class="terrain-segment-line"[^>]*y1="([^"]+)"/)?.[1]);
    const uphill=Number(groups[8][3].match(/class="terrain-segment-line"[^>]*y1="([^"]+)"/)?.[1]);
    assert.ok(downhill>zero&&uphill<zero,'Signed up/down graph positions survive absolute-grade coloring');
    assert.ok(html.includes('class="terrain-gap"'),'The unmeasured end remains an explicit data gap');
    for(const label of ['10% 미만','10% 이상 20% 미만','20% 이상','자료 없음'])assert.ok(html.includes(label));
  }
});

test('the real profile explicitly identifies a route with no grade data',()=>{
  const html=renderToStaticMarkup(createElement(RouteTerrain,{route:{...route,grade:undefined},activeSegmentIndex:null,onSelectSegment:()=>{},onPoint:()=>{}}));
  assert.ok(html.includes('경사 정보가 없어요. 평탄한 길이라는 뜻은 아닙니다.'));
  assert.equal(html.includes('terrain-profile-segment'),false);
});
