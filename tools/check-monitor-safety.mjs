import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHmac,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {detectFeedback,redactForAi} from '../monitor-safety.js';
const require=createRequire(process.env.WRANGLER_PACKAGE||import.meta.url);
const {Miniflare}=require('miniflare'),{build}=require('esbuild');
const root=new URL('../',import.meta.url);
const bundled=await build({stdin:{resolveDir:fileURLToPath(root),contents:`
 import worker from './tracked-worker.js';
 import {captureMonitorEvents,processMonitorFeedback} from './monitor-safety.js';
 import {reconcileTrackingIncidents} from './tracking-incidents.js';
 export default {async fetch(request,env,ctx){
   const p=new URL(request.url).pathname;
   if(p==='/__capture'){await captureMonitorEvents(env,await request.json());return new Response('ok');}
   if(p==='/__process'){await processMonitorFeedback(env);return new Response('ok');}
   if(p==='/__tracking'){await reconcileTrackingIncidents(env);return new Response('ok');}
   return worker.fetch(request,env,ctx);
 }};`},bundle:true,write:false,format:'esm',platform:'browser'});
let mode='healthy',aiCalls=[],lineCalls=0,telegramCalls=0;
const mf=new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-04-06',
 d1Databases:{DB:'monitor-safety'},kvNamespaces:{ACTION_DATA:'monitor-safety'},r2Buckets:{'act-image':'monitor-safety'},
 bindings:{HOOKTEA_MONITOR_SAFETY:'true',HOOKTEA_KEYWORD_ONLY:'true',HOOKTEA_TELEGRAM_ALERTS:'true',
  OPENAI_API_KEY:'synthetic-only',ADMIN_PASSWORD:'synthetic-admin',LINE_CHANNEL_SECRET:'synthetic-line'},
 outboundService:async request=>{
  const url=new URL(request.url);
  if(url.hostname==='api.openai.com'){
   const body=await request.json();aiCalls.push(body);
   if(mode==='timeout')throw new DOMException('test','TimeoutError');
   if(mode==='quota')return Response.json({error:{code:'insufficient_quota'}},{status:429});
   if(mode==='auth')return Response.json({error:{message:'never leak this secret'}},{status:401});
   const self=body.input.length===1;
   return Response.json({status:'completed',output:[{content:[{type:'output_text',text:mode==='invalid'?'':self?'HOOKTEA_OK':JSON.stringify({category:'points',severity:'high'})}]}]});
  }
  if(url.hostname==='api.line.me'){lineCalls++;throw Error('LINE_MUST_NOT_BE_CALLED');}
  if(url.hostname==='api.telegram.org'){telegramCalls++;return Response.json({ok:true});}
  throw Error('NO_OTHER_NETWORK');
 }});
let count=0;const check=async(name,fn)=>{await fn();count++;console.log('PASS '+name);};
const uid='U'+'1'.repeat(32),admin={'x-hooktea-admin-password':'synthetic-admin','content-type':'application/json'};
const event=(id,text)=>({webhookEventId:id,type:'message',timestamp:Date.now(),replyToken:'NEVER_USE',source:{userId:uid},message:{id,type:'text',text}});
try {
 const db=await mf.getD1Database('DB');
 for(const file of ['0001_line_monitor.sql','0006_crm_write_tracking.sql','0008_operational_alerts.sql']){
  const sql=readFileSync(new URL('migrations/'+file,root),'utf8').replace(/^--.*$/gm,'').trim();
  for(const s of sql.split(/;\s*(?=CREATE\s|INSERT\s|PRAGMA\s)/).map(s=>s.trim()).filter(Boolean))await db.prepare(s).run();
 }
 const oldId='9b977f34-3e69-4174-9631-891cd8538cd3';
 await db.prepare("INSERT INTO crm_request_leases(lease_id,release,state,started_at) VALUES(?,'old','active','2026-01-01 00:00:00')").bind(oldId).run();
 const sql=readFileSync(new URL('migrations/0011_monitor_safety.sql',root),'utf8').replace(/^--.*$/gm,'').trim();
 for(const s of sql.split(/;\s*(?=CREATE\s|INSERT\s)/).map(s=>s.trim()).filter(Boolean))await db.prepare(s).run();
 const call=(p,options={})=>mf.dispatchFetch('https://test.invalid'+p,options);
 const post=(p,body,headers=admin)=>call(p,{method:'POST',headers,body:JSON.stringify(body)});
 const countAlerts=async(code)=>(await db.prepare('SELECT COUNT(*) n FROM operational_alerts WHERE code=?').bind(code).first()).n;
 await check('protected AI/status/feedback endpoints reject anonymous requests without calling AI',async()=>{
  for(const p of ['ai-self-test','safety-status','feedback'])assert.equal((await call('/api/line-oa/'+p)).status,401);
  assert.equal((await post('/api/line-oa/ai-self-test',{},{})).status,401);assert.equal(aiCalls.length,0);
 });
 await check('safe test uses only fixed input, bounded output, no storage, no customer data and one concurrent call',async()=>{
  const res=await Promise.all(Array.from({length:6},()=>post('/api/line-oa/ai-self-test',{})));
  assert(res.every(r=>r.status===200));assert.equal(aiCalls.length,1);
  assert.equal(aiCalls[0].store,false);assert.equal(aiCalls[0].max_output_tokens,160);
  assert.equal(JSON.stringify(aiCalls).includes(uid),false);assert.equal(lineCalls,0);
  assert.equal((await db.prepare('SELECT status FROM monitor_ai_health').first()).status,'healthy');
  await post('/api/line-oa/ai-self-test',{});assert.equal(aiCalls.length,1);
 });
 await check('auth/quota/invalid failures are safe, unchanged failures are quiet and recovery notifies once',async()=>{
  for(const [next,expected] of [['auth','authentication_failed'],['auth','authentication_failed'],['quota','quota_exhausted'],['invalid','invalid_response'],['healthy','healthy']]){
   mode=next;await db.prepare('UPDATE monitor_ai_health SET checked_at=0').run();
   const result=await(await post('/api/line-oa/ai-self-test',{})).json();assert.equal(result.data.status,expected);
   assert(!JSON.stringify(result).includes('never leak'));
  }
  assert.equal(await countAlerts('ai_authentication_failed'),1);assert.equal(await countAlerts('ai_recovered'),1);
 });
 await check('rules identify points, shopping, identity and usability while ordinary content is not a fault',async()=>{
  for(const [text,category] of [['點數不能用','points'],['購物結帳很慢','shopping'],['新會員登入失敗','identity'],['系統操作不夠好','usability'],['請問茶會苦嗎','none']])assert.equal(detectFeedback(text).category,category);
  const redacted=redactForAi(uid+' 0912345678 me@example.com https://example.com/private');
  assert(!redacted.includes(uid));assert(!redacted.includes('0912345678'));assert(!redacted.includes('me@example.com'));
 });
 await check('webhook capture is idempotent and stores evidence without AI or customer reply',async()=>{
  const before=aiCalls.length;
  await Promise.all(Array.from({length:4},()=>post('/__capture',[event('complaint','點數不能用，購物也不順')])));
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM monitor_feedback').first()).n,1);
  assert.equal(await countAlerts('feedback_points'),1);assert.equal(aiCalls.length,before);assert.equal(lineCalls,0);
 });
 await check('analysis processes each durable event once under concurrency and never sends LINE',async()=>{
  mode='healthy';const before=aiCalls.length;
  await Promise.all(Array.from({length:4},()=>post('/__process',{})));
  assert.equal(aiCalls.length,before+1);assert.equal(lineCalls,0);assert.equal(await countAlerts('feedback_points'),1);
  const row=await db.prepare("SELECT * FROM monitor_feedback WHERE event_id='complaint'").first();assert.equal(row.analysis_state,'done');
 });
 await check('analysis failures keep original evidence and become review after bounded retries',async()=>{
  await post('/__capture',[event('failure','這樣每次都要找人幫忙')]);mode='auth';
  for(let i=0;i<3;i++){await db.prepare('UPDATE monitor_ai_health SET analysis_next_at=0').run();await db.prepare("UPDATE monitor_feedback SET next_attempt_at=0 WHERE event_id='failure'").run();await post('/__process',{});}
  const row=await db.prepare("SELECT * FROM monitor_feedback WHERE event_id='failure'").first();
  assert.equal(row.analysis_state,'review');assert.equal(row.message_text,'這樣每次都要找人幫忙');assert.equal(row.attempts,3);
  const before=aiCalls.length;await post('/__process',{});assert.equal(aiCalls.length,before);assert.equal(await countAlerts('ai_analysis_failed'),0);
 });
 await check('old and new missing completion stay in local review without owner alarms',async()=>{
  await post('/__tracking',{});assert.equal(await countAlerts('tracking_unresolved'),0);
  assert.equal((await db.prepare('SELECT state FROM crm_request_leases WHERE lease_id=?').bind(oldId).first()).state,'active');
  const id=randomUUID();await db.prepare("INSERT INTO crm_request_leases(lease_id,release,state,started_at) VALUES(?,'test','active','2026-01-01 00:00:00')").bind(id).run();
  await Promise.all([post('/__tracking',{}),post('/__tracking',{})]);await post('/__tracking',{});
  assert.equal(await countAlerts('tracking_unresolved'),0);
  assert.equal((await db.prepare('SELECT status FROM crm_request_reviews WHERE lease_id=?').bind(id).first()).status,'known_unresolved');
  await db.prepare("UPDATE crm_request_leases SET state='done',finished_at=CURRENT_TIMESTAMP WHERE lease_id=?").bind(id).run();
  await post('/__tracking',{});await post('/__tracking',{});assert.equal(await countAlerts('tracking_recovered'),0);
  assert.equal((await db.prepare('SELECT status FROM crm_request_reviews WHERE lease_id=?').bind(id).first()).status,'resolved');
 });
 await check('unknown free text and follow cannot reach mother or AI even with child-wallet flag absent',async()=>{
  const body=JSON.stringify({events:[event('real-webhook','點數又不同步了'),{type:'follow',source:{userId:uid},webhookEventId:'follow',replyToken:'NEVER'}]});
  const before=aiCalls.length;
  const res=await call('/line-webhook',{method:'POST',headers:{'x-line-signature':createHmac('sha256','synthetic-line').update(body).digest('base64')},body});
  assert.equal(res.status,200);assert.equal(aiCalls.length,before);assert.equal(lineCalls,0);
  assert(await db.prepare("SELECT event_id FROM monitor_feedback WHERE event_id='real-webhook'").first());
 });
 await check('admin can read original feedback and mark a review without touching ledger',async()=>{
  const result=await(await call('/api/line-oa/feedback',{headers:admin})).json();assert(result.data.some(x=>x.message_text.includes('點數')));
  assert.equal((await post('/api/line-oa/feedback',{eventId:'complaint',status:'resolved'})).status,200);
  assert.equal((await db.prepare("SELECT review_state FROM monitor_feedback WHERE event_id='complaint'").first()).review_state,'resolved');
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'crm_point_%'").first()).n,0);
 });
 await check('tracking has route and phase, no query credentials or member data',async()=>{
  await call('/api/line-oa/safety-status?credential=secret',{headers:admin});
  const rows=(await db.prepare('SELECT * FROM crm_request_metadata').all()).results;
  assert(rows.some(row=>row.operation==='monitor'&&row.phase==='finished'));
  assert(!JSON.stringify(rows).includes('credential'));assert(!JSON.stringify(rows).includes(uid));
 });
 await check('capture failure returns retryable webhook error before processing',async()=>{
  await db.prepare('DROP TABLE monitor_feedback').run();
  const body=JSON.stringify({events:[event('storage-down','點數錯了')]});
  const res=await call('/line-webhook',{method:'POST',headers:{'x-line-signature':createHmac('sha256','synthetic-line').update(body).digest('base64')},body});
  assert.equal(res.status,503);assert.equal(lineCalls,0);
 });
 console.log(`${count} monitor safety groups passed; isolated D1 and mocked network, no production mutations`);
} finally {await mf.dispose();}
