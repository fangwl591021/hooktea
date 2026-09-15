import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {exportCrmPointRoster,exportCrmPointHistory,renderCrmPointExportPage} from '../crm-history-export.js';
const uid='U'+'a'.repeat(32),admin={isAdmin:true},member={userId:'legacy',lineUserId:uid,name:'Test'};
const endpoint='https://aiwe.cc/index.php/wp-json/wetw-point/v1/query-user-point-list';
const config={apiKey:'test-private-key',shopId:35,pointType:'system_point',endpoint};
const values={USERS_INDEX:[member],USER_legacy:member};let reads=0,calls=0;
const read=async key=>{reads++;return structuredClone(values[key]??null);};
const data={success:true,data:{list:[{id:'1',get_point:'-5',point_balance:'778',event_content:'Original reason',created_at:'2026-09-01',extra_detail:'preserve'}],pagination:{total:1,page:1,per_page:100}}};
const fetcher=async(url,options)=>{calls++;assert.equal(url,endpoint);assert.equal(options.redirect,'manual');const body=JSON.parse(options.body);assert.equal(body.shop_id,35);assert.equal(body.LINE_user_id,uid);assert(!url.includes(config.apiKey));return Response.json(data);};
const args={access:admin,payload:{crmId:'legacy'},read,config,fetcher};
let passed=0;async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
await check('unauthorized requests do not read storage or contact mother',async()=>{
  for(const access of [{},{isAdmin:false},{canSystemTools:true}]){
    await assert.rejects(exportCrmPointHistory({...args,access}),/authorization/);
    await assert.rejects(exportCrmPointRoster({access,read,payload:{}}),/authorization/);
  }assert.equal(reads,0);assert.equal(calls,0);
});
await check('roster pages retain unbound accounts and fail on changed index',async()=>{
  values.USERS_INDEX.push({userId:'unbound',name:'Old'});values.USER_unbound={userId:'unbound'};
  const r=await exportCrmPointRoster({access:admin,read,payload:{}});assert.equal(r.total,2);assert.equal(r.members[1].lineUids.length,0);
  assert.equal(r.nextOffset,null);await assert.rejects(exportCrmPointRoster({access:admin,read,payload:{rosterHash:'old'}}),/CHANGED/);
});
await check('preserves original detail and explicit balance without reapplying changes',async()=>{
  const r=await exportCrmPointHistory(args);assert.equal(r.balance,778);assert.equal(r.records[0].get_point,'-5');
  assert.equal(r.records[0].extra_detail,'preserve');assert.equal(r.historyComplete,false);assert.equal(r.metadata['pagination.total'],1);
});
await check('validates page bounds and refuses foreign source destination/scope',async()=>{
  for(const payload of [{crmId:'legacy',page:0},{crmId:'legacy',page:1.5},{crmId:'legacy',perPage:101},{crmId:'absent'}])
    await assert.rejects(exportCrmPointHistory({...args,payload}));
  for(const c of [{...config,shopId:36},{...config,endpoint:'https://example.test/collect'}, {...config,endpoint:endpoint+'?x=1'}])
    await assert.rejects(exportCrmPointHistory({...args,config:c}));
});
await check('unbound and internally conflicting LINE fields cannot query mother',async()=>{
  const before=calls;await assert.rejects(exportCrmPointHistory({...args,payload:{crmId:'unbound'}}),/LINE_REVIEW/);
  values.USER_legacy.linkedLineUid='U'+'b'.repeat(32);await assert.rejects(exportCrmPointHistory(args),/LINE_REVIEW/);delete values.USER_legacy.linkedLineUid;
  assert.equal(calls,before);
});
await check('unknown balance remains null and upstream errors never leak credentials',async()=>{
  const empty=await exportCrmPointHistory({...args,fetcher:async()=>Response.json({success:true,data:{list:[]}})});assert.equal(empty.balance,null);
  await assert.rejects(exportCrmPointHistory({...args,fetcher:async()=>new Response(config.apiKey,{status:403})}),/^Error: CRM_HISTORY_SOURCE_HTTP_403$/);
  const r=await exportCrmPointHistory({...args,fetcher:async()=>Response.json({success:true,data:{list:[{id:1,api_key:config.apiKey,event_content:config.apiKey}]}})});
  assert(!JSON.stringify(r).includes(config.apiKey));assert.equal(r.redactions,2);
});
await check('wrong owner/shop and oversized/malformed responses are rejected',async()=>{
  for(const patch of [{shop_id:36},{point_type:'other'},{LINE_user_id:'U'+'b'.repeat(32)}])await assert.rejects(exportCrmPointHistory({...args,fetcher:async()=>Response.json({success:true,data:{list:[{id:1,...patch}]}})}),/MISMATCH/);
  await assert.rejects(exportCrmPointHistory({...args,fetcher:async()=>new Response('x'.repeat(2*1024*1024+1))}),/TOO_LARGE/);
  await assert.rejects(exportCrmPointHistory({...args,fetcher:async()=>new Response('not json')}),/INVALID_JSON/);
});
await check('source timeout and connection errors are distinguishable without leaking error text',async()=>{
  await assert.rejects(exportCrmPointHistory({...args,fetcher:async()=>new Response(null,{status:302,headers:{location:'https://example.test/blocked'}})}),/CRM_HISTORY_SOURCE_HTTP_302/);
  for(const [name,code] of [['TimeoutError','TIMEOUT'],['AbortError','TIMEOUT'],['TypeError','CONNECTION_FAILED']]) {
    const failure=Object.assign(new Error(config.apiKey),{name});
    await assert.rejects(exportCrmPointHistory({...args,fetcher:async()=>{throw failure;}}),
      new RegExp('^Error: CRM_HISTORY_SOURCE_'+code+'$'));
  }
});

// Real generated client script, mocked LIFF and read-only backend. No DOM tokens
// extracted and no production resource is touched by this test.
async function ui(mode='complete') {
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{disabled:true,textContent:'',value:''});return nodes.get(id);};
  const rows=Array.from({length:201},(_,i)=>({id:String(i+1),get_point:1}));let headCalls=0;
  const ctx={console,URL,Blob,setTimeout,document:{getElementById:node},location:{href:'https://hooktea.test/admin.html?pointExport=1'},
    liff:{init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>null,getAccessToken:()=>null},
    fetch:async(_,options)=>{const {action,payload}=JSON.parse(options.body);let value;
      if(action==='ADMIN_EXPORT_POINT_ROSTER')value={members:[{crmId:'legacy',lineUids:[uid],memberFound:true,identityMatches:true}],total:1,nextOffset:null,rosterHash:'hash'};
      else {if(payload.page===1)headCalls++;const page=mode==='repeat'?1:payload.page;
        value={records:rows.slice((page-1)*100,page*100),metadata:mode==='unknown'?{}:{'pagination.total':201},balance:778,
          pageHash:mode==='changed'&&headCalls>1?'changed':'page'+page};}
      return Response.json({status:'success',data:value});}};
  vm.createContext(ctx);const html=renderCrmPointExportPage('test');const script=html.match(/<script>\n([\s\S]*)<\/script>/)[1];
  await vm.runInContext(script,ctx);await node('roster').onclick();await node('all').onclick();return vm.runInContext('report',ctx);
}
await check('client traverses more than 100 records and checks first page again',async()=>{
  const r=await ui();assert.equal(r.histories[0].recordCount,201);assert.equal(r.histories[0].pages.length,3);assert.equal(r.histories[0].historyComplete,true);
  assert.equal(r.activationAllowed,false);
});
await check('repeated pages keep partial evidence but never certify completeness',async()=>{
  const r=await ui('repeat');assert.equal(r.errors.length,1);assert.equal(r.histories[0].pages.length,2);assert.equal(r.histories[0].historyComplete,false);
});
await check('missing totals and source changes never become complete history',async()=>{
  for(const mode of ['unknown','changed'])assert.equal((await ui(mode)).histories[0].historyComplete,false);
});

const root=new URL('../',import.meta.url),prefix=fs.readFileSync(new URL('tools/check-hooktea-regressions.mjs',root),'utf8').split("test('different simultaneous rewards")[0]
  .replace("'../point-service.js'",JSON.stringify(new URL('point-service.js',root).href))
  .replace("new URL('../', import.meta.url)",`new URL(${JSON.stringify(root.href)})`);
const {runtime}=await import('data:text/javascript;base64,'+Buffer.from(prefix+'\nexport {runtime};').toString('base64'));
await check('actual RPC authorization refuses member and system roles',async()=>{
  for(const access of [{isAdmin:false},{isAdmin:false,canSystemTools:true}]) {
    const h=runtime();h.sandbox.resolveAccess=async()=>access;
    for(const action of ['ADMIN_EXPORT_POINT_ROSTER','ADMIN_EXPORT_POINT_HISTORY_PAGE'])assert.match((await(await h.action(action)).json()).message,/authorization/);
    assert.equal(h.state.posts,0);
  }
});
await check('actual admin RPC and strict source reader perform no writes',async()=>{
  const h=runtime();h.sandbox.exportCrmPointRoster=exportCrmPointRoster;h.sandbox.exportCrmPointHistory=exportCrmPointHistory;
  h.sandbox.resolveAccess=async(...args)=>{assert.equal(args[5].readOnlyProfile,true);return admin;};
  h.env.ACTION_DATA.get=async key=>values[key]??null;h.env.ACTION_DATA.put=async()=>{throw Error('unexpected write');};
  h.env['act-image']={get:async()=>null};
  const response=await(await h.action('ADMIN_EXPORT_POINT_ROSTER')).json();assert.equal(response.status,'success');assert.equal(response.data.total,2);
  h.env['act-image'].get=async()=>{throw Error('source down');};
  assert.match((await(await h.action('ADMIN_EXPORT_POINT_ROSTER')).json()).message,/source down/);
  assert.equal(h.state.posts,0);
});
await check('actual read-only access resolution does not enrich member profile',async()=>{
  const h=runtime();h.sandbox.verifyLineIdToken=async()=>({sub:uid,name:'New',picture:'image'});
  const source=fs.readFileSync(new URL('worker.js',root),'utf8');
  vm.runInContext(source.slice(source.indexOf('async function resolveAccess('),source.indexOf('const STATIC_HTML_FILES')),h.sandbox);
  h.sandbox.findHuaxuMemberByLineUidFast=async()=>({memberUid:uid,member:{userId:uid,role:'admin'}});
  h.sandbox.safePutKV=async()=>{throw Error('unexpected profile write');};
  const a=await h.get('resolveAccess')(h.env,'GUEST',{},'test',null,{readOnlyProfile:true});assert(a.hasVerifiedLineUser);
});
console.log(passed+' history export checks passed');
