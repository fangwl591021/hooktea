import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(process.env.WRANGLER_PACKAGE||import.meta.url);
const {Miniflare}=require('miniflare'),{build}=require('esbuild');
const root=new URL('../',import.meta.url);
const bundle=await build({stdin:{resolveDir:fileURLToPath(root),contents:`
import worker from './tracked-worker.js';
import {trackCrmRequest} from './crm-write-tracker.js';
export default {async fetch(request,env,ctx){
 const p=new URL(request.url).pathname;
 if(!p.startsWith('/__synthetic/'))return worker.fetch(request,env,ctx);
 const db=p.endsWith('/finish-fail')?{prepare(sql){if(sql.startsWith('UPDATE'))throw Error('synthetic bookkeeping failure');return env.DB.prepare(sql);}}:env.DB;
 return trackCrmRequest({db,ctx,run:async c=>{
   if(p.endsWith('/background'))c.waitUntil((async()=>{await new Promise(r=>setTimeout(r,100));c.waitUntil((async()=>{await new Promise(r=>setTimeout(r,100));await env.DB.prepare('INSERT INTO synthetic_effects VALUES(1)').run();})());})());
   if(p.endsWith('/failure'))c.waitUntil(Promise.reject(Error('synthetic failure')));
   if(p.endsWith('/throw'))throw Error('synthetic handler failure');
   if(p.endsWith('/server-error'))return new Response('failed',{status:500});
   return new Response('accepted');
 }});
}};`},bundle:true,write:false,format:'esm',platform:'browser'});
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-04-06',
  d1Databases:{DB:'isolated-tracking'},r2Buckets:{'act-image':'isolated-tracking'},kvNamespaces:{ACTION_DATA:'isolated-tracking'},
  outboundService:()=>{throw Error('NO_EXTERNAL_NETWORK');}});
let checks=0;const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
try{
 const db=await mf.getD1Database('DB');
 const call=(p,options)=>mf.dispatchFetch('https://test.invalid'+p,options);
 await check('health and CORS work without tracking schema; dynamic requests fail closed',async()=>{
  assert.equal((await call('/api/health')).status,200);
  assert.equal((await call('/',{method:'OPTIONS'})).status,200);
  const r=await call('/__synthetic/plain');assert.equal(r.status,503);assert.equal((await r.json()).code,'CRM_REQUEST_TRACKING_UNAVAILABLE');
 });
 const sql=readFileSync(new URL('migrations/0006_crm_write_tracking.sql',root),'utf8').replace(/^--.*$/gm,'').trim();
 // Keep complete CREATE TRIGGER ... BEGIN ... END statements intact.
 for(const s of sql.split(/;\s*(?=CREATE\s|INSERT\s)/).map(s=>s.trim()).filter(Boolean))await db.prepare(s).run();
 await db.prepare('CREATE TABLE synthetic_effects(value INTEGER)').run();
 const rows=async()=> (await db.prepare('SELECT * FROM crm_request_leases').all()).results;
 const settle=async(predicate)=>{for(let i=0;i<80;i++){const r=await rows();if(predicate(r))return r;await new Promise(r=>setTimeout(r,25));}throw Error('LOCAL_TEST_DRAIN_TIMEOUT');};
 const pause=()=>db.prepare("UPDATE crm_request_control SET mode='paused',actor_id='synthetic-test',reason='test only'").run();
 const resume=()=>db.prepare("UPDATE crm_request_control SET mode='observe',actor_id='synthetic-test',reason='test only'").run();
 await check('default observe admits requests and health creates no lease',async()=>{
  assert.equal((await db.prepare('SELECT mode FROM crm_request_control').first()).mode,'observe');
  await call('/api/health');assert.equal((await rows()).length,0);
  assert.equal((await call('/__synthetic/plain')).status,200);await settle(r=>r.length===1&&r[0].state==='done');
 });
 await check('pause blocks real webhook, checkout and GET payment callbacks before their handlers',async()=>{
  await pause();const before=(await rows()).length;
  for(const [p,method] of [['/line-webhook','POST'],['/api/huaxu/orders','POST'],['/linepay/confirm?orderId=synthetic','GET'],['/linepay/cancel?orderId=synthetic','GET']]){
   const r=await call(p,{method});assert.equal(r.status,503);assert.equal((await r.json()).code,'CRM_REQUESTS_PAUSED');
  }
  assert.equal((await rows()).length,before);assert.equal((await call('/api/health')).status,200);await resume();
 });
 await check('nested background work stays active until both levels settle',async()=>{
  assert.equal((await call('/__synthetic/background')).status,200);await pause();
  assert((await rows()).some(r=>r.state==='active'));
  await settle(r=>r.every(x=>x.state==='done'));
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM synthetic_effects').first()).n,1);await resume();
 });
 await check('parallel requests create independent completed leases',async()=>{
  const before=(await rows()).length;
  assert((await Promise.all(Array.from({length:20},()=>call('/__synthetic/plain')))).every(r=>r.status===200));
  await settle(r=>r.length===before+20&&r.every(x=>x.state==='done'));
 });
 await check('background rejection and server errors retain uncertain records',async()=>{
  await call('/__synthetic/failure');assert.equal((await call('/__synthetic/server-error')).status,500);
  await settle(r=>r.filter(x=>x.state==='uncertain').length===2);
  await assert.rejects(db.prepare("UPDATE crm_request_leases SET state='done' WHERE state='uncertain'").run(),/TRANSITION_INVALID/);
 });
 await check('bookkeeping failure preserves successful response and leaves active evidence',async()=>{
  assert.equal((await call('/__synthetic/finish-fail')).status,200);
  await settle(r=>r.some(x=>x.state==='active'));
 });
 await check('ordinary anonymous CRM/shop authorization remains enforced in observe mode',async()=>{
  assert.equal((await call('/api/huaxu/member',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  assert.equal((await call('/api/huaxu/orders')).status,401);
 });
 await check('control changes are audited and have no point-account schema',async()=>{
  const events=(await db.prepare('SELECT * FROM crm_request_control_events').all()).results;
  assert.equal(events.length,4);assert(events.every(e=>e.actor_id==='synthetic-test'));
  const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'crm_point_%'").all()).results;
  assert.equal(tables.length,0);
  await assert.rejects(db.prepare("UPDATE crm_request_control SET mode='child'").run());
 });
 console.log(checks+' actual workerd+D1 tracking groups passed; isolated storage, no production or external calls');
}finally{await mf.dispose();}
