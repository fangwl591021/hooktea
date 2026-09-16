import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);
const html=fs.readFileSync(new URL('line-oa-monitor.html',root),'utf8');
const admin=fs.readFileSync(new URL('admin.html',root),'utf8');
const prefix=fs.readFileSync(new URL('tools/check-hooktea-regressions.mjs',root),'utf8').split("test('different simultaneous rewards")[0]
 .replace("'../point-service.js'",JSON.stringify(new URL('point-service.js',root).href))
 .replace("new URL('../', import.meta.url)",`new URL(${JSON.stringify(root.href)})`);
const {runtime,UID}=await import('data:text/javascript;base64,'+Buffer.from(prefix+'\nexport {runtime,UID};').toString('base64'));
function page(values={},respond=async()=>Response.json({success:true,data:[]})) {
 const storage=new Map(Object.entries(values)),elements=new Map(),calls=[],alerts=[];
 const ctx={URL,URLSearchParams,location:{origin:'https://hooktea.test',protocol:'https:'},
  sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
  document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{hidden:false,style:{}});return elements.get(id);}},
  fetch:async(...args)=>{calls.push(args);return respond(...args);},alert:m=>alerts.push(m),prompt:()=>{throw Error('password prompt forbidden');}};
 vm.createContext(ctx);
 vm.runInContext(html.slice(html.indexOf('const WORKER_URL'),html.indexOf('function normalizeThread'))+'\nglobalThis.api={fetchJson,notifyError,state};',ctx);
 return {ctx,storage,elements,calls,alerts,api:ctx.api};
}
test('monitor sends the existing session in a header, never in URL or with password',async()=>{
 const p=page({hooktea_admin_session:'session',act_admin_pwd:'fallback'});
 await p.api.fetchJson('/api/line-oa/threads');
 assert.equal(p.calls[0][1].headers['x-hooktea-admin-session'],'session');
 assert.equal(p.calls[0][1].headers['x-hooktea-admin-password'],undefined);
 assert.equal(p.calls[0][0],'https://hooktea.test/api/line-oa/threads');
 assert.equal(p.calls[0][1].redirect,'error');
});
test('missing credentials show login link without network or password prompt',async()=>{
 const p=page();await assert.rejects(p.api.fetchJson('/api/line-oa/threads'),e=>e.authRequired);
 assert.equal(p.calls.length,0);assert.equal(p.elements.get('monitor-app').style.display,'none');
 assert.equal(p.elements.get('monitor-auth').hidden,false);assert.match(html,/href="\/admin.html"/);
});
for(const status of [401,403])test(`HTTP ${status} clears auth, blocks parallel responses and never replays a write`,async()=>{
 let finish;const pending=new Promise(r=>finish=r);
 const p=page({hooktea_admin_session:'expired',act_admin_pwd:'fallback'},async url=>url.endsWith('/read')?pending:Response.json({success:false},{status}));
 const read=p.api.fetchJson('/read');const write=p.api.fetchJson('/write',{method:'POST',body:'{}'});
 await assert.rejects(write,e=>e.authRequired);finish(Response.json({success:true}));
 await assert.rejects(read,e=>e.authRequired);assert.equal(p.calls.length,2);
 assert.equal(p.storage.size,0);await assert.rejects(p.api.fetchJson('/again'),e=>e.authRequired);
 assert.equal(p.calls.length,2);
});
test('password-authenticated CRM remains compatible without prompting',async()=>{
 const p=page({act_admin_pwd:'existing'});await p.api.fetchJson('/read');
 assert.equal(p.calls[0][1].headers['x-hooktea-admin-password'],'existing');
});
test('network or server failure does not clear auth; foreign origin receives no credential',async()=>{
 const p=page({hooktea_admin_session:'session'},async()=>Response.json({error:'unavailable'},{status:503}));
 await assert.rejects(p.api.fetchJson('/read'),/unavailable/);assert.equal(p.storage.get('hooktea_admin_session'),'session');
 await assert.rejects(p.api.fetchJson('https://other.test/read'),/不允許/);assert.equal(p.calls.length,1);
});
test('CRM entry awaits server authorization and suppresses double clicks',async()=>{
 let finish;const pending=new Promise(r=>finish=r);let count=0;const storage=new Map();
 const ctx={callApi:async action=>{assert.equal(action,'CREATE_ADMIN_SESSION');count++;return pending;},
  sessionStorage:{setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},window:{location:{href:'/admin.html'}},alert:()=>assert.fail('unexpected alert')};
 vm.createContext(ctx);vm.runInContext(admin.slice(admin.indexOf('let openingLineMonitor'),admin.indexOf('const openCheckinTemplate'))+'globalThis.open=openLineMonitor;',ctx);
 const first=ctx.open();await ctx.open();assert.equal(count,1);assert.equal(ctx.window.location.href,'/admin.html');
 finish({token:'verified-session'});await first;assert.equal(storage.get('hooktea_admin_session'),'verified-session');
 assert.equal(ctx.window.location.href,'./line-oa-monitor.html');assert.match(admin,/@click.prevent="openLineMonitor"/);
});
test('CRM rejected session stays on CRM and clears stale authorization',async()=>{
 const storage=new Map([['hooktea_admin_session','stale']]);const messages=[];
 const ctx={callApi:async()=>{throw Error('Admin authorization required');},sessionStorage:{setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},window:{location:{href:'/admin.html'}},alert:m=>messages.push(m)};
 vm.createContext(ctx);vm.runInContext(admin.slice(admin.indexOf('let openingLineMonitor'),admin.indexOf('const openCheckinTemplate'))+'globalThis.open=openLineMonitor;',ctx);
 await ctx.open();assert.equal(storage.size,0);assert.equal(ctx.window.location.href,'/admin.html');assert.equal(messages.length,1);
});
test('backend denies anonymous, ordinary member and CRM-only operator session issuance',async()=>{
 for(const access of [{},{userId:UID,hasVerifiedLineUser:true},{userId:UID,hasVerifiedLineUser:true,canCrmLogin:true}]){
  const h=runtime();h.sandbox.resolveAccess=async()=>({...access,settings:{}});
  const body=await(await h.action('CREATE_ADMIN_SESSION')).json();assert.equal(body.status,'error');
  assert.equal([...h.values.keys()].some(k=>k.startsWith('HOOKTEA_ADMIN_SESSION_')),false);
 }
});
test('backend accepts genuine issued session and rejects expired or fabricated session',async()=>{
 const h=runtime();h.sandbox.resolveAccess=async()=>({userId:UID,isAdmin:true,settings:{}});
 const body=await(await h.action('CREATE_ADMIN_SESSION')).json();assert.equal(body.status,'success');
 const token=body.data.token;const authorize=h.get('requireHookTeaMonitorAdmin');
 const req=t=>new Request('https://hooktea.test/api/line-oa/threads',{headers:{'x-hooktea-admin-session':t}});
 assert.equal((await authorize(req(token),h.env)).ok,true);
 assert.equal((await authorize(req('f'.repeat(32)),h.env)).ok,false);
 h.values.get('HOOKTEA_ADMIN_SESSION_'+token).expiresAt='2000-01-01T00:00:00Z';
 assert.equal((await authorize(req(token),h.env)).ok,false);
 assert.equal((await authorize(new Request('https://hooktea.test/api/line-oa/threads'),h.env)).ok,false);
});
test('no automatic prompt, query password import or startup auth alert remains',()=>{
 assert.doesNotMatch(html,/prompt\(|urlPassword|params.get\("adminPassword"\)/);
 assert.match(html,/loadAll\(false\).catch\(notifyError\)/);
 for(const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
 for(const script of admin.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
});
