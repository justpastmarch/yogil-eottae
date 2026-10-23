import {NextResponse} from 'next/server';
import {z} from 'zod';
import {KhuError,listKhuModels,analyzeKhuImage,imageInput,khuModel} from '@/lib/khu';

export const dynamic='force-dynamic';
const apiKey=z.string().trim().min(1).max(2048).refine(key=>!/[\r\n]/.test(key));
const input=z.discriminatedUnion('action',[
  z.object({action:z.literal('models'),apiKey}),
  z.object({action:z.literal('analyze'),apiKey,model:khuModel,image:imageInput,profile:z.enum(['수동 휠체어','전동 휠체어','유아차','보행 보조기'])}),
]);
export async function POST(request:Request){
  const headers={'Cache-Control':'no-store'};
  try{
    if(request.headers.get('origin')!==new URL(request.url).origin)return NextResponse.json({error:'요청 출처를 확인할 수 없습니다.'},{status:403,headers});
    const max=6*1024*1024;
    if(Number(request.headers.get('content-length'))>max)throw new KhuError('사진은 4MB 이하로 선택해 주세요.',413);
    const reader=request.body?.getReader();if(!reader)throw new KhuError('입력값을 확인해 주세요.',400);
    const chunks:Uint8Array[]=[];let size=0;
    while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>max){await reader.cancel();throw new KhuError('사진은 4MB 이하로 선택해 주세요.',413);}chunks.push(item.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const body=input.parse(JSON.parse(new TextDecoder().decode(bytes)));
    return NextResponse.json(body.action==='models'?await listKhuModels(body):await analyzeKhuImage(body),{headers});
  }catch(error){
    const status=error instanceof KhuError?error.status:error instanceof z.ZodError||error instanceof SyntaxError?400:502;
    return NextResponse.json({error:error instanceof KhuError?error.message:status===400?'키와 사진의 형식·크기를 확인해 주세요.':'ChatKHU 연결이 지연되거나 응답 형식을 처리하지 못했습니다. 다시 시도해 주세요.'},{status,headers});
  }
}
