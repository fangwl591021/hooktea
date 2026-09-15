import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);
const prefix=fs.readFileSync(new URL('tools/check-hooktea-regressions.mjs',root),'utf8').split("test('different simultaneous rewards")[0]
 .replace("'../point-service.js'",JSON.stringify(new URL('point-service.js',root).href))
 .replace("new URL('../', import.meta.url)",`new URL(${JSON.stringify(root.href)})`);
const {runtime,UID}=await import('data:text/javascript;base64,'+Buffer.from(prefix+'\nexport {runtime,UID};').toString('base64'));
function admin(options={}){const h=runtime(options);h.sandbox.resolveAccess=async()=>({userId:UID,isAdmin:true,settings:{}});return h;}
const missing=admin({values:{USER_legacy:{userId:'legacy',name:'Synthetic'}}});
let body=await(await missing.action('GET_USER_POINTS',{targetUid:'legacy'})).json();
assert.equal(body.status,'success');assert.equal(body.data.error,'POINT_MEMBER_REQUIRES_LINE_BINDING');assert.equal(body.data.balance,null);assert.equal(missing.state.posts,0);
const conflict=admin({values:{USER_legacy:{userId:'legacy',lineUserId:UID,linkedLineUid:'U'+'b'.repeat(32)}}});
body=await(await conflict.action('GET_USER_POINTS',{targetUid:'legacy'})).json();
assert.equal(body.data.error,'POINT_IDENTITY_CONFLICT');assert.equal(conflict.state.posts,0);
const pending=admin({available:false});
await pending.service.submit(pending.input('pending'),pending.values.get('USER_'+UID));pending.state.available=true;
body=await(await pending.action('GET_USER_POINTS',{targetUid:UID})).json();
assert.equal(pending.state.posts,0);assert.equal((await pending.service.get('pending')).status,'pending_member');assert.equal(body.data.pendingBalance,100);
assert.equal(pending.db.sqlite.prepare('SELECT COUNT(*) AS n FROM point_legacy_snapshots').get().n,0);
console.log('PASS missing binding, conflicting identity and read-only pending preservation');
const html=fs.readFileSync(new URL('admin.html',root),'utf8');
const start=html.indexOf('const openMemberDetail = async');const end=html.indexOf('const toggleMemberSystem',start);
let resolveA;const a=new Promise(resolve=>resolveA=resolve);
const ctx={activeMember:{value:null},activeMemberPoints:{value:{balance:778,logs:[]}},memberPointsLoading:{value:false},memberPointsMessage:{value:''},memberPointsRequest:0,newMemberTag:{value:''},activeMemberPermissionSnapshot:{value:null},canManagePoints:{value:true},normalizedMemberTags:()=>[],isLoading:{value:false},callApi:async(_,p)=>p.targetUid==='A'?a:{available:false,balance:null,logs:[],error:'POINT_MEMBER_REQUIRES_LINE_BINDING'}};
vm.createContext(ctx);vm.runInContext(html.slice(start,end)+'\nglobalThis.open=openMemberDetail;',ctx);
const first=ctx.open({userId:'A'});assert.equal(ctx.isLoading.value,false);assert.equal(ctx.activeMemberPoints.value.balance,null);
await ctx.open({userId:'B'});resolveA({available:true,balance:778,logs:[]});await first;
assert.equal(ctx.activeMember.value.userId,'B');assert.equal(ctx.activeMemberPoints.value.balance,null);assert.match(ctx.memberPointsMessage.value,/尚未完成 LINE/);
assert.equal(ctx.memberPointsLoading.value,false);
console.log('PASS loading separation, stale balance clearing and cross-member response isolation');
