import {NextResponse} from 'next/server';
import {z} from 'zod';
import {search,geocode,routes,imagery,analyze,ServiceError} from '@/lib/providers';
export const dynamic='force-dynamic';
const coord=z.tuple([z.number().min(124).max(132),z.number().min(33).max(40)]);
const keys=z.object({tmap:z.string().max(1024),mapillary:z.string().max(2048),ai:z.string().max(2048),provider:z.enum(['gemini','khu']),baseUrl:z.string().max(500),model:z.string().max(100)});
const place=z.object({id:z.string().max(100),name:z.string().max(200),address:z.string().max(300),coord});
const sample=z.object({id:z.string().max(50),coord,heading:z.number().min(0).max(360),along:z.number().min(0).max(30000),critical:z.boolean()});
const schema=z.discriminatedUnion('action',[
 z.object({action:z.literal('search'),query:z.string().min(2).max(150),address:z.boolean().optional(),keys}),
 z.object({action:z.literal('routes'),start:place,end:place,keys}),
 z.object({action:z.literal('inspect'),sample,profile:z.enum(['수동 휠체어','전동 휠체어','유아차','보행 보조기']),keys,analyze:z.boolean()})
]);
export async function POST(request:Request){try{
 const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)return NextResponse.json({error:'요청 출처를 확인할 수 없습니다.'},{status:403});
 if(Number(request.headers.get('content-length'))>20000)throw new ServiceError('요청 크기 초과',413);
 const text=await request.text();if(text.length>20000)throw new ServiceError('요청 크기 초과',413);const b=schema.parse(JSON.parse(text));let data;
 if(b.action==='search')data={places:await (b.address?geocode:search)(b.query,b.keys)};
 else if(b.action==='routes')data=await routes(b.start,b.end,b.keys);
 else {const image=await imagery(b.sample,b.keys);data={evidence:!image?{sampleId:b.sample.id,status:'unknown',reason:'진행방향과 가까운 거리영상이 없습니다.',checkedAt:new Date().toISOString()}:b.analyze?await analyze(b.sample,b.profile,b.keys,image):{sampleId:b.sample.id,status:'unknown',reason:'거리영상 확보 · AI 분석 전',image,checkedAt:new Date().toISOString()}};}
 return NextResponse.json(data,{headers:{'Cache-Control':'no-store'}});
 }catch(e){const status=e instanceof ServiceError?e.status:e instanceof z.ZodError||e instanceof SyntaxError?400:502;return NextResponse.json({error:e instanceof ServiceError?e.message:status===400?'입력값을 확인해 주세요.':'외부 서비스 연결이 지연되거나 응답을 처리하지 못했습니다. 다시 시도해 주세요.'},{status,headers:{'Cache-Control':'no-store'}});}}
