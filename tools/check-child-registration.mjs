import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const UID = 'U' + 'a'.repeat(32), OTHER = 'U' + 'b'.repeat(32);
const key = uid => 'live/high-risk/users/' + uid + '.json';
function harness(seed = {}) {
  const kv = new Map(Object.entries({SYSTEM_SETTINGS: {liff_id:'2007674851-test'}, USERS_INDEX: [], ...seed}).map(([k,v])=>[k,JSON.stringify(v)]));
  const r2 = new Map(), writes = [], network = [];
  let serial = 0, fail = false, markerFail = false;
  const bucket = {
    async get(k) { if (fail) throw Error('storage offline'); const row = r2.get(k); return row ? { etag:row.etag, text:async()=>row.text } : null; },
    async put(k,text,options={}) {
      if (fail || (markerFail && k.startsWith('live/child-crm/'))) throw Error('storage offline');
      const old = r2.get(k), condition = options.onlyIf;
      if (condition?.etagMatches && old?.etag !== condition.etagMatches) return null;
      if (condition?.etagDoesNotMatch === '*' && old) return null;
      const row={text,etag:String(++serial)}; r2.set(k,row); writes.push(k); return row;
    },
    async list({prefix}) {return {objects:[...r2.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false};}
  };
  const env = {'act-image':bucket, ACTION_DATA:{get:async k=>kv.get(k)??null, put:async(k,v)=>kv.set(k,v),list:async({prefix})=>({keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true})}};
  const sandbox={console,URL,URLSearchParams,Request,Response,Headers,AbortSignal,TextEncoder,TextDecoder,crypto:webcrypto,setTimeout,clearTimeout,atob,btoa,
    createPointService:()=>{throw Error('unexpected points mutation');},
    fetch:async url=>{network.push(String(url)); if(String(url).startsWith('https://api.line.me/oauth2/'))return Response.json({client_id:'2007674851',expires_in:3600}); if(String(url)==='https://api.line.me/v2/profile')return Response.json({userId:UID,displayName:'LINE Name'}); throw Error('unexpected network');}
  };
  vm.createContext(sandbox);
  vm.runInContext(source.replace(/^import[^\n]+\n/gm,'').replace(/export default\s+\{/,'globalThis.worker = {'),sandbox);
  sandbox.observeHighRiskDualWrite=()=>Promise.resolve();
  sandbox.getHuaxuShopOrders=async()=>[];
  sandbox.readAuthoritativePoints=async()=>({balance:17,logs:[{amount:17,reason:'unchanged'}]});
  const ctx={waitUntil(p){p.catch(()=>{});}};
  const req=(profile,extra={})=>new Request('https://test/api/huaxu/member',{method:profile?'PUT':'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accessToken:'synthetic',lineUserId:UID,...(profile?{profile}:{}),...extra})});
  const invoke=(fn,request=req())=>sandbox[fn](request,env,ctx);
  return {env,ctx,kv,r2,writes,network,sandbox,req,invoke,setFail:v=>fail=v,setMarkerFail:v=>markerFail=v};
}
test('verified login creates one pending CRM, repeat login does not complete registration or change points',async()=>{
  const h=harness();
  for(let i=0;i<2;i++){
    const r=await h.invoke('handleHuaxuMemberProfile'); assert.equal(r.status,200);
    const body=await r.json(); assert.equal(body.member.registrationStatus,'pending'); assert.equal(body.memberUid,UID); assert.equal(body.points.balance,17);
  }
  assert.equal([...h.r2.keys()].filter(k=>k.startsWith('live/high-risk/users/')).length,1);
  assert.equal(h.writes.some(k=>k.includes('points/')),false);
  assert(h.network.every(url=>url.startsWith('https://api.line.me/')));
});
test('registration completes same UID, preserves private CRM fields/history, ignores role and identity injection',async()=>{
  const current={userId:UID,lineUserId:UID,linkedLineUid:UID,registrationStatus:'pending',adminNote:'preserve',role:'member',history:[{old:true}]};
  const h=harness({['USER_'+UID]:current});
  const profile={name:'王測試',phone:'0912345678',role:'admin',userId:OTHER,registrationStatus:'pending'};
  for(let i=0;i<2;i++){
    const response=await h.invoke('handleHuaxuUpdateMemberProfile',h.req(profile));
    assert.equal(response.status,200);assert.equal((await response.json()).member.registrationStatus,'registered');
  }
  const saved=JSON.parse(h.r2.get(key(UID)).text);
  assert.equal(saved.userId,UID);assert.equal(saved.role,'member');assert.equal(saved.adminNote,'preserve');assert.deepEqual(saved.history,current.history);
  assert.equal([...h.r2.keys()].filter(k=>k.startsWith('live/high-risk/users/')).length,1);
});
test('existing exact legacy UID is reused even without LINE_BIND cache; nickname alone never matches',async()=>{
  const old={userId:'legacy-1',lineUserId:UID,name:'Existing',phone:'0912345678',adminNote:'keep'};
  const h=harness({'USER_legacy-1':old,USERS_INDEX:[old]});
  const body=await (await h.invoke('handleHuaxuMemberProfile')).json();
  assert.equal(body.memberUid,'legacy-1');assert.equal(body.member.registrationStatus,'registered');assert.equal(h.r2.has(key(UID)),false);
  assert.equal((await h.invoke('handleHuaxuUpdateMemberProfile',h.req({name:'Existing',phone:'0912345678'}))).status,200);
  assert.equal(JSON.parse(h.r2.get(key('legacy-1')).text).adminNote,'keep');
  const stranger={userId:'legacy-2',name:'LINE Name',phone:'0912345678'};
  const other=harness({'USER_legacy-2':stranger,USERS_INDEX:[stranger]});
  assert.equal((await (await other.invoke('handleHuaxuMemberProfile')).json()).memberUid,UID);
});
test('missing fields do not mark registration complete; spoofed UID is rejected',async()=>{
  const h=harness();await h.invoke('handleHuaxuMemberProfile');
  for(const profile of [{name:'A',phone:''},{name:'A',phone:'123'}, {name:'A',phone:'0912345678',email:'bad'}]){
    assert.equal((await h.invoke('handleHuaxuUpdateMemberProfile',h.req(profile))).status,400);
  }
  assert.equal(JSON.parse(h.r2.get(key(UID)).text).registrationStatus,'pending');
  assert.equal((await h.invoke('handleHuaxuUpdateMemberProfile',h.req({name:'A',phone:'0912345678'},{lineUserId:OTHER}))).status,403);
});
test('pending members can call signin; checkout rejected before DB/order/payment work even without points',async()=>{
  const h=harness();await h.invoke('handleHuaxuMemberProfile');
  let claims=0;
  h.sandbox.claimHookTeaReward=async()=>{claims++;return {ok:true,duplicate:false,balance:18};};
  assert.equal((await h.invoke('handleHuaxuMemberCheckin')).status,200);assert.equal(claims,1);
  const order=await h.invoke('handleHuaxuCreateOrder',h.req(null,{items:[{id:'tea',quantity:1}],pointsUsed:0,member:{registrationStatus:'registered'}}));
  assert.equal(order.status,409);assert.equal((await order.json()).code,'MEMBER_REGISTRATION_REQUIRED');
});
test('concurrent create/complete cannot reset pending, and CRM enumeration survives stale global index',async()=>{
  const h=harness();
  await Promise.all(Array.from({length:5},()=>h.sandbox.ensureFastLineCheckinMember(h.env,h.ctx,UID,{name:'A'})));
  await Promise.all([h.invoke('handleHuaxuUpdateMemberProfile',h.req({name:'王測試',phone:'0912345678'})),h.sandbox.ensureFastLineCheckinMember(h.env,h.ctx,UID,{name:'A'})]);
  assert.equal(JSON.parse(h.r2.get(key(UID)).text).registrationStatus,'registered');
  h.kv.set('USERS_INDEX',JSON.stringify([{userId:'unrelated'}]));
  const members=await h.sandbox.listUserRecords(h.env);assert.equal(members.find(x=>x.userId===UID).registrationStatus,'registered');
});
test('storage outage does not report successful CRM creation; retry repairs marker failure',async()=>{
  const h=harness();h.setFail(true);
  assert.notEqual((await h.invoke('handleHuaxuMemberProfile')).status,200);assert.equal(h.writes.length,0);
  h.setFail(false);h.setMarkerFail(true);
  assert.equal((await h.invoke('handleHuaxuMemberProfile')).status,503);
  h.setMarkerFail(false);assert.equal((await h.invoke('handleHuaxuMemberProfile')).status,200);
  assert.equal((await h.sandbox.listUserRecords(h.env)).filter(x=>x.userId===UID).length,1);
});

test('preexisting KV-only pending profile receives a real R2 copy before CRM marker is written',async()=>{
  const h=harness({['USER_'+UID]:{userId:UID,lineUserId:UID,registrationStatus:'pending',name:'Old KV'}});
  assert.equal((await h.invoke('handleHuaxuMemberProfile')).status,200);
  assert.equal(JSON.parse(h.r2.get(key(UID)).text).name,'Old KV');
  assert.equal((await h.sandbox.listUserRecords(h.env)).find(x=>x.userId===UID).name,'Old KV');
});
