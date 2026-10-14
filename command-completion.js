import {durableAlertStatement,redactOwnerExcerpt} from './operational-alerts.js';
export const COMMAND_COMPLETION_RELEASE='20261014-command-completion-v1';
const enabled=env=>String(env.HOOKTEA_MONITOR_SAFETY)==='true';
const now=()=>Math.floor(Date.now()/1000);
export async function commandStatement(env,event,policy,trace) {
 const value=String(event.message.text||'').normalize('NFKC').trim().replace(/[\s\u200B-\u200D\uFEFF]+/g,'').toLowerCase();
 const reward=policy.reward;
 let kind,key,points;
 // Match the real owner priority, not merely the configurable keyword list.
 if(/^(會員專區|會員中心|會員註冊|註冊|注册|加入會員|會員分享|分享好友|推薦好友|邀請好友|會員打卡|打卡)$/.test(value))return null;
 if(value==='虎克茶簽到贈點'){
  if(!(policy.dailyPoints>0))return null;
  kind='daily_signin';points=policy.dailyPoints;key=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Taipei'});
 }else if(reward?.enabled&&reward.keywords.includes(value)){kind='keyword_reward';points=reward.points;
  key=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
 }
 if(!kind)return null;
 const uid=event.source.userId,id=String(event.webhookEventId||event.message.id),time=now();
 return env.DB.prepare(`INSERT OR IGNORE INTO monitor_command_executions
  (event_id,line_uid,operation_id,kind,expected_points,trace_id,request_trace,received_at,event_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(id,uid,kind+':'+uid+':'+key,kind,points,trace,env.HOOKTEA_REQUEST_TRACE_ID||'',time,Math.floor(Number(event.timestamp||Date.now())/1000),time);
}
export async function recordCommandResult(env,eventId,result,delivery=null) {
 if(!enabled(env)||!eventId)return;
 const credited=result?.ok===true,rejected=result?.status==='rejected';
 const actual=credited&&!result?.duplicate&&Number.isSafeInteger(result?.amount)?result.amount:null;
 const definitiveReply=delivery?.ok!==true&&delivery?.ambiguous!==true&&
  Number(delivery?.push?.status||delivery?.status||delivery?.reply?.status)>=400&&
  Number(delivery?.push?.status||delivery?.status||delivery?.reply?.status)<500;
 const state=credited?'credited':rejected?'rejected':'review';
 const reply=delivery?.ok===true?'sent':definitiveReply?'rejected':'unknown';
 const code=rejected?'POINTS_REJECTED':definitiveReply?'LINE_REPLY_REJECTED':'';
 await env.DB.prepare(`UPDATE monitor_command_executions SET
  state=CASE WHEN state='credited' THEN state WHEN ? IS NOT NULL AND ?<>expected_points THEN 'review' ELSE ? END,
  reply_state=CASE WHEN reply_state='sent' THEN reply_state ELSE ? END,
  result_code=CASE WHEN state='credited' AND reply_state='sent' THEN result_code ELSE ? END,
  review_reason=CASE WHEN state='credited' AND reply_state='sent' THEN review_reason
    WHEN ? IS NOT NULL AND ?<>expected_points THEN 'AMOUNT_MISMATCH' ELSE ? END,updated_at=?,next_check_at=0 WHERE event_id=?`)
  .bind(actual,actual,state,reply,code,actual,actual,result?.duplicate?'ALREADY_CLAIMED':!credited&&!rejected?'CREDIT_UNCONFIRMED':delivery&&reply==='unknown'?'REPLY_UNCONFIRMED':'',now(),eventId).run();
}
export async function reconcileCommands(env) {
 if(!enabled(env))return;
 // Only inspect receipts. Never retry a point transaction or LINE token.
 await env.DB.prepare(`UPDATE monitor_command_executions SET state='review',review_reason='EXECUTION_UNCONFIRMED',updated_at=?
  WHERE state='accepted' AND received_at<=?`).bind(now(),now()-600).run();
 const rows=(await env.DB.prepare(`SELECT * FROM monitor_command_executions
  WHERE (state IN ('review','rejected') OR reply_state='rejected') AND next_check_at<=?
  ORDER BY next_check_at,received_at LIMIT 25`).bind(now()).all()).results||[];
 for(const row of rows){
  const receipt=await env.DB.prepare(`SELECT 'confirmed' status,amount FROM child_point_ledger WHERE operation_id=?
   UNION ALL SELECT status,amount FROM point_operations WHERE operation_id=?`).bind(row.operation_id,row.operation_id).all();
  const exact=receipt.results?.length===1&&Number(receipt.results[0].amount)===row.expected_points;
  const confirmed=exact&&receipt.results[0].status==='confirmed';
  if(confirmed)await env.DB.prepare("UPDATE monitor_command_executions SET state='credited',review_reason=CASE WHEN reply_state='unknown' THEN 'REPLY_UNCONFIRMED' ELSE '' END,updated_at=? WHERE event_id=?").bind(now(),row.event_id).run();
  // Missing receipts or ambiguous delivery remain local review, never a panic alert.
  const code=row.state==='rejected'&&exact&&receipt.results[0].status==='rejected'?'command_points_rejected':confirmed&&row.reply_state==='rejected'?'command_reply_rejected':'';
  if(code)await durableAlertStatement(env,'command:'+row.event_id+':'+code,code==='command_reply_rejected'?'line':'points',code,row.trace_id).run();
  await env.DB.prepare('UPDATE monitor_command_executions SET next_check_at=? WHERE event_id=?').bind(now()+3600,row.event_id).run();
 }
}
export async function commandStatus(env) {
 const counts=await env.DB.prepare(`SELECT COUNT(*) total,SUM(state='accepted') processing,
  SUM(state='review' OR reply_state='unknown' AND state<>'accepted') unconfirmed,
  SUM(state='credited') credited,SUM(state='rejected' OR reply_state='rejected') rejected FROM monitor_command_executions`).first();
 const rows=(await env.DB.prepare(`SELECT trace_id,request_trace,kind,expected_points,event_at,state,reply_state,result_code,review_reason,
  (SELECT CASE WHEN COUNT(DISTINCT display_name)=1 THEN MAX(display_name) ELSE '' END FROM line_threads t WHERE t.source_user_id=e.line_uid) display_name
  FROM monitor_command_executions e ORDER BY received_at DESC LIMIT 30`).all()).results||[];
 return {release:COMMAND_COMPLETION_RELEASE,counts,rows};
}
export async function commandAlertText(env,row) {
 const events=(await env.DB.prepare('SELECT * FROM monitor_command_executions WHERE trace_id=? LIMIT 2').bind(row.trace_id).all()).results||[];
 if(events.length!==1)return null;
 const e=events[0],reply=row.code==='command_reply_rejected';
 if(reply?(e.state!=='credited'||e.reply_state!=='rejected'):(e.state!=='rejected'))return {blocked:'command_resolved'};
 const names=(await env.DB.prepare('SELECT DISTINCT display_name FROM line_threads WHERE source_user_id=? AND TRIM(display_name)<>\'\' LIMIT 2').bind(e.line_uid).all()).results||[];
 if(names.length!==1)return null;
 const name=redactOwnerExcerpt(names[0].display_name,80);if(!name)return null;
 return ['HookTea 活動處理需要人工協助',`用戶：${name}`,`輸入時間：${new Date(e.event_at*1000).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})}`,
  `功能：${e.kind==='keyword_reward'?'活動關鍵字贈點':'每日簽到'}（${e.expected_points} 點）`,
  reply?'點數已有入帳紀錄，但 LINE API 明確拒絕通知；請人工告知用戶，不要再次加點。':'點數交易已有拒絕紀錄；請人工核對原因，不要自動補點。',
  '查看後台：https://hooktea.fangwl591021.workers.dev/line-oa-monitor.html'].join('\n');
}
