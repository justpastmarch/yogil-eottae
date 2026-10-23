'use client';
import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {imageResult,modelsResult,MAX_IMAGE_BYTES,type KhuImageResult} from '@/lib/khu';
import './style.css';

const errorResponse=z.object({error:z.string()});
const labels={clear:'사진상 장애 미관찰',caution:'이동 조건 살펴보기',blocked:'통행 장애 관찰',unknown:'보행 공간 판독 어려움'};
type Connection = {kind:'idle'}|{kind:'loading'}|{kind:'ready';models:z.infer<typeof modelsResult>['models']}|{kind:'error';message:string};
type Analysis = {kind:'idle'}|{kind:'loading'}|{kind:'done';result:KhuImageResult}|{kind:'error';message:string};
async function call(body:unknown){
  const response=await fetch('/api/connection',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify(body)});
  const data:unknown=await response.json();
  if(!response.ok){const error=errorResponse.safeParse(data);throw new Error(error.success?error.data.error:'연결 응답을 처리하지 못했습니다.');}
  return data;
}
function message(error:unknown){return error instanceof Error?error.message:'다시 시도해 주세요.';}
function readFile(file:File):Promise<string>{return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>typeof reader.result==='string'?resolve(reader.result.slice(reader.result.indexOf(',')+1)):reject(new Error('사진을 읽지 못했습니다.'));reader.onerror=()=>reject(new Error('사진을 읽지 못했습니다.'));reader.readAsDataURL(file);});}

export default function Connect(){
  const [apiKey,setApiKey]=useState(''),[connection,setConnection]=useState<Connection>({kind:'idle'}),[analysis,setAnalysis]=useState<Analysis>({kind:'idle'});
  const [model,setModel]=useState(''),[profile,setProfile]=useState('수동 휠체어'),[file,setFile]=useState<File|null>(null),[preview,setPreview]=useState(''),[fileError,setFileError]=useState('');
  const fileInput=useRef<HTMLInputElement>(null);
  const busy=connection.kind==='loading'||analysis.kind==='loading';
  useEffect(()=>{if(!file){setPreview('');return;}const url=URL.createObjectURL(file);setPreview(url);return()=>URL.revokeObjectURL(url);},[file]);
  function reset(){setApiKey('');setConnection({kind:'idle'});setAnalysis({kind:'idle'});setModel('');setFile(null);setFileError('');if(fileInput.current)fileInput.current.value='';}
  async function connect(){
    setConnection({kind:'loading'});setAnalysis({kind:'idle'});
    try{const result=modelsResult.parse(await call({action:'models',apiKey}));if(!result.models.length)throw new Error('이 계정에서 Gemini 또는 Claude 모델을 조회하지 못했습니다. ChatKHU 모델 권한을 확인해 주세요.');
      setConnection({kind:'ready',models:result.models});setModel(result.models.find(m=>m.id==='gemini-3.8-flash')?.id||result.models.find(m=>m.id==='claude-sonnet-5-5')?.id||result.models[0].id);
    }catch(error){setConnection({kind:'error',message:message(error)});}
  }
  async function analyze(){
    if(!file||connection.kind!=='ready')return;
    setAnalysis({kind:'loading'});
    try{const data=await readFile(file);const result=imageResult.parse(await call({action:'analyze',apiKey,model,profile,image:{mime:file.type,data}}));setAnalysis({kind:'done',result});}
    catch(error){setAnalysis({kind:'error',message:message(error)});}
  }
  return <main className="connect-page">
    <header className="connect-header"><a href="/" className="connect-brand">길이음<span>모두를 위한 이동</span></a><a href="/" className="connect-map-link">지도 보기 ↗</a></header>
    <div className="connect-wrap"><div className="connect-intro"><span className="connect-pill">ChatKHU 연결</span><h1>발급받은 키로,<br/>거리사진을 분석해 보세요.</h1><p>계정 연결부터 사진 한 장의 실제 AI 판독까지.<br/>지도·경로 키 없이 먼저 확인할 수 있습니다.</p></div>
    <div className="connect-grid"><section className="connect-card"><div className="connect-step">01 <span>계정 연결</span></div><h2>ChatKHU API 키 입력</h2><p>키는 이 페이지의 메모리에만 유지됩니다.<br/>새로고침하거나 지우면 다시 입력해야 합니다.</p>
      <label htmlFor="khu-key">API 키</label><input id="khu-key" type="password" autoComplete="off" spellCheck={false} disabled={busy} value={apiKey} onChange={e=>{setApiKey(e.target.value);setConnection({kind:'idle'});setAnalysis({kind:'idle'});setModel('');}} placeholder="발급받은 키를 여기에 붙여 넣으세요"/>
      <button className="connect-primary" disabled={busy||!apiKey.trim()} onClick={connect}>{connection.kind==='loading'?'계정과 모델 확인 중…':'연결 확인 · 모델 불러오기'}</button>
      <div aria-live="polite">{connection.kind==='ready'&&<p className="connect-success">연결 성공 · Gemini / Claude 모델 {connection.models.length}개 조회</p>}{connection.kind==='error'&&<p className="connect-error">{connection.message}</p>}</div>
      <div className="connect-details"><span>연결 대상</span><b>ChatKHU · Mindlogic API Gateway</b><small>factchat-cloud.mindlogic.ai</small><a href="https://chat.khu.ac.kr/dashboard/developers" target="_blank" rel="noreferrer">ChatKHU 개발자 페이지 ↗</a></div>
      <button className="connect-reset" disabled={busy} onClick={reset}>입력한 키와 사진 지우기</button>
    </section><section className="connect-card"><div className="connect-step">02 <span>실제 이미지 판독</span></div><h2>거리사진 한 장으로 시작</h2><p>보행로나 건물 진입부가 보이는 사진을 선택하세요.<br/>연결한 계정의 모델에 실제 이미지가 전달됩니다.</p>
      <label htmlFor="khu-model">분석 모델</label><select id="khu-model" disabled={busy||connection.kind!=='ready'} value={model} onChange={e=>{setModel(e.target.value);setAnalysis({kind:'idle'});}}>{connection.kind==='ready'?connection.models.map(m=><option key={m.id} value={m.id}>{m.id}</option>):<option value="">계정을 연결하면 모델을 선택할 수 있습니다</option>}</select>
      <label htmlFor="khu-profile">이동 기준</label><select id="khu-profile" disabled={busy} value={profile} onChange={e=>{setProfile(e.target.value);setAnalysis({kind:'idle'});}}>{['수동 휠체어','전동 휠체어','유아차','보행 보조기'].map(p=><option key={p}>{p}</option>)}</select>
      <label htmlFor="khu-photo">거리사진 선택</label><input id="khu-photo" ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={e=>{setAnalysis({kind:'idle'});setFileError('');const selected=e.target.files?.[0];if(!selected){setFile(null);return;}if(!['image/jpeg','image/png','image/webp'].includes(selected.type)||selected.size>MAX_IMAGE_BYTES){setFile(null);setFileError('JPG·PNG·WebP 사진을 4MB 이하로 선택해 주세요.');return;}setFile(selected);}}/>
      {preview&&<img className="connect-photo" src={preview} alt="AI에 보낼 선택한 거리사진"/>}{fileError&&<p className="connect-error">{fileError}</p>}
      <p className="connect-caption">‘사진 분석’을 누르면 선택한 사진이 앱 서버를 거쳐 ChatKHU로 전송되며 계정 크레딧이 사용됩니다. 앱은 키와 사진을 파일·DB에 저장하지 않습니다.</p>
      <button className="connect-primary" disabled={busy||connection.kind!=='ready'||!file||!model} onClick={analyze}>{analysis.kind==='loading'?'실제 이미지를 분석하고 있습니다…':'사진 분석 · 1회 호출'}</button>
      <div aria-live="polite">{analysis.kind==='error'&&<p className="connect-error">{analysis.message}</p>}</div>
    </section></div>
    {analysis.kind==='done'&&<section className="connect-card connect-result" aria-live="polite"><div className="connect-step">03 <span>판독 결과</span></div><span className={'connect-status '+analysis.result.finding.status}>{labels[analysis.result.finding.status]}</span><h2>{analysis.result.finding.reason}</h2><ul>{analysis.result.finding.evidence.map((e,i)=><li key={i}>{e}</li>)}</ul>{analysis.result.finding.limitations.length>0&&<p className="connect-limit">{analysis.result.finding.limitations.join(' · ')}</p>}<div className="connect-result-meta"><span>{analysis.result.model}</span><span>입력 {analysis.result.usage.input.toLocaleString()} · 출력 {analysis.result.usage.output.toLocaleString()} 토큰</span>{analysis.result.billing?.deducted_credit!==undefined&&<span>차감 {analysis.result.billing.deducted_credit} 크레딧</span>}{analysis.result.billing?.cost_krw!==undefined&&<span>호출 비용 {analysis.result.billing.cost_krw.toLocaleString()}원</span>}<span>{new Date(analysis.result.checkedAt).toLocaleString('ko-KR')}</span></div></section>}
    <footer className="connect-footer">이 화면은 사진 한 장의 AI 연결 시험입니다. 전체 경로의 영상 자동 확보와 추천은 지도 기능에서 별도로 연결합니다.</footer>
    </div>
  </main>;
}
