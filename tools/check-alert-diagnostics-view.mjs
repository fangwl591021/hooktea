// Render only the actual admin text panel with synthetic evidence; no browser or network access.
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
const html=readFileSync(new URL('../line-oa-monitor.html',import.meta.url),'utf8');
const start=html.indexOf('const issueLabels='),end=html.indexOf('const rows=feedback.data',start);
assert(start>0&&end>start);
const code=html.slice(start,end);
assert(!code.includes('innerHTML'));
function render(data){const panel={textContent:''};runInNewContext(code,{data,Date,$:id=>{assert.equal(id,'operational-errors');return panel;}});return panel.textContent;}
const diagnostic={at:1792497600,stage:'cleanup',route:'cron',code:'alert_cleanup_failed',originalCode:'SQLITE_BUSY',reason:'busy',reasonSummary:'資料庫忙碌或鎖定',id:'synthetic-diagnostic',localOnly:true};
let text=render({alertDiagnostics:[diagnostic]});
assert(text.includes('舊告警清理未完成')&&text.includes('資料庫忙碌或鎖定'));
assert(text.includes('不代表會員交易失敗')&&!text.includes('資料儲存服務異常'));
assert(!text.includes('目前無錯誤紀錄'));
text=render({alertDiagnostics:[{...diagnostic,stage:'delivery_state',deliveryAccepted:true}]});
assert(text.includes('原通知已獲 API 接受')&&text.includes('不重送'));
text=render({alertDiagnostics:[{...diagnostic,stage:'queue_read',localOnly:false,notification:'telegram_rejected'}]});
assert(text.includes('Telegram 拒絕'));
text=render({operationalErrors:[{created_at:1792497600,category:'points',code:'command_reply_rejected',route:'/line-webhook',trace_id:'synthetic-trace',sent_at:1}],alertDiagnostics:[diagnostic]});
assert(text.includes('LINE API 拒絕通知')&&text.includes('synthetic-diagnostic'));
text=render({alertDiagnostics:[{...diagnostic,reasonSummary:'<img src=x onerror=synthetic()>',id:'<script>synthetic()</script>'}]});
assert(text.includes('<script>synthetic()</script>'));
assert.equal(render({}),'目前無錯誤紀錄');
console.log('6 alert-diagnostic admin view groups passed; literal text only, no external calls');
