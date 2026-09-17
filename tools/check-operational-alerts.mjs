import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHmac} from 'node:crypto';
import assert from 'node:assert/strict';
const require=createRequire(process.env.WRANGLER_PACKAGE||import.meta.url);
const {Miniflare}=require('miniflare'),{build}=require('esbuild');
const root=new URL('../',import.meta.url);
const bundle=await build({stdin:{resolveDir:fileURLToPath(root),contents:`
import worker from './tracked-worker.js';
import {enqueueAlert,drainAlerts,observePointService,inspectAlertResponse,durableAlertStatement,alertStatus} from './operational-alerts.js';
export default {async fetch(r,env,ctx){
 const p=new URL(r.url).pathname;
 if(p==='/__alert')return Response.json(await enqueueAlert(env,await r.json()));
 if(p==='/__drain-now'){await drainAlerts(env);return Response.json(await alertStatus(env));}
 if(p==='/__local-only'){
   const {code}=await r.json();
   await env.DB.batch([durableAlertStatement(env,'suppressed:'+code,'tracking',code,crypto.randomUUID())]);
   return new Response('ok');
 }
 if(p==='/__drain'){await worker.scheduled({},env,ctx);return new Response('ok');}
 if(p==='/__points'){
   const calls=[];const e={HOOKTEA_REPORT_ISSUE:i=>calls.push(i)};
   const s=observePointService({submit:async()=>({pending:true}),read:async()=>({available:false}),
     enroll:async()=>{throw Error('secret uid123');}},e);
   await s.submit();await s.read();try{await s.enroll();}catch{}
   return Response.json(calls);
 }
 if(p==='/__response'){
   const calls=[];await inspectAlertResponse(Response.json(await r.json()),i=>calls.push(i));return Response.json(calls);
 }
 return worker.fetch(r,env,ctx);
}};`},bundle:true,write:false,format:'esm',platform:'browser'});
let mode='ok',lineMode='ok';const telegram=[];
const uid='U'+'a'.repeat(32);
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-04-06',
 d1Databases:{DB:'alerts-test'},kvNamespaces:{ACTION_DATA:'alerts-test'},r2Buckets:{'act-image':'alerts-test'},
 bindings:{HOOKTEA_TELEGRAM_ALERTS:'true',HOOKTEA_NEW_MEMBER_CHILD_POINTS:'true',ADMIN_PASSWORD:'synthetic-admin',
   LINE_CHANNEL_SECRET:'synthetic-line-secret',LINE_CHANNEL_ACCESS_TOKEN:'synthetic-line-token'},
 outboundService:async r=>{
   const u=new URL(r.url);
   if(u.origin==='https://api.telegram.org'){
     telegram.push(await r.json());
     if(mode==='network')throw Error('secret-token-in-error');
     if(mode==='false-ok')return Response.json({ok:false,description:'secret chat'});
     if(mode==='429')return Response.json({ok:false,parameters:{retry_after:200}},{status:429});
     return Response.json({ok:true,result:{chat:{id:'sensitive-chat'}}});
   }
   if(u.origin==='https://api.line.me') {
     if(u.pathname.startsWith('/v2/bot/profile/'))return Response.json({userId:uid,displayName:'synthetic'});
     if(u.pathname==='/v2/bot/message/reply')return new Response('{}',{status:lineMode==='ok'?200:500});
   }
   throw Error('EXTERNAL_NETWORK_FORBIDDEN');
 }});
let groups=0;const pass=name=>{groups++;console.log('PASS '+name);};
try {
 const db=await mf.getD1Database('DB'),kv=await mf.getKVNamespace('ACTION_DATA');
 for(const file of readdirSync(new URL('migrations/',root)).filter(f=>/^000[1-8]_.*\.sql$/.test(f)).sort()){
  const sql=readFileSync(new URL('migrations/'+file,root),'utf8').replace(/^--.*$/gm,'').trim();
  for(const statement of sql.split(/;\s*(?=CREATE\s|INSERT\s)/).map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
 }
 await kv.put('SYSTEM_SETTINGS',JSON.stringify({telegram_bot_token:'123:synthetic',telegram_chat_id:'synthetic-chat',shop_module:'huaxu'}));
 await kv.put('USERS_INDEX','[]');
 const call=(p,body={})=>mf.dispatchFetch('https://local.test'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const alert=async(category,code)=> (await call('/__alert',{category,code,route:'/api'})).json();
 const rows=async()=> (await db.prepare('SELECT * FROM operational_alerts').all()).results;
 const until=async fn=>{for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('LOCAL_WAIT_TIMEOUT');};
 await Promise.all(Array.from({length:20},()=>alert('points','points_pending')));
 assert.equal(telegram.length,1);assert.equal((await rows())[0].occurrences,20);assert((await rows())[0].sent_at);
 pass('20 concurrent identical errors create one delivery and count all occurrences');
 await call('/__alert',{category:'secret-member',code:'token-secret',route:'/api?phone=0912345678',traceId:uid,body:'private-chat'});
 assert.equal(telegram.length,2);assert(!JSON.stringify(telegram).includes(uid));assert(!JSON.stringify(telegram).includes('0912345678'));
 assert(!JSON.stringify(await rows()).includes('private-chat'));pass('allowlist removes identifiers, query strings, bodies and unknown error text');
 mode='false-ok';const failed=await alert('payment','payment_failed');assert.equal(failed.ok,false);
 let row=(await rows()).find(x=>x.category==='payment');assert.equal(row.sent_at,null);assert.equal(row.last_error,'telegram_rejected');
 mode='ok';await db.prepare('UPDATE operational_alerts SET next_attempt_at=0 WHERE alert_id=?').bind(row.alert_id).run();
 await call('/__drain');await until(async()=>(await rows()).find(x=>x.alert_id===row.alert_id).sent_at);
 pass('HTTP 200 with Telegram ok:false stays pending; real scheduled handler retries successfully');
 mode='429';await alert('line','line_reply_failed');row=(await rows()).find(x=>x.category==='line');
 assert(row.next_attempt_at-row.created_at>=200);assert.equal(row.last_error,'telegram_rate_limited');mode='ok';
 pass('Telegram retry_after is respected without blocking customer requests');
 const points=await (await call('/__points')).json();assert.deepEqual(points.map(x=>x.code),['points_pending','points_unavailable','enrollment_failed']);
 assert.equal((await (await call('/__response',{status:'error',message:'Admin authorization required'})).json()).length,0);
 assert.equal((await (await call('/__response',{status:'error',message:'unavailable with secret text'})).json())[0].code,'internal_error');
 pass('point result observers and legacy HTTP-200 errors alert; expected authorization failures do not');
 const denied=await (await call('/',{action:'ADMIN_TEST_TELEGRAM_ALERT',payload:{}})).json();assert.equal(denied.status,'error');
 const test=await (await call('/',{action:'ADMIN_TEST_TELEGRAM_ALERT',payload:{adminPassword:'synthetic-admin'}})).json();
 assert.equal(test.status,'success');assert.equal(test.data.ok,true);
 const status=await (await call('/',{action:'ADMIN_GET_ALERT_STATUS',payload:{adminPassword:'synthetic-admin'}})).json();
 assert.equal(status.data.configured,true);assert(!JSON.stringify(status).includes('123:synthetic'));
 pass('admin-only test/status routes use existing settings without disclosing credentials');
 lineMode='fail';
 const event=JSON.stringify({events:[{type:'message',replyToken:'synthetic',source:{type:'user',userId:uid},message:{type:'text',text:'會員專區'}}]});
 const response=await mf.dispatchFetch('https://local.test/line-webhook',{method:'POST',body:event,headers:{
  'x-line-signature':createHmac('sha256','synthetic-line-secret').update(event).digest('base64')}});
 assert.equal(response.status,200);await response.text();
 await until(async()=>(await rows()).some(x=>x.category==='line'&&x.route==='/line-webhook'));
 assert.equal((await db.prepare('SELECT balance FROM child_point_wallets WHERE line_uid=?').bind(uid).first()).balance,0);
 pass('signed real webhook with failed LINE reply emits alert without changing new-member points');
 {
  // Settle the preceding webhook's background deliveries. Its unrelated 429
  // case must remain pending; suppressing tracking must not erase real errors.
  await until(async()=>{const items=(await rows()).filter(x=>x.category==='line'&&x.route==='/line-webhook');return items.length===2&&items.every(x=>x.sent_at);});
  const before=telegram.length;
  const pendingBefore=(await rows()).filter(x=>x.sent_at===null).length;
  const localOnlyCodes=['tracking_unresolved','tracking_recovered','ai_analysis_failed','ai_analysis_recovered'];
  for(const code of localOnlyCodes){
   assert.equal((await alert('tracking',code)).suppressed,true);
   await call('/__local-only',{code});
   assert.equal((await rows()).filter(r=>r.code===code).length,0);
   await db.prepare(`INSERT INTO operational_alerts(alert_id,fingerprint,category,code,route,trace_id,created_at,updated_at,next_attempt_at)
     VALUES(?,?,'tracking',?,'cron','synthetic-trace',0,0,0)`).bind('old:'+code,'old:'+code,code).run();
  }
  const status=await(await call('/__drain-now')).json();
  await call('/__drain-now');
  assert.equal(telegram.length,before);assert.equal(status.localOnly,4);assert.equal(status.pending,pendingBefore);
  for(const row of (await rows()).filter(r=>localOnlyCodes.includes(r.code))){assert.equal(row.sent_at,null);assert.equal(row.attempts,0);}
  pass('inconclusive tracking and AI analysis stay silent across direct, durable and old queued paths without claiming delivery');
 }
 await db.prepare('DROP TABLE operational_alerts').run();
 const before=telegram.length;await alert('points','points_failed');await alert('points','points_failed');
 assert.equal(telegram.length,before+1);assert(telegram.at(-1).text.includes('storage_failed'));
 pass('alert D1 outage uses independent KV-throttled Telegram fallback');
 console.log(groups+' actual workerd alert groups passed; no real Telegram/customer calls');
}finally{await mf.dispose();}
