import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const presentation = html.slice(html.indexOf('// Cart activity presentation:'), html.indexOf('// End cart activity presentation.'));
const loader = html.slice(html.indexOf('const loadCartActivity = async'), html.indexOf('const cartActivityStatusText ='));
function app({status='ALL', search='', fail=false}={}) {
  const calls=[];
  const c={ref:value=>({value}),computed:fn=>({get value(){return fn();}}),
    cartActivityStatus:{value:status},cartActivitySearch:{value:search},isLoadingCartActivity:{value:false},
    cartActivityLogs:{value:[]},cartActivityDiagnostic:{value:null},isAdminRole:{value:true},
    alert:()=>{},isOperationCartIssue:r=>r.status==='blocked',
    callApi:async(action,payload)=>{calls.push({action,payload});if(fail)throw Error('offline');return {logs:[{status:'active'}]};}};
  vm.createContext(c);
  vm.runInContext(presentation+loader+'\nglobalThis.api={cartActivityHasFilter,cartActivityFilterSummary,cartActivityEmptyText,cartActivityLoadError,clearCartActivityFilters,loadCartActivity};',c);
  return {c,calls,api:c.api};
}
test('filtered empty view explains filters rather than absence of all records',()=>{
  for(const status of ['ISSUES','BLOCKED','FAILED','ACTIVE']) {
    const {api}=app({status});assert.equal(api.cartActivityHasFilter.value,true);
    assert.match(api.cartActivityEmptyText.value,/沒有符合目前篩選/);
  }
  assert.match(app({search:'example'}).api.cartActivityEmptyText.value,/沒有符合目前篩選/);
  assert.match(app({status:'ISSUES'}).api.cartActivityFilterSummary.value,/受阻／失敗.*500/);
});
test('unfiltered empty view distinguishes saved activity from order records',()=>{
  const {api}=app();assert.equal(api.cartActivityHasFilter.value,false);
  assert.match(api.cartActivityEmptyText.value,/已保存.*訂單維護/);
});
test('loading and failed reads never appear as no records',async()=>{
  const {c,api}=app({fail:true});c.isLoadingCartActivity.value=true;
  assert.match(api.cartActivityEmptyText.value,/載入中/);
  await api.loadCartActivity();assert.match(api.cartActivityEmptyText.value,/讀取失敗/);
  assert.equal(c.isLoadingCartActivity.value,false);
});
test('clear action removes search and status and fetches all saved activity',async()=>{
  const {c,api,calls}=app({status:'ISSUES',search:'old'});api.cartActivityLoadError.value=true;
  await api.clearCartActivityFilters();assert.equal(c.cartActivityStatus.value,'ALL');
  assert.equal(c.cartActivitySearch.value,'');assert.equal(api.cartActivityLoadError.value,false);
  assert.equal(c.cartActivityLogs.value.length,1);
  assert.equal(calls[0].action,'ADMIN_GET_CART_ACTIVITY');assert.equal(calls[0].payload.status,'ALL');
});
test('template binds summary, empty state and clear action without old misleading text',()=>{
  assert.match(html, /\{\{ cartActivityEmptyText \}\}/);assert.match(html, /@click="clearCartActivityFilters"/);
  assert.match(html, /\{\{ cartActivityFilterSummary \}\}/);assert.doesNotMatch(html,/目前沒有購物車紀錄/);
});
