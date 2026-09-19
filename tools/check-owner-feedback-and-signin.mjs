import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const require=createRequire(process.env.WRANGLER_PACKAGE||import.meta.url);
const {Miniflare}=require('miniflare'),{build}=require('esbuild');
const root=new URL('../',import.meta.url),uid='U'+'a'.repeat(32);
const bundle=await build({stdin:{resolveDir:fileURLToPath(root),contents:`
import {drainAlerts,durableAlertStatement} from './operational-alerts.js';
import {captureMonitorEvents,processMonitorFeedback} from './monitor-safety.js';
export default {async fetch(r,env){
 if(new URL(r.url).pathname==='/capture')await captureMonitorEvents(env,await r.json());
 else if(new URL(r.url).pathname==='/process')await processMonitorFeedback(env);
 else await drainAlerts(env);
 return new Response('ok');
}};`},bundle:true,write:false,format:'esm',platform:'browser'});
const telegram=[];
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-04-06',
 d1Databases:{DB:'feedback-isolated'},kvNamespaces:{ACTION_DATA:'feedback-isolated'},
 bindings:{HOOKTEA_TELEGRAM_ALERTS:'true',TELEGRAM_BOT_TOKEN:'synthetic',TELEGRAM_CHAT_ID:'synthetic'},
 outboundService:async r=>{assert.equal(new URL(r.url).origin,'https://api.telegram.org');telegram.push(await r.json());return Response.json({ok:true});}});
let groups=0;const pass=s=>{groups++;console.log('PASS '+s);};
try{
 const db=await mf.getD1Database('DB'),kv=await mf.getKVNamespace('ACTION_DATA');
 for(const name of ['0001_line_monitor.sql','0006_crm_write_tracking.sql','0008_operational_alerts.sql','0011_monitor_safety.sql']){
  const sql=readFileSync(new URL('migrations/'+name,root),'utf8').replace(/^--.*$/gm,'').trim();
  for(const s of sql.split(/;\s*(?=CREATE\s|INSERT\s)/).filter(s=>s.trim()))await db.prepare(s).run();
 }
 const call=(path,body={})=>mf.dispatchFetch('https://isolated.test'+path,{method:'POST',body:JSON.stringify(body)});
 const event=(id,text)=>({type:'message',timestamp:1789712941000,webhookEventId:id,source:{type:'user',userId:uid},message:{type:'text',text}});
 await db.prepare("INSERT INTO line_threads(id,source_user_id,display_name) VALUES('thread',?,'本機測試客戶')").bind(uid).run();
 const question='請問在平台購買，因為沒有註冊頁面，只有填 Email，回饋也是透過相同 Email 連結嗎？';
 await Promise.all([call('/capture',[event('question',question)]),call('/capture',[event('question',question)])]);
 await Promise.all([call('/drain'),call('/drain'),call('/drain')]);
 assert.equal(telegram.length,1);const text=telegram[0].text;
 assert(text.includes('客戶：本機測試客戶'));assert(text.includes(question));assert(text.includes('14:29'));
 assert(text.includes('請先確認 LINE 官方帳號是否已有人回覆'));assert(!text.includes('入口：cron'));assert(!text.includes('追蹤：'));assert(!text.includes(uid));
 await call('/drain');assert.equal(telegram.length,1);pass('actual capture and concurrent drain deliver one named exact-question notification without claiming neglect');
 const sensitive='購物有問題，Email me@example.com 電話 0912345678 '+uid+' 密碼：private-value https://example.com/secret';
 await call('/capture',[event('redacted',sensitive)]);await call('/drain');
 assert.equal(telegram.length,2);const redacted=telegram.at(-1).text;
 for(const value of ['me@example.com','0912345678',uid,'private-value','https://example.com/secret'])assert(!redacted.includes(value));
 assert(redacted.includes('購物有問題'));assert.equal(telegram.at(-1).parse_mode,undefined);pass('owner excerpt preserves question but masks contact identifiers and credentials without HTML parsing');
 await kv.put('SYSTEM_SETTINGS',JSON.stringify({shop_keyword_reward_keywords:'954e;點數不能用',shop_keyword_reward_enabled:false}));
 await kv.put('HOOKTEA_CHECKIN_TEMPLATE',JSON.stringify({active:false,keywords:['簽到贈點活動','活動問題']}));
 const commands=['會員專區','  會 員 專 區\u200b ','會員註冊','會員中心','註冊','注册','加入會員','打卡','會員打卡',
  '虎克茶簽到贈點','分享好友','推薦好友','邀請好友','會員分享','我的推薦','推薦連結','邀請連結','QR碼','ＱＲＣｏｄｅ','qr',
  '綁定會員','會員綁定','綁定點數','我的點數','９５４Ｅ','點數不能用','簽到贈點活動','活動問題'];
 for(const [i,command] of commands.entries())await call('/capture',[event('command-'+i,command)]);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM monitor_feedback WHERE event_id LIKE 'command-%' AND category='none' AND analysis_state='done' AND analysis_error='system_command'").first()).n,commands.length);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM operational_alerts WHERE fingerprint LIKE 'durable:feedback:command-%'").first()).n,0);
 await call('/drain');assert.equal(telegram.length,2);pass('exact built-in, normalized and paused custom commands remain recorded but never enqueue customer alerts');
 // Simulate an old version's pending classification and already queued false positive.
 await db.prepare("UPDATE monitor_feedback SET analysis_state='pending',analysis_error='',category='identity' WHERE event_id='command-0'").run();
 await db.prepare("UPDATE monitor_ai_health SET analysis_next_at=0").run();
 await db.prepare(`INSERT INTO operational_alerts(alert_id,fingerprint,category,code,route,trace_id,created_at,updated_at,next_attempt_at)
   SELECT 'old-command','old-command','feedback','feedback_identity','cron',trace_id,0,0,0 FROM monitor_feedback WHERE event_id='command-0'`).run();
 // Avoid analysing unrelated fixture messages: the outbound stub rejects all non-Telegram calls.
 await db.prepare("UPDATE monitor_feedback SET analysis_state='done' WHERE event_id NOT LIKE 'command-%'").run();
 await call('/process');await Promise.all([call('/drain'),call('/drain')]);
 const old=await db.prepare("SELECT sent_at,last_error,attempts FROM operational_alerts WHERE alert_id='old-command'").first();
 assert.equal(old.sent_at,null);assert.equal(old.last_error,'feedback_system_command');assert.equal(telegram.length,2);
 assert.equal((await db.prepare("SELECT analysis_error FROM monitor_feedback WHERE event_id='command-0'").first()).analysis_error,'system_command');
 await db.prepare("UPDATE operational_alerts SET next_attempt_at=0 WHERE alert_id='old-command'").run();await call('/drain');
 assert.equal((await db.prepare("SELECT attempts FROM operational_alerts WHERE alert_id='old-command'").first()).attempts,old.attempts);
 pass('old pending classifications bypass AI and old queued keyword alerts stop without pretending they were sent');
 for(const [i,question] of ['會員專區打不開，怎麼辦？','請問會員註冊沒有頁面要如何處理？','954e 贈點沒收到','簽到贈點活動有問題'].entries()){
  await call('/capture',[event('real-question-'+i,question)]);await call('/drain');
  assert.equal(telegram.at(-1).text.includes(question),true);
 }
 assert.equal(telegram.length,6);pass('questions mentioning command words are not suppressed by substring matching');
 // A command added after enqueue must still be rejected at delivery.
 await call('/capture',[event('new-command','活動操作有問題')]);
 await kv.put('SYSTEM_SETTINGS',JSON.stringify({shop_keyword_reward_keywords:'活動操作有問題'}));await call('/drain');
 assert.equal(telegram.length,6);assert.equal((await db.prepare("SELECT last_error FROM operational_alerts WHERE fingerprint='durable:feedback:new-command'").first()).last_error,'feedback_system_command');
 pass('send-time reads current keyword configuration instead of trusting stale classification');
 await call('/capture',[event('config-outage','購物有問題需協助')]);
 await kv.put('SYSTEM_SETTINGS','invalid-json');await call('/drain');
 assert.equal(telegram.length,6);assert.equal((await db.prepare("SELECT last_error FROM operational_alerts WHERE fingerprint='durable:feedback:config-outage'").first()).last_error,'feedback_command_config_unavailable');
 await call('/capture',[event('capture-outage','購物付款有問題')]);
 assert(await db.prepare("SELECT event_id FROM monitor_feedback WHERE event_id='capture-outage'").first());
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM operational_alerts WHERE fingerprint='durable:feedback:capture-outage'").first()).n,0);
 await kv.put('SYSTEM_SETTINGS','{}');
 await db.prepare("UPDATE monitor_feedback SET analysis_state='done' WHERE event_id='capture-outage'").run();
 pass('unreadable keyword settings preserve evidence and hold alerts instead of sending an unverified customer warning');
 const sentBefore=telegram.length;
 await call('/capture',[event('resolved','購物有問題已處理')]);
 await db.prepare("UPDATE monitor_feedback SET review_state='resolved' WHERE event_id='resolved'").run();
 await call('/drain');assert.equal(telegram.length,sentBefore);pass('resolved feedback is not sent as an unresolved customer message');
 await call('/capture',[event('unknown-name','購物操作有問題')]);
 await db.prepare("UPDATE line_threads SET display_name='' WHERE id='thread'").run();await call('/drain');
 assert.equal(telegram.length,sentBefore);const held=await db.prepare("SELECT sent_at,last_error FROM operational_alerts WHERE fingerprint='durable:feedback:unknown-name'").first();
 assert.equal(held.sent_at,null);assert.equal(held.last_error,'feedback_evidence_unavailable');pass('missing customer evidence stays in backend instead of sending generic warnings');
 await db.prepare("INSERT INTO operational_alerts(alert_id,fingerprint,category,code,route,trace_id,created_at,updated_at,next_attempt_at) VALUES('missing','missing','feedback','feedback_shopping','cron','missing',0,0,0)").run();
 await call('/drain');assert.equal(telegram.length,sentBefore);pass('missing source text cannot fall back to an opaque shopping alert');
 await db.prepare("UPDATE line_threads SET display_name='本機測試客戶' WHERE id='thread'").run();
 await call('/capture',[event('mixed-command','會員專區'),event('mixed-question','請問茶會苦嗎？')]);await call('/drain');
 assert.equal(telegram.length,sentBefore+1);assert(telegram.at(-1).text.includes('請問茶會苦嗎？'));
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM operational_alerts WHERE fingerprint='durable:feedback:mixed-command'").first()).n,0);
 pass('one mixed batch excludes the system command and preserves the actual product question');
}finally{await mf.dispose();}
const worker=readFileSync(new URL('worker.js',root),'utf8');
const start=worker.indexOf('async function handleHookTeaDailySigninReward('),end=worker.indexOf('\nasync function handleShopKeywordReward(',start);
assert(start>0&&end>start);
async function reply(result,{paused=false,suppress=false}={}){
 const messages=[];let claims=0;
 const context={isHookTeaDailySigninKeyword:t=>t==='虎克茶簽到贈點',taipeiDateKey:()=> '2026-09-18',
  hookTeaDailySigninPoints:()=>paused?0:1,safeGetKV:async()=>({}),claimHookTeaReward:async()=>{claims++;return result;},
  deliverKeywordRewardReplyFast:async(...args)=>messages.push(args[3].text),textLineMessage:text=>({type:'text',text}),console};
 vm.createContext(context);vm.runInContext(worker.slice(start,end),context);
 await context.handleHookTeaDailySigninReward({}, {}, {type:'message',source:{userId:uid},message:{type:'text',text:'虎克茶簽到贈點'},hookTeaSuppressReply:suppress});
 return {messages,claims};
}
assert.match((await reply({ok:true,amount:1,balance:779})).messages[0],/已贈送 1 點。\n本次入帳後總點數：779 點。/);
assert.match((await reply({ok:true,amount:1,balance:0})).messages[0],/總點數：0 點/);
assert.match((await reply({ok:true,recovered:true,amount:1,balance:'12'})).messages[0],/待確認的簽到已入帳，共 1 點。\n本次入帳後總點數：12 點/);
pass('signin success and recovery show committed post-credit total including valid zero');
for(const balance of [null,undefined,'',false,NaN,-1,1.2]){
 const text=(await reply({ok:true,amount:1,balance})).messages[0];assert(text.includes('總點數暫時無法確認'));assert(!text.includes('總點數：0'));
}
const pending=(await reply({ok:false,pending:true,balance:999})).messages[0];assert(!pending.includes('999'));assert(!pending.includes('簽到成功'));
pass('unknown or pending balances are never presented as zero or successful credit');
const duplicate=(await reply({ok:true,duplicate:true,amount:1,balance:101})).messages[0];
assert(duplicate.includes('不能重複領取'));assert(duplicate.includes('該次簽到入帳後總點數：101'));assert(duplicate.includes('目前總點數請至會員專區查看'));
assert.equal((await reply({}, {paused:true})).claims,0);assert.equal((await reply({}, {paused:true})).messages.length,0);
assert.equal((await reply({ok:true,balance:1},{suppress:true})).messages.length,0);
pass('duplicate totals are explicitly historical; paused and single-reply ownership stay intact');
console.log(groups+' isolated owner-feedback/signin groups passed; no real customer or Telegram calls');
