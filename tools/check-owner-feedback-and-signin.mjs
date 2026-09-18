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
import {captureMonitorEvents} from './monitor-safety.js';
export default {async fetch(r,env){
 if(new URL(r.url).pathname==='/capture')await captureMonitorEvents(env,await r.json());
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
 const db=await mf.getD1Database('DB');
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
 await call('/capture',[event('resolved','購物有問題已處理')]);
 await db.prepare("UPDATE monitor_feedback SET review_state='resolved' WHERE event_id='resolved'").run();
 await call('/drain');assert.equal(telegram.length,2);pass('resolved feedback is not sent as an unresolved customer message');
 await call('/capture',[event('unknown-name','購物操作有問題')]);
 await db.prepare("UPDATE line_threads SET display_name='' WHERE id='thread'").run();await call('/drain');
 assert.equal(telegram.length,2);const held=await db.prepare("SELECT sent_at,last_error FROM operational_alerts WHERE fingerprint='durable:feedback:unknown-name'").first();
 assert.equal(held.sent_at,null);assert.equal(held.last_error,'feedback_evidence_unavailable');pass('missing customer evidence stays in backend instead of sending generic warnings');
 await db.prepare("INSERT INTO operational_alerts(alert_id,fingerprint,category,code,route,trace_id,created_at,updated_at,next_attempt_at) VALUES('missing','missing','feedback','feedback_shopping','cron','missing',0,0,0)").run();
 await call('/drain');assert.equal(telegram.length,2);pass('missing source text cannot fall back to an opaque shopping alert');
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
