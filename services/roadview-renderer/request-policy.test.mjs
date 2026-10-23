import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {routeRendererRequest} from './request-policy.mjs';

test('private app credential never follows a redirect to another origin',async()=>{
  let received;
  const destination=http.createServer((req,res)=>{received=req.headers['oai-sites-authorization'];res.end('destination');});
  destination.listen(0,'127.0.0.1');await once(destination,'listening');
  const target=`http://127.0.0.1:${destination.address().port}`;
  let sourceReceived;
  const source=http.createServer((req,res)=>{sourceReceived=req.headers['oai-sites-authorization'];res.writeHead(302,{location:target+'/target'});res.end();});
  source.listen(0,'127.0.0.1');await once(source,'listening');
  const origin=`http://127.0.0.1:${source.address().port}`;
  const browser=await chromium.launch({channel:process.env.ROADVIEW_BROWSER_CHANNEL??'chrome',headless:true});
  try{
    const context=await browser.newContext();
    await context.route('**/*',route=>routeRendererRequest(route,origin,'TEST_ONLY_SENTINEL'));
    const page=await context.newPage();
    await page.goto(origin+'/internal/roadview').catch(()=>{});
    assert.equal(sourceReceived,'Bearer TEST_ONLY_SENTINEL');
    assert.equal(received,undefined);
  }finally{
    await browser.close();source.closeAllConnections();destination.closeAllConnections();
    await Promise.all([new Promise(resolve=>source.close(resolve)),new Promise(resolve=>destination.close(resolve))]);
  }
});
