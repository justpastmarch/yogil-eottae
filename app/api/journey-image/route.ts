import {z} from 'zod';
import {readJourneyCapture} from '../../../lib/journey-captures.ts';
import {serverDatabase} from '../../../lib/server-config.ts';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
const captureId=z.string().uuid();

export async function GET(request:Request){
    const url=new URL(request.url),origin=request.headers.get('origin');
    if(origin&&origin!==url.origin)return new Response(null,{status:403,headers});
    const userId=request.headers.get('oai-authenticated-user-id');
    const local=import.meta.env?.DEV&&['localhost','127.0.0.1'].includes(url.hostname);
    const ownerId=userId||(local?'local-preview-owner':null);
    if(!ownerId)return new Response(null,{status:401,headers});
    const id=captureId.safeParse(url.searchParams.get('id'));
    if(!id.success)return new Response(null,{status:404,headers});
    try{
        const image=await readJourneyCapture(serverDatabase(),id.data,ownerId);
        if(!image)return new Response(null,{status:404,headers});
        if(!(image.bytes.buffer instanceof ArrayBuffer))throw new Error('Invalid image buffer');
        return new Response(image.bytes.buffer,{headers:{...headers,'Content-Type':image.mime}});
    }catch{
        return new Response(null,{status:503,headers});
    }
}
