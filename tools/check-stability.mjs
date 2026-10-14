// Real operational SQL/functions with isolated SQLite. No remote bindings or real network.
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {captureMonitorEvents,processMonitorFeedback,markThreadFeedbackHandled} from '../monitor-safety.js';
import {drainAlerts} from '../operational-alerts.js';
import {recordCommandResult,reconcileCommands,commandStatus} from '../command-completion.js';
import {trackCrmRequest} from '../crm-write-tracker.js';
const native=new DatabaseSync(':memory:');
const root=new URL('../',import.meta.url);
for(const file of ['0001_line_monitor.sql','0006_crm_write_tracking.sql','0008_operational_alerts.sql','0011_monitor_safety.sql','0012_command_completion.sql'])native.exec(fs.readFileSync(new URL('migrations/'+file,root),'utf8'));
native.exec('CREATE TABLE child_point_ledger(operation_id TEXT PRIMARY KEY,amount INTEGER); CREATE TABLE point_operations(operation_id TEXT PRIMARY KEY,status TEXT,amount INTEGER);');
const db={prepare(sql){return {bind(...values){return statement(sql,values);},...statement(sql,[])};},async batch(statements){native.exec('BEGIN');try{const rows=[];for(const s of statements)rows.push(await s.all());native.exec('COMMIT');return rows;}catch(e){native.exec('ROLLBACK');throw e;}}};
function statement(sql,values){return {
 async first(){return native.prepare(sql).get(...values)||null;},
 async run(){const r=native.prepare(sql).run(...values);return {success:true,meta:{changes:Number(r.changes)}};},
 async all(){if(/^\s*(SELECT|PRAGMA)\b|\bRETURNING\b/i.test(sql))return {success:true,results:native.prepare(sql).all(...values),meta:{changes:0}};
  const r=native.prepare(sql).run(...values);return {success:true,results:[],meta:{changes:Number(r.changes)}};}
};}
let clock=1791936000,index=0,passed=0;const realNow=Date.now,realFetch=globalThis.fetch;
Date.now=()=>clock*1000;
const settings={shop_keyword_reward_enabled:'true',shop_keyword_reward_points:100,shop_keyword_reward_keywords:'954e'};
const env={DB:db,HOOKTEA_MONITOR_SAFETY:'true',HOOKTEA_DAILY_SIGNIN_POINTS:'1',HOOKTEA_REQUEST_TRACE_ID:'00000000-0000-4000-8000-000000000001',HOOKTEA_TELEGRAM_ALERTS:'true',TELEGRAM_BOT_TOKEN:'synthetic-only',TELEGRAM_CHAT_ID:'synthetic',ACTION_DATA:{get:async key=>JSON.stringify(key==='SYSTEM_SETTINGS'?settings:{})}};
const sent=[];globalThis.fetch=async(url,init)=>{assert.equal(new URL(url).hostname,'api.telegram.org');sent.push(JSON.parse(init.body).text);return Response.json({ok:true});};
const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
function event(text='請問怎麼登入？'){
 const n=++index,uid='U'+n.toString(16).padStart(32,'0'),id='synthetic-'+n;
 native.prepare("INSERT INTO line_threads(id,source_user_id,display_name,status) VALUES(?,?,?,'open')").run('thread-'+n,uid,'Synthetic customer '+n);
 return {type:'message',timestamp:clock*1000,webhookEventId:id,source:{userId:uid},message:{id,type:'text',text}};
}
const capture=async e=>{await captureMonitorEvents(env,[e]);return native.prepare('SELECT * FROM monitor_feedback WHERE event_id=?').get(e.webhookEventId);};
const execution=e=>native.prepare('SELECT * FROM monitor_command_executions WHERE event_id=?').get(e.webhookEventId);
const countAlerts=()=>native.prepare('SELECT COUNT(*) n FROM operational_alerts').get().n;
try{
 await test('new questions persist a ten-minute deadline and cannot send at 599 seconds',async()=>{
  const e=event(),f=await capture(e),before=sent.length;assert.equal(f.notification_due_at,clock+600);
  await drainAlerts(env);clock+=599;await drainAlerts(env);assert.equal(sent.length,before);
  clock++;await drainAlerts(env);assert.equal(sent.length,before+1);assert(sent.at(-1).includes('Synthetic customer'));assert(sent.at(-1).includes(e.message.text));
  assert(sent.at(-1).includes('10 分鐘'));assert(!sent.at(-1).includes(e.source.userId));
  await drainAlerts(env);assert.equal(sent.length,before+1);
 });
 await test('late classification uses the original question deadline, not another ten-minute wait',async()=>{
  native.exec("UPDATE monitor_feedback SET analysis_state='done'");const e=event('Synthetic information request');await capture(e);clock+=601;
  env.OPENAI_API_KEY='synthetic';const saved=globalThis.fetch;
  globalThis.fetch=async(url,init)=>new URL(url).hostname==='api.openai.com'?Response.json({status:'completed',output:[{content:[{type:'output_text',text:'{"category":"feedback","severity":"medium"}'}]}]}):saved(url,init);
  try{await processMonitorFeedback(env);}finally{globalThis.fetch=saved;delete env.OPENAI_API_KEY;}
  const f=native.prepare('SELECT trace_id FROM monitor_feedback WHERE event_id=?').get(e.webhookEventId);
  assert.equal(native.prepare('SELECT next_attempt_at FROM operational_alerts WHERE trace_id=?').get(f.trace_id).next_attempt_at,clock);
  const before=sent.length;await drainAlerts(env);assert.equal(sent.length,before+1);
 });
 for(const state of ['acknowledged','resolved'])await test(state+' feedback suppresses notification',async()=>{
  const e=event();await capture(e);native.prepare('UPDATE monitor_feedback SET review_state=? WHERE event_id=?').run(state,e.webhookEventId);
  const before=sent.length;clock+=601;await drainAlerts(env);assert.equal(sent.length,before);
 });
 for(const state of ['pending','closed'])await test(state+' conversation suppresses notification',async()=>{
  const e=event();await capture(e);native.prepare('UPDATE line_threads SET status=? WHERE source_user_id=?').run(state,e.source.userId);
  await markThreadFeedbackHandled(env,e.source.userId,state);
  const before=sent.length;clock+=601;await drainAlerts(env);assert.equal(sent.length,before);
 });
 await test('new question after an earlier thread closure is still eligible for its own reminder',async()=>{
  const e=event();await capture(e);native.prepare("UPDATE line_threads SET status='closed' WHERE source_user_id=?").run(e.source.userId);await markThreadFeedbackHandled(env,e.source.userId,'closed');
  clock++;const later={...e,webhookEventId:e.webhookEventId+'-later',timestamp:clock*1000,message:{...e.message,id:e.webhookEventId+'-later'}};
  await capture(later);const before=sent.length;clock+=601;await drainAlerts(env);assert.equal(sent.length,before+1);
 });
 for(const confirmed of [false,true])await test((confirmed?'confirmed staff reply':'draft only')+' is distinguished',async()=>{
  const e=event();await capture(e);const t=native.prepare('SELECT id FROM line_threads WHERE source_user_id=?').get(e.source.userId);
  native.prepare("INSERT INTO line_messages(id,thread_id,sender_role,message_text,raw_json,created_at) VALUES(?,?,'staff','synthetic answer',?,?)").run(e.webhookEventId,t.id,JSON.stringify({deliveryConfirmed:confirmed}),new Date(clock*1000).toISOString());
  const before=sent.length;clock+=601;await drainAlerts(env);assert.equal(sent.length,before+(confirmed?0:1));
 });
 await test('legacy rows are not automatically replayed by the new notification policy',async()=>{
  const e=event(),f=await capture(e);native.prepare("UPDATE monitor_feedback SET notification_policy='',notification_due_at=0 WHERE event_id=?").run(e.webhookEventId);
  const before=sent.length;clock+=601;await drainAlerts(env);assert.equal(sent.length,before);
  assert.equal(native.prepare('SELECT last_error FROM operational_alerts WHERE trace_id=?').get(f.trace_id).last_error,'feedback_legacy_review');
 });
 await test('configured command capture is durable and redelivery cannot create duplicate records',async()=>{
  const e=event(' ９５４ｅ '),before=countAlerts();await capture(e);await capture(e);
  const c=execution(e);assert.equal(c.expected_points,100);assert.equal(c.kind,'keyword_reward');assert.equal(c.request_trace,env.HOOKTEA_REQUEST_TRACE_ID);
  assert.equal(native.prepare('SELECT COUNT(*) n FROM monitor_command_executions WHERE event_id=?').get(e.webhookEventId).n,1);assert.equal(countAlerts(),before);
 });
 await test('paused reward is recorded as a command but not a reward execution or complaint',async()=>{
  settings.shop_keyword_reward_enabled='false';const e=event('954e'),before=countAlerts();await capture(e);
  assert.equal(execution(e),undefined);assert.equal(countAlerts(),before);settings.shop_keyword_reward_enabled='true';
 });
 await test('daily command expected amount respects the production points flag',async()=>{
  const e=event('虎克茶簽到贈點');await capture(e);assert.equal(execution(e).expected_points,1);
 });
 await test('owner priority prevents overlapping reserved commands creating fake reward records',async()=>{
  const original=settings.shop_keyword_reward_keywords;settings.shop_keyword_reward_keywords='會員專區,會員註冊,會員打卡,虎克茶簽到贈點';
  for(const text of ['會員專區','會員註冊','會員打卡']){const e=event(text);await capture(e);assert.equal(execution(e),undefined);}
  const e=event('虎克茶簽到贈點');await capture(e);assert.equal(execution(e).kind,'daily_signin');assert.equal(execution(e).expected_points,1);
  settings.shop_keyword_reward_keywords=original;
 });
 await test('unfinished execution is local review only; reconciliation never adds points',async()=>{
  const e=event('954e');await capture(e);const before=countAlerts();clock+=601;await reconcileCommands(env);
  assert.equal(execution(e).state,'review');assert.equal(countAlerts(),before);assert.equal(native.prepare('SELECT COUNT(*) n FROM child_point_ledger').get().n,0);
 });
 await test('exact receipt confirms credit after interruption without replaying the claim',async()=>{
  const e=event('954e');await capture(e);const c=execution(e);native.prepare('INSERT INTO child_point_ledger VALUES(?,100)').run(c.operation_id);
  clock+=601;await reconcileCommands(env);assert.equal(execution(e).state,'credited');assert.equal(execution(e).reply_state,'unknown');
 });
 await test('wrong receipt amount cannot certify a credit',async()=>{
  const e=event('954e');await capture(e);native.prepare('INSERT INTO child_point_ledger VALUES(?,99)').run(execution(e).operation_id);
  clock+=601;await reconcileCommands(env);assert.equal(execution(e).state,'review');
 });
 await test('claim amount drifting from the captured configuration stays in local review',async()=>{
  const e=event('954e');await capture(e);await recordCommandResult(env,e.webhookEventId,{ok:true,amount:200},{ok:true});
  assert.equal(execution(e).state,'review');assert.equal(execution(e).review_reason,'AMOUNT_MISMATCH');
 });
 await test('historical duplicate claim is not displayed as a new reward',async()=>{
  const e=event('954e');await capture(e);await recordCommandResult(env,e.webhookEventId,{ok:true,amount:50,duplicate:true},{ok:true});
  assert.equal(execution(e).state,'credited');assert.equal(execution(e).review_reason,'ALREADY_CLAIMED');
 });
 await test('ambiguous LINE failure stays local, even when credit is confirmed',async()=>{
  const e=event('954e');await capture(e);native.prepare('INSERT INTO child_point_ledger VALUES(?,100)').run(execution(e).operation_id);
  await recordCommandResult(env,e.webhookEventId,{ok:true,status:'confirmed'},{ok:false,status:429,ambiguous:true});
  const before=countAlerts();await reconcileCommands(env);assert.equal(countAlerts(),before);assert.equal(execution(e).reply_state,'unknown');
 });
 await test('explicit rejected reply with verified credit creates one clear named alert, never another credit',async()=>{
  const e=event('954e');await capture(e);native.prepare('INSERT INTO child_point_ledger VALUES(?,100)').run(execution(e).operation_id);
  await recordCommandResult(env,e.webhookEventId,{ok:true,status:'confirmed'},{ok:false,status:400,ambiguous:false});
  const before=countAlerts();await reconcileCommands(env);await reconcileCommands(env);assert.equal(countAlerts(),before+1);
  const sendBefore=sent.length;await drainAlerts(env);assert.equal(sent.length,sendBefore+1);assert(sent.at(-1).includes('不要再次加點'));assert(sent.at(-1).includes('Synthetic customer'));
 });
 await test('later successful reply prevents an old queued failure alert being sent',async()=>{
  const e=event('954e');await capture(e);native.prepare('INSERT INTO child_point_ledger VALUES(?,100)').run(execution(e).operation_id);
  await recordCommandResult(env,e.webhookEventId,{ok:true},{ok:false,status:400});await reconcileCommands(env);
  await recordCommandResult(env,e.webhookEventId,{ok:true},{ok:true});const before=sent.length;await drainAlerts(env);assert.equal(sent.length,before);
 });
 await test('successful result cannot be downgraded by a later rejection',async()=>{
  const e=event('954e');await capture(e);await recordCommandResult(env,e.webhookEventId,{ok:true},{ok:true});
  await recordCommandResult(env,e.webhookEventId,{status:'rejected'},{ok:false,status:400});assert.equal(execution(e).state,'credited');assert.equal(execution(e).reply_state,'sent');
  assert.equal(execution(e).result_code,'');assert.equal(execution(e).review_reason,'');
 });
 await test('a rejected transaction needs an exact receipt and names before owner notification',async()=>{
  const e=event('954e');await capture(e);native.prepare("INSERT INTO point_operations VALUES(?,'rejected',100)").run(execution(e).operation_id);
  await recordCommandResult(env,e.webhookEventId,{status:'rejected'},{ok:true});const before=sent.length;
  await reconcileCommands(env);await drainAlerts(env);assert.equal(sent.length,before+1);assert(sent.at(-1).includes('拒絕紀錄'));
 });
 await test('wrong-amount rejection is not promoted to a customer incident',async()=>{
  const e=event('954e');await capture(e);native.prepare("INSERT INTO point_operations VALUES(?,'rejected',99)").run(execution(e).operation_id);
  await recordCommandResult(env,e.webhookEventId,{status:'rejected'},{ok:true});const before=countAlerts();await reconcileCommands(env);assert.equal(countAlerts(),before);
 });
 await test('bounded reconciliation makes progress beyond the newest 25 records',async()=>{
  for(let i=0;i<31;i++)await capture(event('954e'));
  clock+=601;await reconcileCommands(env);await reconcileCommands(env);
  assert.equal(native.prepare("SELECT COUNT(*) n FROM monitor_command_executions WHERE state='review' AND next_check_at=0").get().n,0);
 });
 await test('administrator status reports names and keeps credit/reply evidence separate',async()=>{
  const status=await commandStatus(env);assert(status.rows.some(r=>r.display_name.startsWith('Synthetic customer')));assert(!JSON.stringify(status).includes('replyToken'));
 });
 await test('non-business diagnostic hang does not keep a completed request active',async()=>{
  let release;const gate=new Promise(r=>release=r),pending=[];
  const r=await trackCrmRequest({db,ctx:{waitUntil:p=>pending.push(p)},id:'synthetic-track',metadata:{route:'static',method:'GET',operation:'page_view'},run:async c=>{c.deferDiagnostic(gate);return new Response('ok');}});
  assert.equal(r.status,200);assert.equal(native.prepare("SELECT state FROM crm_request_leases WHERE lease_id='synthetic-track'").get().state,'done');release();await Promise.all(pending);
 });
 console.log(passed+'/'+passed+' stability checks passed (isolated SQLite; no production writes or notifications).');
}finally{Date.now=realNow;globalThis.fetch=realFetch;native.close();}
