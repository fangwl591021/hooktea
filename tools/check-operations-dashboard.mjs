import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../admin.html',import.meta.url),'utf8');
for(const [,script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if(script.trim()) new vm.Script(script);
const code=html.slice(html.indexOf('// Operations status:'),html.indexOf('// End operations status.'));
const data={ai:{status:'healthy',checked_at:1789607095},feedbackCounts:{openFeedback:2,pendingAnalysis:1,failedAnalysis:1},tracking:{counts:{newUnresolved:1,knownUnresolved:9}},operationalErrors:[{}]};
function app({authenticated=true,admin=true,safety=data,cart=[{status:'blocked'},{status:'failed'},{status:'active'}],failSafety=false,failCart=false}={}){
 const calls=[],routes=[];
 const c={ref:value=>({value}),computed:fn=>({get value(){return fn();}}),URL,Date,AbortSignal,
  isAuthenticated:{value:authenticated},canViewFinance:{value:admin},WORKER_URL:'https://hooktea.test/',cartActivitySearch:{value:'old'},cartActivityStatus:{value:'ALL'},switchView:v=>routes.push(v),
  callApi:async(action,payload)=>{calls.push({action,payload});if(action==='CREATE_ADMIN_SESSION')return {token:'private-session'};if(failCart)throw Error('offline');return {logs:cart};},
  fetch:async(url,options)=>{calls.push({url,options});if(failSafety)throw Error('offline');return {ok:true,json:async()=>({success:true,data:safety})};}};
 vm.createContext(c);vm.runInContext(code+'\nglobalThis.api={loadOperationsStatus,operationsAiLabel,operationsAiHealthy,operationsCartLabel,operationsFeedbackLabel,operationsTrackingLabel,operationsErrorsLabel,openOperationCartIssues,cartActivityErrorText};',c);
 return {c,calls,routes,api:c.api};
}
test('dashboard replaces course and teacher counters with actionable status links',()=>{
 const dashboard=html.slice(html.indexOf('<div v-if="canViewFinance && view === \'dashboard\'"'),html.indexOf('<div v-if="view === \'calendar\'"'));
 assert.doesNotMatch(dashboard,/上架課程|預約導師/);
 assert.match(dashboard,/AI 檢測狀態/);assert.match(dashboard,/購物異常紀錄/);
 assert.match(dashboard,/@click="openOperationCartIssues"/);assert.match(dashboard,/@click="openLineMonitor"/);
 assert.match(dashboard,/最多 500 筆/);assert.match(dashboard,/非受影響人數/);
});
test('unknown status is not rendered as healthy or zero failures',()=>{
 const p=app();assert.equal(p.api.operationsAiLabel.value,'尚未讀取');assert.equal(p.api.operationsAiHealthy.value,false);assert.equal(p.api.operationsCartLabel.value,'尚未讀取');
});
test('loads protected summaries without triggering AI test or business writes',async()=>{
 const p=app();await p.api.loadOperationsStatus();
 assert.equal(p.api.operationsAiLabel.value,'最近檢測正常');assert.equal(p.api.operationsCartLabel.value,'2 筆受阻／失敗');
 assert.equal(p.api.operationsTrackingLabel.value,'新增 1 · 已知待查 9');
 assert.match(p.api.operationsFeedbackLabel.value,/未結 2/);assert.match(p.api.operationsErrorsLabel.value,/非未修復數/);
 assert.deepEqual(p.calls.filter(c=>c.action).map(c=>c.action),['CREATE_ADMIN_SESSION','ADMIN_GET_CART_ACTIVITY']);
 const req=p.calls.find(c=>c.url);assert.equal(req.url,'https://hooktea.test/api/line-oa/safety-status');assert.equal(req.options.headers['x-hooktea-admin-session'],'private-session');assert.equal(req.options.redirect,'error');
});
test('partial read failure does not invent healthy state or erase other summary',async()=>{
 const p=app({failSafety:true});await p.api.loadOperationsStatus();assert.equal(p.api.operationsAiLabel.value,'狀態讀取失敗');assert.equal(p.api.operationsCartLabel.value,'2 筆受阻／失敗');
 const q=app({failCart:true});await q.api.loadOperationsStatus();assert.equal(q.api.operationsCartLabel.value,'紀錄讀取失敗');assert.equal(q.api.operationsAiLabel.value,'最近檢測正常');
});
test('malformed status is unknown, not zero incidents',async()=>{
 const p=app({safety:{ai:{status:'healthy'}}});await p.api.loadOperationsStatus();assert.equal(p.api.operationsAiHealthy.value,false);assert.equal(p.api.operationsTrackingLabel.value,'狀態讀取失敗');
});
test('unauthenticated and non-admin clients never request summaries',async()=>{
 for(const config of [{authenticated:false},{admin:false}]){const p=app(config);await p.api.loadOperationsStatus();assert.equal(p.calls.length,0);}
});
test('cart issue link clears unrelated search and selects combined error view',()=>{
 const p=app();p.api.openOperationCartIssues();assert.equal(p.c.cartActivitySearch.value,'');assert.equal(p.c.cartActivityStatus.value,'ISSUES');assert.deepEqual(p.routes,['cart_activity']);
 assert.match(html,/value="BLOCKED">結帳受阻/);assert.match(html,/filter\(isOperationCartIssue\)/);
 assert.equal(p.api.cartActivityErrorText({errorMessage:'points_unavailable'}),'點數尚未確認，折抵受阻');
});
