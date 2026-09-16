// Isolated actual Workers runtime: external identity/points are synthetic, R2/KV/D1 are local.
// No test route or fake LINE SDK is included in the deployed entrypoint.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(process.env.WRANGLER_PACKAGE || import.meta.url);
const { Miniflare } = require('miniflare'), { build } = require('esbuild');
const root = new URL('../', import.meta.url), UID = 'U' + 'c'.repeat(32);
const browserMode = process.argv.includes('--browser');
const fakeSdk = `window.liff={init:async()=>{},isLoggedIn:()=>true,isInClient:()=>true,getAccessToken:()=>"local-synthetic",getProfile:async()=>({userId:"${UID}",displayName:"本機驗收會員"}),login:()=>{}};`;
const bundle = await build({stdin:{resolveDir:fileURLToPath(root),contents:`
import worker from './tracked-worker.js';
export default {async fetch(request,env,ctx){
  if(new URL(request.url).pathname==='/__test-liff.js') return new Response(${JSON.stringify(fakeSdk)},{headers:{'content-type':'text/javascript'}});
  const response=await worker.fetch(request,env,ctx);
  if(response.headers.get('content-type')?.includes('text/html')){
    const html=(await response.text()).replace('https://static.line-scdn.net/liff/edge/2/sdk.js','/__test-liff.js');
    return new Response(html,{status:response.status,headers:response.headers});
  }
  return response;
}};`},bundle:true,write:false,format:'esm',platform:'browser'});
const network=[];
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-04-06',
  host:'127.0.0.1',port:browserMode ? 8796 : 0,
  r2Buckets:{'act-image':'isolated-registration'},kvNamespaces:{ACTION_DATA:'isolated-registration'},d1Databases:{DB:'isolated-registration'},
  bindings:{SHOP_MODULE:'huaxu',LINE_LOGIN_CHANNEL_ID:'2007674851',SHOP_LIFF_ID:'2007674851-test',HOOKTEA_DAILY_SIGNIN_POINTS:'1',WP_SYNC_ENABLED:'false'},
  outboundService:async request=>{
    const url=new URL(request.url);network.push(url.origin+url.pathname);
    if(url.origin==='https://api.line.me' && url.pathname==='/oauth2/v2.1/verify')return Response.json({client_id:'2007674851',expires_in:3600});
    if(url.origin==='https://api.line.me' && url.pathname==='/v2/profile')return Response.json({userId:UID,displayName:'本機驗收會員'});
    throw Error('UNEXPECTED_EXTERNAL_REQUEST '+url.origin+url.pathname);
  }});
try {
  const db=await mf.getD1Database('DB'),kv=await mf.getKVNamespace('ACTION_DATA'),r2=await mf.getR2Bucket('act-image');
  for(const file of ['0001_line_monitor.sql','0002_ai_learning_cases.sql','0003_daily_signin_claims.sql','0004_reward_claims.sql','0005_point_operations.sql']){
    const sql=readFileSync(new URL('migrations/'+file,root),'utf8').replace(/^--.*$/gm,'');
    for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  }
  const trackingSql=readFileSync(new URL('migrations/0006_crm_write_tracking.sql',root),'utf8').replace(/^--.*$/gm,'').trim();
  for(const statement of trackingSql.split(/;\s*(?=CREATE\s|INSERT\s)/).map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  await kv.put('SYSTEM_SETTINGS',JSON.stringify({shop_module:'huaxu',shop_liff_id:'2007674851-test',shop_payment_methods:'COD',shop_shipping_fee:0}));
  await kv.put('USERS_INDEX',JSON.stringify([{userId:'unrelated',name:'Existing'}]));
  await kv.put('PRODUCTS',JSON.stringify([{id:'test-tea',name:'本機驗收茶（非正式商品）',price:100,pointsPrice:20,isPublished:true,status:'販賣中'}]));
  const call=(path,method='POST',body={})=>mf.dispatchFetch('http://127.0.0.1:8796'+path,{method,headers:{authorization:'Bearer local-synthetic','content-type':'application/json'},body:JSON.stringify({lineUserId:UID,...body})});
  const first=await call('/api/huaxu/member');assert.equal(first.status,200);assert.equal((await first.json()).member.registrationStatus,'pending');
  console.log('PASS workerd verified login persists pending CRM in local R2');
  const blocked=await call('/api/huaxu/orders','POST',{items:[{id:'test-tea',quantity:1}],pointsUsed:0});
  assert.equal(blocked.status,409);assert.equal((await blocked.json()).code,'MEMBER_REGISTRATION_REQUIRED');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM checkout_requests').first()).n,0);
  console.log('PASS workerd pending checkout has no order request/payment effect');
  if(!browserMode){
    const responses=await Promise.all([call('/api/huaxu/member','PUT',{profile:{name:'本機測試',phone:'0912345678'}}),call('/api/huaxu/member')]);
    assert(responses.every(r=>r.status===200));
    const saved=await (await r2.get('live/high-risk/users/'+UID+'.json')).json();assert.equal(saved.registrationStatus,'registered');
    assert.equal((await (await call('/api/huaxu/member')).json()).member.registrationStatus,'registered');
    assert.equal((await r2.list({prefix:'live/high-risk/points/'})).objects.length,0);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM point_operations').first()).n,0);
    console.log('PASS workerd conditional writes preserve registered state and no point awards');
    assert(network.every(url=>url.startsWith('https://api.line.me/')));
    console.log('3 workerd groups passed; no production bindings or external side effects');
  } else {
    console.log('LOCAL_BROWSER_ACCEPTANCE '+await mf.ready+'?open=register');
    await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  }
} finally {await mf.dispose();}
