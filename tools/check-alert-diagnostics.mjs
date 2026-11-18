// Native workerd/D1 with fault injection. All identity, storage and Telegram data are synthetic.
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(process.env.WRANGLER_PACKAGE||import.meta.url);
const {Miniflare}=require('miniflare'),{build}=require('esbuild');
const root=new URL('../',import.meta.url);
const bundle=await build({stdin:{resolveDir:fileURLToPath(root),contents:`
import {enqueueAlert,drainAlerts,alertStatus} from './operational-alerts.js';
function faultyDB(db,mode){return {prepare(sql){
 const text=sql.trimStart();
 const stage=text.startsWith('SELECT alert_id FROM operational_alerts')?'queue_read':text.startsWith('INSERT INTO operational_alerts')?'queue_write':text.startsWith('UPDATE operational_alerts SET lease_token=')?'delivery_claim':text.startsWith('UPDATE operational_alerts SET sent_at=')?'delivery_state':text.startsWith('DELETE FROM operational_alerts')?'cleanup':'other';
 const wrap=stmt=>({bind(...args){return wrap(stmt.bind(...args));},
  async all(){fail();if(mode===stage+'_false')return {success:false,results:[]};return stmt.all();},
  async first(){fail();return stmt.first();},
  async run(){fail();if(mode===stage+'_zero')return {success:true,meta:{changes:0}};if(mode===stage+'_false')return {success:false};return stmt.run();}
 });
 function fail(){if(mode!==stage&&mode!==stage+'_unknown'&&mode!=='no_io')return;
  const e=new Error((mode.endsWith('_unknown')?'unclassified':'D1_ERROR: SQLITE_BUSY')+' synthetic-private-name-甲 synthetic-person@example.invalid 0912345678 https://example.invalid/?token=synthetic-secret U'+ 'a'.repeat(32));
  if(!mode.endsWith('_unknown'))e.code='SQLITE_BUSY';throw e;
 }
 return wrap(db.prepare(sql));
}};}
export default {async fetch(r,env){
 const u=new URL(r.url),mode=u.searchParams.get('mode')||'none';
 const scoped={...env,DB:faultyDB(env.DB,mode),...(u.pathname==='/disabled'?{HOOKTEA_TELEGRAM_ALERTS:'false'}:{})};
 if(u.searchParams.get('kv')==='fail')scoped.ACTION_DATA={get:async()=>{throw Error('SYNTHETIC_KV_FAILURE');},put:async()=>{throw Error('SYNTHETIC_KV_FAILURE');}};
 if(u.searchParams.get('kv')==='delivery_fail')scoped.ACTION_DATA={get:async(key,...args)=>{if(key.startsWith('HOOKTEA_ALERT_DIAGNOSTIC_DELIVERY_V1_'))throw Error('SYNTHETIC_DELIVERY_READ_FAILURE');return env.ACTION_DATA.get(key,...args);}};
 if(u.pathname==='/enqueue'||u.pathname==='/disabled')return Response.json(await enqueueAlert(scoped,await r.json()));
 if(u.pathname==='/drain'){await drainAlerts(scoped);return Response.json({ok:true});}
 if(u.pathname==='/status')return Response.json(await alertStatus(scoped));
 return new Response('synthetic endpoint only',{status:404});
}};`},bundle:true,write:false,format:'esm',platform:'browser'});
let network='ok';const telegram=[];
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-04-06',
 d1Databases:{DB:'diagnostics-test'},kvNamespaces:{ACTION_DATA:'diagnostics-test'},
 bindings:{HOOKTEA_TELEGRAM_ALERTS:'true',TELEGRAM_BOT_TOKEN:'synthetic-token',TELEGRAM_CHAT_ID:'synthetic-chat'},
 outboundService:async r=>{assert.equal(new URL(r.url).origin,'https://api.telegram.org');const body=await r.json();telegram.push(body);
  if(network==='reject')return Response.json({ok:false},{status:200});
  if(network==='network')throw Error('SYNTHETIC_NETWORK_FAILURE');
  return Response.json({ok:true});
 }});
let groups=0;const pass=name=>{groups++;console.log('PASS '+name);};
try{
 const db=await mf.getD1Database('DB'),kv=await mf.getKVNamespace('ACTION_DATA');
 const sql=readFileSync(new URL('migrations/0008_operational_alerts.sql',root),'utf8').replace(/^--.*$/gm,'');
 for(const statement of sql.split(';').map(v=>v.trim()).filter(Boolean))await db.prepare(statement).run();
 const call=async(path,body={})=>{const r=await mf.dispatchFetch('https://local.test'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
 const status=()=>call('/status');
 const input=(code='points_pending')=>({category:'points',code,route:'/line-webhook',traceId:'11111111-1111-4111-8111-111111111111'});
 const clearThrottle=async()=>{for(const {name} of (await kv.list({prefix:'TELEGRAM_ALERT_D1_OUTAGE_'})).keys)await kv.delete(name);};
 const latest=async stage=>(await status()).diagnostics.find(d=>d.stage===stage);

 await call('/drain');assert.equal(telegram.length,0);assert.deepEqual((await status()).diagnostics,[]);
 pass('healthy empty queue has no warning and no diagnostic writes');

 await call('/drain?mode=cleanup');assert.equal(telegram.length,0);
 let diag=await latest('cleanup');assert.equal(diag.code,'alert_cleanup_failed');assert.equal(diag.localOnly,true);assert.equal(diag.originalCode,'SQLITE_BUSY');assert.equal(diag.reason,'busy');
 assert.equal((await kv.get('HOOKTEA_ALERT_DIAGNOSTIC_V1_'+diag.id,'json')).id,diag.id);
 pass('cleanup-only failure retains independently queryable evidence and never claims storage outage');

 await call('/drain?mode=cleanup_false');assert.equal(telegram.length,0);assert.equal((await latest('cleanup')).code,'alert_cleanup_failed');
 pass('unsuccessful D1 cleanup result is retained even when no exception is thrown');

 await clearThrottle();await call('/drain?mode=queue_read');assert.equal(telegram.length,1);
 diag=await latest('queue_read');assert.equal(diag.notification,'accepted');
 assert(telegram.at(-1).text.includes('失敗步驟：讀取告警待送清單'));assert(telegram.at(-1).text.includes('觸發來源：cron'));
 assert(telegram.at(-1).text.includes('原始錯誤代碼：SQLITE_BUSY'));assert(!telegram.at(-1).text.includes('資料儲存服務異常'));
 await call('/drain?mode=queue_read');assert.equal(telegram.length,1);assert.equal((await latest('queue_read')).notification,'throttled');
 pass('queue read failure names the actual stage and cron source; existing KV throttle remains effective');

 await clearThrottle();const written=await call('/enqueue?mode=queue_write',input());
 assert.equal(written.error,'alert_queue_write_failed');assert.equal(written.notificationAccepted,true);
 diag=await latest('queue_write');assert.equal(diag.requestTrace,input().traceId);assert.equal(diag.route,'/line-webhook');
 assert(telegram.at(-1).text.includes('寫入告警佇列'));assert(telegram.at(-1).text.includes('觸發來源：/line-webhook'));
 pass('queue write failure retains the original request trace and accurate route without implying a global outage');

 await clearThrottle();const claimed=await call('/enqueue?mode=delivery_claim',input('points_failed'));
 assert.equal(claimed.error,'alert_delivery_claim_failed');assert.equal((await latest('delivery_claim')).route,'/line-webhook');
 assert(telegram.at(-1).text.includes('本次尚未呼叫 Telegram'));
 // The queued original notification is still pending; delivery of the diagnostic is a separate call.
 assert.equal((await db.prepare('SELECT sent_at FROM operational_alerts WHERE alert_id=?').bind(claimed.alertId).first()).sent_at,null);
 pass('delivery-claim failure is distinct from sending or recording a Telegram result');

 // Settle the preceding claim failure, then inject a post-send D1 failure on a new code.
 await db.prepare('UPDATE operational_alerts SET lease_until=0,next_attempt_at=0').run();await call('/drain');
 const before=telegram.length;
 const accepted=await call('/enqueue?mode=delivery_state',{category:'payment',code:'payment_failed',route:'/api'});
 assert.equal(accepted.error,'alert_delivery_state_failed');assert.equal(accepted.deliveryAccepted,true);assert.equal(telegram.length,before+1);
 diag=await latest('delivery_state');assert.equal(diag.deliveryAccepted,true);assert.equal(diag.localOnly,true);
 const receipt=await kv.get('HOOKTEA_ALERT_ACCEPTED_V1_'+accepted.alertId,'json');assert.equal(receipt.alertId,accepted.alertId);
 await db.prepare('UPDATE operational_alerts SET lease_until=0,next_attempt_at=0 WHERE alert_id=?').bind(accepted.alertId).run();
 await call('/drain');assert.equal(telegram.length,before+1);
 assert.equal((await db.prepare('SELECT sent_at FROM operational_alerts WHERE alert_id=?').bind(accepted.alertId).first()).sent_at,receipt.at);
 pass('post-send bookkeeping failure records acceptance and later repairs only outbox state without re-sending');

 const zero=await call('/enqueue?mode=delivery_state_zero',{category:'member',code:'identity_conflict',route:'/api'});
 assert.equal(zero.error,'alert_delivery_state_failed');assert.equal(zero.deliveryStateRecorded,false);assert.equal(zero.deliveryAccepted,true);
 pass('zero-row delivery update does not falsely claim the outbox result was recorded');

 await clearThrottle();network='reject';const rejected=await call('/enqueue?mode=queue_write',input());network='ok';
 assert.equal(rejected.notificationAccepted,false);assert.equal(rejected.notificationError,'telegram_rejected');assert.equal((await latest('queue_write')).notification,'telegram_rejected');
 pass('Telegram HTTP 200 with ok:false is retained as rejection, never accepted delivery');

 const previous=telegram.length;const unavailable=await call('/enqueue?mode=queue_write&kv=fail',input());
 assert.equal(unavailable.error,'alert_queue_write_failed');assert.equal(unavailable.notificationError,'fallback_unavailable');assert.equal(telegram.length,previous);
 pass('simultaneous D1 and KV failure remains non-throwing and does not invent retained evidence or delivery');

 await call('/drain?mode=cleanup_unknown');diag=await latest('cleanup');assert.equal(diag.originalCode,'UNCLASSIFIED');assert.equal(diag.reason,'unknown');
 assert.match(diag.fingerprint,/^[a-f0-9]{64}$/);
 const all=[];for(const {name} of (await kv.list({prefix:'HOOKTEA_ALERT_'})).keys)all.push(await kv.get(name));
 const text=JSON.stringify([all,telegram,await status()]);
 for(const secret of ['synthetic-private-name','synthetic-person@example.invalid','0912345678','synthetic-secret','U'+'a'.repeat(32)])assert(!text.includes(secret),secret);
 pass('exception text, personal data, credentials and URLs never appear in retained diagnostics or notifications');

 const readFailed=await call('/status?mode=no_io');assert.equal(readFailed.countsAvailable,false);assert.equal(readFailed.countsError.originalCode,'SQLITE_BUSY');assert(readFailed.diagnostics.length>0);assert.equal(readFailed.pending,undefined);
 pass('status preserves KV diagnostics when D1 counts cannot be read, without inventing zero pending errors');

 const partial=await call('/status?kv=delivery_fail');assert(partial.diagnostics.length>0);
 assert(partial.diagnostics.some(d=>d.stage==='queue_read'&&d.notification==='unrecorded'));
 assert(partial.diagnostics.every(d=>typeof d.reasonSummary==='string'));
 await kv.put('HOOKTEA_ALERT_DIAGNOSTIC_LATEST_V1_cleanup',JSON.stringify({id:'11111111-1111-4111-8111-111111111111',stage:'__proto__'}));
 assert(!(await status()).diagnostics.some(d=>d.stage==='__proto__'));
 pass('partial delivery-evidence read failure retains the original diagnosis; corrupt enum values are discarded');

 const disabled=await call('/disabled?mode=no_io',input());assert.equal(disabled.enabled,false);assert.equal(telegram.length,previous);
 pass('disabled alerts remain disabled and do not invoke the failure path');

 console.log(groups+' native alert-diagnostic groups passed; local D1/KV and mocked network only');
}finally{await mf.dispose();}
