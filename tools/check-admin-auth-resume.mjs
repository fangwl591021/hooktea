import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const admin=fs.readFileSync(new URL('../admin.html',import.meta.url),'utf8');
const monitor=fs.readFileSync(new URL('../line-oa-monitor.html',import.meta.url),'utf8');
function harness({loggedIn=true,access={isAdmin:true,canCrmLogin:true,userId:'verified'},cache='{}',quota=false,password='',url='https://hooktea.test/admin.html'}={}) {
  const calls=[],storage=new Map(password?[['act_admin_pwd',password]]:[]),initCalls=[],redirects=[];
  const ctx={URL,setTimeout,clearTimeout,CACHE_KEY:'cache',operatorDefaultView:'members',
    isAuthenticated:{value:false},isCheckingAuth:{value:false},authCheckMessage:{value:''},isLoading:{value:false},
    currentAccess:{value:{}},liffProfile:{value:{}},view:{value:'dashboard'},
    isAdminRole:{get value(){return !!ctx.currentAccess.value.isAdmin;}},
    localStorage:{getItem:()=>cache,removeItem:()=>{},setItem:()=>{if(quota)throw Error('Quota');}},
    sessionStorage:{getItem:k=>storage.get(k)||'',removeItem:k=>storage.delete(k)},
    window:{location:{href:url}},console:{log(){}},alert:()=>{},
    resolveCrmLiffId:()=> 'mock-liff',callApi:async(action)=>{calls.push(action);return action==='GET_SETTINGS'?{crm_line_login_enabled:'true'}:access;},
    switchView:v=>{if(ctx.isAuthenticated.value)ctx.view.value=v;},fetchData:async()=>{calls.push('fetchData');},
    liff:{init:async p=>{initCalls.push(p);},isLoggedIn:()=>loggedIn,getIDToken:()=>loggedIn?'synthetic-token':null,getAccessToken:()=>null,getProfile:async()=>({userId:'verified'}),login:p=>redirects.push(p),logout:()=>redirects.push('logout')}
  };
  vm.createContext(ctx);
  const helpers=admin.slice(admin.indexOf('let crmLiffInit'),admin.indexOf('const callApi'));
  const resume=admin.slice(admin.indexOf('const autoLineLogin'),admin.indexOf('const handleLogin'));
  const route=admin.slice(admin.indexOf('const applyRequestedAdminView'),admin.indexOf('const currentViewName'));
  vm.runInContext(helpers+resume+route+'globalThis.api={autoLineLogin,lineLogin,acceptVerifiedLogin,initCrmLiff,applyRequestedAdminView};',ctx);
  return {ctx,calls,storage,initCalls,redirects,api:ctx.api};
}
test('existing LINE authorization resumes only after server verification and does not redirect',async()=>{
  const h=harness();await h.api.autoLineLogin();assert(h.ctx.isAuthenticated.value);
  assert.deepEqual(h.calls,['GET_SETTINGS','CHECK_USER']);assert.equal(h.redirects.length,0);
});
test('full or malformed optional cache cannot prevent verified login',async()=>{
  for(const options of [{quota:true},{cache:'bad-json',quota:true}]) {
    const h=harness(options);await h.api.autoLineLogin();assert(h.ctx.isAuthenticated.value);assert.equal(h.redirects.length,0);
  }
});
test('existing password is reverified without relying on local role flags',async()=>{
  const h=harness({password:'existing'});await h.api.autoLineLogin();assert(h.ctx.isAuthenticated.value);assert.deepEqual(h.calls,['CHECK_USER']);assert.equal(h.initCalls.length,0);
});
test('anonymous or revoked permissions cannot enter from cached roles',async()=>{
  const h=harness({access:{isAdmin:false,canCrmLogin:false},cache:'{"isAdmin":true}'});await h.api.autoLineLogin();assert.equal(h.ctx.isAuthenticated.value,false);
});
test('silent signed-out resume never logs out or initiates login redirects',async()=>{
  const h=harness({loggedIn:false});await h.api.autoLineLogin();assert.equal(h.ctx.isAuthenticated.value,false);assert.equal(h.redirects.length,0);assert.deepEqual(h.calls,['GET_SETTINGS']);
});
test('manual login is blocked during startup and reuses LIFF initialization afterward',async()=>{
  const h=harness();h.ctx.isCheckingAuth.value=true;await h.api.lineLogin();assert.equal(h.calls.length,0);
  h.ctx.isCheckingAuth.value=false;await Promise.all([h.api.initCrmLiff('mock'),h.api.initCrmLiff('mock')]);assert.equal(h.initCalls.length,1);
});
test('transient authorization failure leaves login closed until checking completes and explains retry',async()=>{
  const h=harness();h.ctx.callApi=async()=>{throw Error('network unavailable');};await h.api.autoLineLogin();assert.equal(h.ctx.isAuthenticated.value,false);assert.match(h.ctx.authCheckMessage.value,/無法完成/);assert.equal(h.redirects.length,0);
});
test('navigation accepts only known same-site views after verified login',()=>{
  const h=harness({url:'https://hooktea.test/admin.html?view=points_ledger'});
  h.api.applyRequestedAdminView();assert.equal(h.ctx.view.value,'dashboard');h.api.acceptVerifiedLogin({isAdmin:true,userId:'verified'});h.api.applyRequestedAdminView();assert.equal(h.ctx.view.value,'points_ledger');
  h.ctx.window.location.href='https://hooktea.test/admin.html?view=unknown';h.api.applyRequestedAdminView();assert.equal(h.ctx.view.value,'points_ledger');
  for(const v of ['members','points_ledger','paid_broadcast','richmenu'])assert(monitor.includes('/admin.html?view='+v));
});
test('checking screen hides login; startup fetch is not duplicated and scripts parse',()=>{
  assert.match(admin,/v-if="isCheckingAuth"/);assert.match(admin,/v-else-if="!isAuthenticated"/);
  const resume=admin.slice(admin.indexOf('const autoLineLogin'),admin.indexOf('const lineLogin'));assert.doesNotMatch(resume,/fetchData\(|ensureLineToken\(|liff\.login\(|liff\.logout\(/);
  assert.match(admin,/finally \{ isCheckingAuth.value = false; \}/);
  for(const script of admin.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
});
