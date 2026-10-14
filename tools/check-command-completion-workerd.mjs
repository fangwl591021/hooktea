import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(process.env.WRANGLER_PACKAGE||import.meta.url);
const {Miniflare}=require('miniflare'),{build}=require('esbuild');
const root=new URL('../',import.meta.url),uid='U'+'a'.repeat(32);
const bundle=await build({stdin:{resolveDir:fileURLToPath(root),contents:`
import {captureMonitorEvents} from './monitor-safety.js';
import {recordCommandResult,reconcileCommands,commandStatus} from './command-completion.js';
import {drainAlerts} from './operational-alerts.js';
export default {async fetch(r,env){
 const path=new URL(r.url).pathname;
 if(path==='/capture')await captureMonitorEvents(env,await r.json());
 if(path==='/result'){const b=await r.json();await recordCommandResult(env,b.id,b.result,b.delivery);}
 if(path==='/reconcile')await reconcileCommands(env);
 if(path==='/drain')await drainAlerts(env);
 return Response.json(await commandStatus(env));
}};`},bundle:true,write:false,format:'esm',platform:'browser'});
const notifications=[];
const runtime=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-04-06',d1Databases:{DB:'command-completion-isolated'},kvNamespaces:{ACTION_DATA:'command-completion-isolated'},bindings:{HOOKTEA_MONITOR_SAFETY:'true',HOOKTEA_TELEGRAM_ALERTS:'true',TELEGRAM_BOT_TOKEN:'synthetic',TELEGRAM_CHAT_ID:'synthetic'},outboundService:async r=>{assert.equal(new URL(r.url).hostname,'api.telegram.org');notifications.push(await r.json());return Response.json({ok:true});}});
let checks=0;
try{
 const db=await runtime.getD1Database('DB'),kv=await runtime.getKVNamespace('ACTION_DATA');
 for(const file of ['0001_line_monitor.sql','0006_crm_write_tracking.sql','0008_operational_alerts.sql','0011_monitor_safety.sql','0012_command_completion.sql']){
  const sql=readFileSync(new URL('migrations/'+file,root),'utf8').replace(/^--.*$/gm,'');
  for(const s of sql.split(file.startsWith('0012')?/;/:/;\s*(?=CREATE\s|INSERT\s|PRAGMA\s)/).map(s=>s.trim()).filter(Boolean))await db.prepare(s).run();
 }
 await db.prepare('CREATE TABLE child_point_ledger(operation_id TEXT PRIMARY KEY,amount INTEGER)').run();
 await db.prepare('CREATE TABLE point_operations(operation_id TEXT PRIMARY KEY,status TEXT,amount INTEGER)').run();
 await kv.put('SYSTEM_SETTINGS',JSON.stringify({shop_keyword_reward_enabled:'true',shop_keyword_reward_points:100,shop_keyword_reward_keywords:'954e'}));
 await db.prepare("INSERT INTO line_threads(id,source_user_id,display_name) VALUES('synthetic-thread',?,'Synthetic owner')").bind(uid).run();
 const post=(path,body={})=>runtime.dispatchFetch('https://isolated.test'+path,{method:'POST',body:JSON.stringify(body)});
 const event=id=>({type:'message',webhookEventId:id,timestamp:Date.now(),source:{userId:uid},message:{id,type:'text',text:'954e'}});
 await post('/capture',[event('one')]);await post('/capture',[event('one')]);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM monitor_command_executions').first()).n,1);checks++;
 await db.prepare('UPDATE monitor_command_executions SET received_at=?').bind(Math.floor(Date.now()/1000)-601).run();await post('/reconcile');
 assert.equal((await db.prepare("SELECT state FROM monitor_command_executions WHERE event_id='one'").first()).state,'review');assert.equal(notifications.length,0);checks++;
 const c=await db.prepare('SELECT operation_id FROM monitor_command_executions').first();
 await db.prepare('INSERT INTO child_point_ledger VALUES(?,100)').bind(c.operation_id).run();
 await post('/result',{id:'one',result:{ok:true,status:'confirmed'},delivery:{ok:false,status:400,ambiguous:false}});await post('/reconcile');await post('/drain');
 assert.equal(notifications.length,1);assert(notifications[0].text.includes('Synthetic owner'));assert(notifications[0].text.includes('不要再次加點'));checks++;
 await post('/reconcile');await post('/drain');assert.equal(notifications.length,1);assert.equal((await db.prepare('SELECT COUNT(*) n FROM child_point_ledger').first()).n,1);checks++;
 const status=await(await runtime.dispatchFetch('https://isolated.test/status')).json();assert.equal(status.rows[0].state,'credited');assert.equal(status.rows[0].reply_state,'rejected');assert.equal(status.rows[0].display_name,'Synthetic owner');checks++;
 console.log(checks+' actual workerd/D1 command-completion groups passed; no real LINE, Telegram or points.');
}finally{await runtime.dispose();}
