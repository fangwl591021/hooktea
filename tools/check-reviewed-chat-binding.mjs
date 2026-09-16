// Production resolver code, synthetic records only. No network or production writes.
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const src=readFileSync(new URL('../worker.js',import.meta.url),'utf8');
const uid='U'+'f'.repeat(32),old='old-crm',rows=new Map([
 ['USER_'+uid,{userId:uid,lineUserId:uid,linkedLineUid:uid,name:'chat account'}],
 ['USER_'+old,{userId:old,lineUserId:uid,linkedLineUid:uid,name:'legacy account'}],
 ['LINE_BIND_'+uid,{lineUserId:uid,legacyUserId:uid,source:'admin_verified_chat'}],
 ['POINTS_ALIAS_'+uid,{targetUid:uid,source:'admin_verified_chat'}],
]);
let writes=0;const context=vm.createContext({console,URL,Response,Request,Headers});
new vm.Script(src.replace(/^import[^\n]+\n/gm,'').replace(/\bexport default\s+\{/,'globalThis.__worker = {')).runInContext(context);
context.safeGetKV=async(_e,k,f)=>rows.get(k)||f;
context.listKVRecords=async(_e,p)=>[...rows].filter(([k])=>k.startsWith(p)).map(([key,data])=>({key,data}));
context.safePutKV=async()=>{writes++;};context.putUserKV=async()=>{writes++;};
context.createHookTeaPointService=()=>({wallet:async()=>null});
const bucket={get:async k=>{const id=decodeURIComponent(k.split('/').at(-1).replace(/\.json$/,''));const row=k.includes('/users/')?rows.get('USER_'+id):rows.get('POINTS_'+id);return row?{text:async()=>JSON.stringify(row)}:null;}};
const env={HOOKTEA_NEW_MEMBER_CHILD_POINTS:'true','act-image':bucket,ACTION_DATA:{get:async k=>rows.has(k)?JSON.stringify(rows.get(k)):null}};
const fn=n=>vm.runInContext(n,context);
assert.equal((await fn('findHuaxuMemberByLineUid')(env,uid)).memberUid,uid);
assert.equal(await fn('resolvePointUid')(env,uid),uid);
assert.equal(await fn('resolveMonitorThreadIdForLine')(env,uid),uid);
await fn('repairHuaxuLineBindingInBackground')(env,null,uid);
assert.equal(writes,0);assert.equal(rows.get('USER_'+old).name,'legacy account');
console.log('PASS chat, CRM and point identity choose reviewed UID; background cannot rebind or merge older record');
