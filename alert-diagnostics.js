// Operational evidence only. Never retain exception messages, SQL, URLs, bodies or credentials.
export const ALERT_DIAGNOSTIC_RELEASE='20261020-alert-diagnostics-v1';
export const ALERT_DIAGNOSTIC_STAGES={
  queue_read:{code:'alert_queue_read_failed',name:'讀取告警待送清單',impact:'暫時無法取得待送通知；不代表會員、訂單或點數資料損壞。',next:'檢查告警表查詢與 D1 回應；不要重跑會員交易。'},
  queue_write:{code:'alert_queue_write_failed',name:'寫入告警佇列',impact:'原始告警未能寫入待送清單；不能據此判定整個儲存服務故障。',next:'檢查告警表寫入與 D1 回應；不要補點或退款。'},
  delivery_claim:{code:'alert_delivery_claim_failed',name:'取得告警發送權',impact:'本次尚未呼叫 Telegram，待送通知仍需重試。',next:'檢查告警發送鎖與 D1 回應。'},
  delivery_state:{code:'alert_delivery_state_failed',name:'記錄 Telegram 發送結果',localOnly:true},
  cleanup:{code:'alert_cleanup_failed',name:'清理舊告警紀錄',localOnly:true},
};
const routes=new Set(['/','/line-webhook','/api/huaxu/member','/api/huaxu/register','/api/huaxu/checkin','/api/huaxu/orders','/linepay/confirm','/linepay/cancel','/api','cron']);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)?value:null;
const originalCodes=new Set(['SQLITE_BUSY','SQLITE_LOCKED','SQLITE_CONSTRAINT','SQLITE_ERROR','SQLITE_AUTH','SQLITE_READONLY','SQLITE_CORRUPT','SQLITE_FULL','SQLITE_IOERR','D1_ERROR','D1_EXEC_ERROR','D1_TYPE_ERROR','D1_SESSION_ERROR','D1_COLUMN_NOTFOUND','D1_RESULT_INVALID']);
const reasons={missing_table:'告警資料表不存在',missing_column:'告警欄位不存在',busy:'資料庫忙碌或鎖定',timeout:'操作逾時',query_limit:'查詢或子請求數量限制',rate_limited:'服務限流',network:'連線未完成',constraint:'資料限制未通過',readonly:'寫入權限或唯讀限制',unknown:'未分類例外；未保存原始文字以免洩漏資料'};
const recordKey=id=>'HOOKTEA_ALERT_DIAGNOSTIC_V1_'+id;
const latestKey=stage=>'HOOKTEA_ALERT_DIAGNOSTIC_LATEST_V1_'+stage;
const deliveryKey=id=>'HOOKTEA_ALERT_DIAGNOSTIC_DELIVERY_V1_'+id;
const deliveryStates=new Set(['accepted','not_configured','telegram_rejected','telegram_rate_limited','telegram_network_error','fallback_unavailable','throttled']);
export function classifyAlertError(error){
  const message=[error?.message,error?.cause?.message].filter(v=>typeof v==='string').join(' ').slice(0,4096);
  const tokens=[error?.code,error?.cause?.code,...(message.match(/\b(?:SQLITE|D1)_[A-Z_]+\b/g)||[])];
  const originalCode=tokens.find(code=>originalCodes.has(code))||'UNCLASSIFIED';
  const reason=/no such table/i.test(message)?'missing_table':/no such column/i.test(message)?'missing_column':/SQLITE_(?:BUSY|LOCKED)|database is locked/i.test(message)?'busy':/too many (?:queries|subrequests)|query limit/i.test(message)?'query_limit':/timed?\s*out|timeout/i.test(message)?'timeout':/rate.?limit|429/.test(message)?'rate_limited':/network|fetch failed|connection/i.test(message)?'network':/SQLITE_CONSTRAINT/i.test(message)?'constraint':/SQLITE_READONLY|readonly|read.only/i.test(message)?'readonly':'unknown';
  const errorType=['Error','TypeError','RangeError','SyntaxError','AbortError','TimeoutError'].includes(error?.name)?error.name:'Error';
  return {originalCode,reason,errorType};
}
function safeRecord(value){
  if(!value||!Object.hasOwn(ALERT_DIAGNOSTIC_STAGES,value.stage)||!uuid(value.id))return null;
  const stage=value.stage,info=ALERT_DIAGNOSTIC_STAGES[stage];
  return {release:ALERT_DIAGNOSTIC_RELEASE,id:value.id,stage,code:info.code,
    at:Number.isSafeInteger(value.at)&&value.at>0?value.at:0,route:routes.has(value.route)?value.route:'cron',
    requestTrace:uuid(value.requestTrace),alertId:uuid(value.alertId),
    originalCode:originalCodes.has(value.originalCode)?value.originalCode:'UNCLASSIFIED',
    reason:Object.hasOwn(reasons,value.reason)?value.reason:'unknown',
    reasonSummary:reasons[Object.hasOwn(reasons,value.reason)?value.reason:'unknown'],
    errorType:['Error','TypeError','RangeError','SyntaxError','AbortError','TimeoutError'].includes(value.errorType)?value.errorType:'Error',
    fingerprint:/^[a-f0-9]{64}$/.test(value.fingerprint||'')?value.fingerprint:null,
    deliveryAccepted:value.deliveryAccepted===true,localOnly:info.localOnly===true};
}
export async function recordAlertDiagnostic(env,{stage,error,route='cron',requestTrace=null,alertId=null,deliveryAccepted=false}){
  if(!Object.hasOwn(ALERT_DIAGNOSTIC_STAGES,stage))throw Error('INVALID_ALERT_DIAGNOSTIC_STAGE');
  // Hash only for correlation; the original exception text is never stored or logged.
  const input=[error?.name,error?.message,error?.cause?.code,error?.cause?.message].filter(v=>typeof v==='string').join('|').slice(0,4096);
  let fingerprint=null;
  try{fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input))),b=>b.toString(16).padStart(2,'0')).join('');}catch{}
  const record=safeRecord({id:crypto.randomUUID(),stage,at:Math.floor(Date.now()/1000),route,requestTrace,alertId,deliveryAccepted,fingerprint,...classifyAlertError(error)});
  let retained=false;
  try{await env.ACTION_DATA.put(recordKey(record.id),JSON.stringify(record),{expirationTtl:30*86400});retained=true;}catch{}
  // Different keys: do not write the same KV key twice within one second.
  try{await env.ACTION_DATA.put(latestKey(stage),JSON.stringify(record),{expirationTtl:30*86400});}catch{}
  console.error(JSON.stringify({event:'hooktea_alert_diagnostic',...record,retained}));
  return {...record,retained};
}
export async function recentAlertDiagnostics(env){
  return (await Promise.all(Object.keys(ALERT_DIAGNOSTIC_STAGES).map(async stage=>{
    let record;
    try{record=safeRecord(await env.ACTION_DATA.get(latestKey(stage),'json'));}catch{return null;}
    if(!record)return null;
    let delivery=null;
    try{delivery=await env.ACTION_DATA.get(deliveryKey(record.id),'json');}catch{}
    return {...record,notification:deliveryStates.has(delivery?.state)?delivery.state:record.localOnly?'local_only':'unrecorded'};
  }))).filter(Boolean);
}
export async function recordDiagnosticDelivery(env,id,state){
  if(!uuid(id)||!deliveryStates.has(state))return;
  try{await env.ACTION_DATA.put(deliveryKey(id),JSON.stringify({state,at:Math.floor(Date.now()/1000)}),{expirationTtl:30*86400});}
  catch{console.error(JSON.stringify({event:'hooktea_alert_diagnostic_delivery_unrecorded',id,state}));}
}
export function alertDiagnosticText(value){
  const record=safeRecord(value);if(!record||record.localOnly)return null;
  const info=ALERT_DIAGNOSTIC_STAGES[record.stage];
  return ['⚠️ HookTea 告警處理異常',`失敗步驟：${info.name}`,`影響：${info.impact}`,
    `錯誤代碼：${record.code}`,`原始錯誤代碼：${record.originalCode}`,`原因摘要：${reasons[record.reason]}`,
    `觸發來源：${record.route}`,`時間：${new Date(record.at*1000).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})}（台灣）`,
    `診斷編號：${record.id}`,...(record.requestTrace?[`請求追蹤：${record.requestTrace}`]:[]),
    `建議下一步：${info.next}`,'此通知不會自動補點、退款或回覆客戶。'].join('\n');
}
