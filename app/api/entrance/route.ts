import {NextResponse} from 'next/server';
import {analyzePlaceEntrance,entranceRequestSchema} from '@/lib/place-entrance';
import {serverConfig} from '@/lib/server-config';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','Vary':'oai-authenticated-user-id','X-Content-Type-Options':'nosniff'};
export async function POST(request:Request){
    const origin=request.headers.get('origin');
    if(origin&&origin!==new URL(request.url).origin)return NextResponse.json({error:'요청을 처리할 수 없습니다.'},{status:403,headers});
    const local=import.meta.env.DEV&&['localhost','127.0.0.1'].includes(new URL(request.url).hostname);
    const ownerId=request.headers.get('oai-authenticated-user-id')||(local?'local-preview-owner':null);
    if(!ownerId)return NextResponse.json({error:'로그인 후 입구 확인을 이용해 주세요.'},{status:401,headers});
    if(Number(request.headers.get('content-length'))>20000)return NextResponse.json({error:'입력값을 확인해 주세요.'},{status:413,headers});
    try{
        const text=await request.text();
        if(text.length>20000)return NextResponse.json({error:'입력값을 확인해 주세요.'},{status:413,headers});
        let value:unknown;
        try{value=JSON.parse(text);}catch{return NextResponse.json({error:'입력값을 확인해 주세요.'},{status:400,headers});}
        const parsed=entranceRequestSchema.safeParse(value);
        if(!parsed.success)return NextResponse.json({error:'입력값을 확인해 주세요.'},{status:400,headers});
        const result=await analyzePlaceEntrance(parsed.data.place,serverConfig(),request.signal);
        return NextResponse.json(result,{headers});
    }catch{
        return NextResponse.json({error:'입구 사진 확인 서비스를 잠시 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.'},{status:503,headers});
    }
}
