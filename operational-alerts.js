// System alerts use fixed labels. Owner-approved feedback includes a redacted
// excerpt and display name, never CRM fields, raw events or credentials.
import {isMonitorCommand,loadMonitorCommandPolicy} from './monitor-commands.js';
export const ALERT_RELEASE = '20260919-command-feedback-filter-v1';
// Missing bookkeeping is not evidence of a customer-facing failure.
// Keep its audit/review in D1, but do not notify (including old queued rows).
// A failed background classification does not establish a customer incident.
// Its source message and analysis state remain in monitor_feedback for review.
const LOCAL_ONLY_CODES = new Set(['tracking_unresolved','tracking_recovered','ai_analysis_failed','ai_analysis_recovered']);
const NOT_LOCAL_ONLY_SQL = "code NOT IN ('tracking_unresolved','tracking_recovered','ai_analysis_failed','ai_analysis_recovered') AND last_error<>'feedback_system_command'";
const CATEGORIES = new Set(['request','tracking','background','member','points','line','payment','storage','test','ai','feedback']);
const CODES = new Set(['internal_error','http_5xx','admission_failed','finish_failed','background_failed',
  'identity_conflict','enrollment_failed','points_pending','points_unavailable','points_failed',
  'line_reply_failed','line_forward_failed','line_handler_failed','payment_failed','storage_failed','test',
  'tracking_unresolved','tracking_recovered','ai_recovered','ai_not_configured','ai_authentication_failed',
  'ai_quota_exhausted','ai_rate_limited','ai_provider_unavailable','ai_request_rejected','ai_invalid_response',
  'ai_timeout','ai_network_error','ai_analysis_failed','ai_analysis_recovered','feedback_points','feedback_shopping','feedback_identity',
  'feedback_usability','feedback_feedback']);
const ROUTES = new Set(['/','/line-webhook','/api/huaxu/member','/api/huaxu/register','/api/huaxu/checkin',
  '/api/huaxu/orders','/linepay/confirm','/linepay/cancel','/api','cron']);
const enabled = env => String(env.HOOKTEA_TELEGRAM_ALERTS) === 'true';
const label = (set,value,fallback) => set.has(value) ? value : fallback;
export const alertRoute = request => label(ROUTES,new URL(request.url).pathname,'/api');
const log = data => console.error(JSON.stringify({event:'hooktea_operational_alert',...data}));

export function reportIssue(env,category,code) {
  // Monitoring must never change the business result or introduce a new throw.
  try { env.HOOKTEA_REPORT_ISSUE?.({category,code}); } catch { /* non-blocking */ }
}

export async function telegramAlertConfig(env) {
  let settings = {};
  if (!(env.TELEGRAM_BOT_TOKEN || env.TG_BOT_TOKEN) || !(env.TELEGRAM_CHAT_ID || env.TG_CHAT_ID)) {
    try { settings = await env.ACTION_DATA.get('SYSTEM_SETTINGS','json') || {}; } catch { /* env may suffice */ }
  }
  return {
    token: String(env.TELEGRAM_BOT_TOKEN || env.TG_BOT_TOKEN || settings.telegram_bot_token || settings.tg_bot_token || '').trim(),
    chatId: String(env.TELEGRAM_CHAT_ID || env.TG_CHAT_ID || settings.telegram_chat_id || settings.tg_chat_id || '').trim(),
  };
}

async function boundedJson(response,limit=16384) {
  if (!response.body) return null;
  const reader=response.body.getReader();let size=0,text='';const decoder=new TextDecoder();
  try {
    for (;;) {
      const {value,done}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>limit){void reader.cancel().catch(()=>{});return null;}
      text+=decoder.decode(value,{stream:true});
    }
    return JSON.parse(text+decoder.decode());
  } catch {return null;} finally {reader.releaseLock();}
}

export function redactOwnerExcerpt(value,limit=900) {
  return String(value||'').slice(0,8000)
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ')
    .replace(/U[0-9a-f]{32}/gi,'[識別碼已隱藏]')
    .replace(/https?:\/\/\S+/gi,'[連結已隱藏]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[Email 已隱藏]')
    .replace(/(?:\+?886[ -]?)?0?9[\d -]{8,12}/g,'[電話已隱藏]')
    .replace(/(?:密碼|驗證碼|password|token|secret|api[_ -]?key)\s*[:：=]\s*\S+/gi,'[憑證已隱藏]')
    .replace(/\bsk-[a-z0-9_-]+/gi,'[憑證已隱藏]')
    .replace(/\d{6,}/g,'[長號碼已隱藏]')
    .replace(/\s+/g,' ').trim().slice(0,limit);
}

async function ownerFeedbackText(env,row) {
  // Resolve the exact recorded evidence; never substitute an AI-invented summary.
  const matches=(await env.DB.prepare(`SELECT message_text,event_at,review_state,thread_id,analysis_error
    FROM monitor_feedback WHERE trace_id=? LIMIT 2`).bind(row.trace_id).all()).results||[];
  if(matches.length!==1 || matches[0].review_state==='resolved')return null;
  const feedback=matches[0];
  const policy=await loadMonitorCommandPolicy(env);
  if(feedback.analysis_error==='system_command'||isMonitorCommand(feedback.message_text,policy))
    return {blocked:'feedback_system_command'};
  if(!policy.ready)return {blocked:'feedback_command_config_unavailable'};
  const names=(await env.DB.prepare(`SELECT DISTINCT display_name FROM line_threads
    WHERE (source_user_id=? OR id=?) AND TRIM(display_name)<>'' LIMIT 2`)
    .bind(feedback.thread_id,feedback.thread_id).all()).results||[];
  if(names.length!==1)return null;
  const name=redactOwnerExcerpt(names[0].display_name,80),excerpt=redactOwnerExcerpt(feedback.message_text);
  if(!name || !excerpt || !Number.isFinite(feedback.event_at) || feedback.event_at<=0)return null;
  const time=new Date(feedback.event_at*1000).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});
  return ['📋 HookTea 客戶訊息，請確認並回覆',`客戶：${name}`,`提問時間：${time}（台灣）`,
    '客戶內容（節錄；聯絡資訊已遮蔽）：',`「${excerpt}」`,
    '請先確認 LINE 官方帳號是否已有人回覆；若尚未回覆，請人工接手。',
    '這是客戶的詢問／反饋，不代表已確認系統故障。',
    '查看對話： https://hooktea.fangwl591021.workers.dev/line-oa-monitor.html',
    'AI 不會自動回覆客戶。'].join('\n');
}

async function send(env,row) {
  if(LOCAL_ONLY_CODES.has(row.code))return {ok:false,suppressed:true,error:'insufficient_evidence'};
  const {token,chatId}=await telegramAlertConfig(env);
  if(!token || !chatId)return {ok:false,error:'not_configured',delay:300};
  const descriptions={internal_error:'系統處理失敗',http_5xx:'伺服器錯誤',admission_failed:'交易追蹤無法建立',
    finish_failed:'交易結束狀態無法記錄',background_failed:'背景工作失敗',identity_conflict:'會員身分需要核對',
    enrollment_failed:'會員建檔或訊息處理失敗',points_pending:'點數待入帳或待核對',points_unavailable:'點數暫時無法使用',
    points_failed:'點數交易失敗',line_reply_failed:'LINE 回覆未成功',line_forward_failed:'舊站關鍵字轉送失敗',
    line_handler_failed:'LINE 關鍵字未完成處理',payment_failed:'付款處理異常',storage_failed:'資料儲存服務異常',test:'通知連線測試，不是客戶故障',
    tracking_unresolved:'新增工作未確認結束，待查；不代表已確認點數錯誤',tracking_recovered:'工作已補記結束；原待查紀錄保留',
    ai_recovered:'AI 後台安全自測已恢復',ai_not_configured:'AI 金鑰未設定',ai_authentication_failed:'AI 認證未通過',
    ai_quota_exhausted:'AI 額度不足',ai_rate_limited:'AI 呼叫受到限流',ai_provider_unavailable:'AI 服務暫時不可用',
    ai_request_rejected:'AI 測試請求未被接受',ai_invalid_response:'AI 未回傳預期測試結果',ai_timeout:'AI 連線逾時',
    ai_network_error:'AI 連線失敗',ai_analysis_failed:'後台訊息分析未完成；原訊息仍保留待查',ai_analysis_recovered:'後台訊息分析已恢復；先前待查紀錄仍需核對',
    feedback_points:'收到點數使用反饋，請人工核對',feedback_shopping:'收到購物／付款反饋，請人工核對',
    feedback_identity:'收到登入／會員反饋',feedback_usability:'收到操作體驗反饋',feedback_feedback:'收到客戶反饋'};
  const heading=row.category==='test'?'✅ HookTea 告警測試':row.code.endsWith('_recovered')?'✅ HookTea 狀態恢復':row.category==='feedback'?'📋 HookTea 客戶反饋（尚未核實）':'🚨 HookTea 系統待查';
  const text=row.category==='feedback' ? await ownerFeedbackText(env,row) : [heading,descriptions[row.code]||'系統異常',
    `類型：${row.category} / ${row.code}`,`入口：${row.route}`,
    `時間：${new Date(row.created_at*1000).toISOString()}`,`追蹤：${row.trace_id}`,
    `告警：${row.alert_id}`,`同類累計：${row.occurrences}`,
    '請至後台 AI 監控查看；通知不會自動補點、退款或回覆客戶。'].join('\n');
  // Incomplete evidence remains visible in the backend; no vague owner message.
  if(!text)return {ok:false,suppressed:true,error:'feedback_evidence_unavailable',delay:86400};
  if(text.blocked)return {ok:false,suppressed:true,error:text.blocked,delay:86400};
  try {
    const response=await fetch('https://api.telegram.org/bot'+token+'/sendMessage',{
      method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(5000),
      body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true}),
    });
    const body=await boundedJson(response);
    if(response.ok && body?.ok===true)return {ok:true};
    const delay=Math.min(86400,Math.max(60,Number(body?.parameters?.retry_after)||60));
    // Never save Telegram's raw response (contains chat metadata) or token URL.
    return {ok:false,error:response.status===429?'telegram_rate_limited':'telegram_rejected',delay};
  } catch { return {ok:false,error:'telegram_network_error',delay:60}; }
}

async function deliver(env,id,now=Math.floor(Date.now()/1000)) {
  const lease=crypto.randomUUID();
  const row=await env.DB.prepare(`UPDATE operational_alerts SET lease_token=?,lease_until=?,attempts=attempts+1
    WHERE alert_id=? AND sent_at IS NULL AND next_attempt_at<=? AND lease_until<=? AND ${NOT_LOCAL_ONLY_SQL} RETURNING *`)
    .bind(lease,now+90,id,now,now).first();
  if(!row)return {ok:false,skipped:true};
  const result=await send(env,row);
  const retry=Math.max(result.delay||60,Math.min(3600,60*2**Math.min(row.attempts-1,6)));
  await env.DB.prepare(`UPDATE operational_alerts SET sent_at=?,last_error=?,next_attempt_at=?,lease_until=0,lease_token=NULL
    WHERE alert_id=? AND lease_token=?`).bind(result.ok?now:null,result.error||'',now+retry,id,lease).run();
  log({alertId:id,traceId:row.trace_id,delivery:result.ok?'sent':result.error});
  return result;
}

async function storageFallback(env,traceId,now) {
  // D1 outage escape hatch. KV dedup is best-effort, not an atomic claim.
  try {
    const key='TELEGRAM_ALERT_D1_OUTAGE_'+Math.floor(now/300);
    if(await env.ACTION_DATA.get(key))return;
    await env.ACTION_DATA.put(key,'1',{expirationTtl:600});
    const result=await send(env,{category:'storage',code:'storage_failed',route:'/api',trace_id:traceId,
      alert_id:crypto.randomUUID(),created_at:now,occurrences:1});
    log({traceId,delivery:result.ok?'fallback_sent':result.error});
  } catch {log({traceId,delivery:'fallback_unavailable'});}
}

export async function enqueueAlert(env,input) {
  if(!enabled(env))return {enabled:false};
  const now=Math.floor(Date.now()/1000),id=crypto.randomUUID();
  const category=label(CATEGORIES,input.category,'request'),code=label(CODES,input.code,'internal_error');
  if(LOCAL_ONLY_CODES.has(code))return {ok:false,suppressed:true,reason:'insufficient_evidence'};
  const route=label(ROUTES,input.route,'/api');
  const traceId=/^[0-9a-f-]{36}$/.test(input.traceId||'')?input.traceId:crypto.randomUUID();
  // Five-minute fixed buckets coalesce concurrent errors across isolates.
  const fingerprint=[category,code,route,Math.floor(now/300)].join(':');
  log({category,code,route,traceId});
  let row;
  try {
    row=await env.DB.prepare(`INSERT INTO operational_alerts
      (alert_id,fingerprint,category,code,route,trace_id,created_at,updated_at,next_attempt_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET
      occurrences=occurrences+1,updated_at=excluded.updated_at RETURNING alert_id,sent_at`)
      .bind(id,fingerprint,category,code,route,traceId,now,now,now).first();
  } catch {
    await storageFallback(env,traceId,now);
    return {ok:false,error:'alert_storage_unavailable'};
  }
  try {return {alertId:row.alert_id,...await deliver(env,row.alert_id,now)};}
  catch {log({alertId:row.alert_id,traceId,delivery:'delivery_state_unknown'});return {alertId:row.alert_id,ok:false,error:'delivery_state_unknown'};}
}

export function createIssueReporter(env,ctx,route,traceId) {
  const seen=new Set();
  return input=>{
    if(!enabled(env))return;
    const category=label(CATEGORIES,input.category,'request'),code=label(CODES,input.code,'internal_error');
    const key=category+':'+code;if(seen.has(key))return;seen.add(key);
    ctx.waitUntil(enqueueAlert(env,{category,code,route,traceId}).catch(()=>log({traceId,delivery:'report_failed'})));
  };
}

// Caller uses this statement in the SAME D1 batch as incident state/evidence.
// Stable outbox identities are retained, so unchanged issues do not re-alert tomorrow.
export function durableAlertStatement(env,key,category,code,traceId,condition='1',bindings=[]) {
  const now=Math.floor(Date.now()/1000);
  if(!CATEGORIES.has(category)||!CODES.has(code)||String(key).length>300)throw Error('INVALID_ALERT_LABEL');
  return env.DB.prepare(`INSERT OR IGNORE INTO operational_alerts
    (alert_id,fingerprint,category,code,route,trace_id,created_at,updated_at,next_attempt_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE (${condition}) AND ${LOCAL_ONLY_CODES.has(code)?'0':'1'}`)
    .bind(crypto.randomUUID(),'durable:'+key,category,code,'cron',traceId,now,now,now,...bindings);
}

export async function drainAlerts(env) {
  if(!enabled(env))return;
  const now=Math.floor(Date.now()/1000);
  try {
    const rows=(await env.DB.prepare(`SELECT alert_id FROM operational_alerts WHERE sent_at IS NULL
      AND next_attempt_at<=? AND lease_until<=? AND ${NOT_LOCAL_ONLY_SQL} ORDER BY created_at LIMIT 10`).bind(now,now).all()).results||[];
    // Bounded fan-out: <= 10 deliveries, each HTTP deadline 5 seconds.
    await Promise.all(rows.map(row=>deliver(env,row.alert_id,now).catch(()=>log({delivery:'retry_state_unknown'}))));
    await env.DB.prepare("DELETE FROM operational_alerts WHERE sent_at IS NOT NULL AND updated_at<? AND fingerprint NOT LIKE 'durable:%'").bind(now-7*86400).run();
  } catch {await storageFallback(env,crypto.randomUUID(),now);}
}

export async function alertStatus(env) {
  const config=await telegramAlertConfig(env);
  const counts=(await env.DB.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN sent_at IS NULL AND ${NOT_LOCAL_ONLY_SQL} THEN 1 ELSE 0 END) pending,
    SUM(CASE WHEN sent_at IS NULL AND NOT (${NOT_LOCAL_ONLY_SQL}) THEN 1 ELSE 0 END) localOnly,
    MAX(sent_at) lastSentAt FROM operational_alerts`).first());
  return {release:ALERT_RELEASE,enabled:enabled(env),configured:!!(config.token&&config.chatId),...counts};
}

function expectedError(error) {
  return /INSUFFICIENT_POINTS|CHILD_INSUFFICIENT|點數不足|Admin authorization required|LINE authorization required|MEMBER_REGISTRATION_REQUIRED|CRM_REQUESTS_PAUSED/.test(String(error?.message||error||''));
}
export function observePointService(service,env) {
  const observed={...service};
  for(const method of ['enroll','read','submit','attempt','resume','history']) {
    if(typeof service[method]!=='function')continue;
    observed[method]=async(...args)=>{
      try {
        const result=await service[method](...args);
        if(result?.pending || result?.pendingCount>0)reportIssue(env,'points','points_pending');
        if(result?.available===false)reportIssue(env,'points','points_unavailable');
        if(result?.ok===false && !result.pending && !expectedError(result.error))reportIssue(env,'points','points_failed');
        return result;
      } catch(error) {
        if(!expectedError(error))reportIssue(env,method==='enroll'?'member':'points',method==='enroll'?'enrollment_failed':'points_failed');
        throw error;
      }
    };
  }
  return observed;
}

export async function inspectAlertResponse(response,report) {
  if(response.status>=500){report({category:'request',code:'http_5xx'});return;}
  // Includes legacy RPC errors returned as HTTP 200; never parse HTML or large exports.
  const type=response.headers.get('content-type')||'';
  if(!type.includes('json') && response.status!==200)return;
  if(type.includes('html'))return;
  const data=await boundedJson(response);
  if(!data)return;
  const values=[data,data.data].filter(v=>v&&typeof v==='object');
  for(const value of values) {
    if(value.pending===true || value.pendingCount>0)report({category:'points',code:'points_pending'});
    if(value.available===false)report({category:'points',code:'points_unavailable'});
    const code=String(value.code||value.error||value.message||'');
    if(/IDENTITY_(CONFLICT|REVIEW_REQUIRED)/.test(code))report({category:'member',code:'identity_conflict'});
    else if((value.status==='error'||value.success===false||value.ok===false) && !expectedError(code) && response.status!==401 && response.status!==403 && response.status!==400)
      report({category:'request',code:'internal_error'});
  }
}
