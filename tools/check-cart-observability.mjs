import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const worker=fs.readFileSync(new URL('../worker.js',import.meta.url),'utf8');
const admin=fs.readFileSync(new URL('../admin.html',import.meta.url),'utf8');
test('v2 storage preserves context without CRM lookup or trusting claimed verification',async()=>{
  let saved,lookups=0;
  const c={URL,findHuaxuMemberByLineUidFast:async()=>{lookups++;throw Error('unexpected');},safeGetKV:async()=>[],safePutKV:async(_e,_k,value)=>{saved=value;}};
  vm.createContext(c);vm.runInContext(worker.slice(worker.indexOf('const SHOP_CART_ACTIVITY_KEY'),worker.indexOf('async function resolvePointUid'))+'\nglobalThis.append=appendShopCartActivity;',c);
  const event=await c.append({},null,{schemaVersion:2,lineUserId:'Utest',displayName:'Test',identitySource:'verified',identityState:'member_loaded',sessionId:'session-1',pageId:'page-1',attemptId:'attempt-1',sequence:3,stage:'member_timeout',elapsedMs:7001,httpStatus:503,errorCode:'MEMBER_READ_TIMEOUT',items:[{id:'tea',name:'茶',quantity:2,price:300}],subtotal:600,payable:550,pointsUsed:50,snapshotAvailable:true,href:'https://shop.test/huaxu-shop.html?code=secret#private'});
  assert.equal(lookups,0);assert.equal(event.identitySource,'client_line');
  assert.equal(event.itemsCount,2);assert.equal(event.subtotal,600);
  assert.equal(event.sessionId,'session-1');assert.equal(event.httpStatus,503);
  assert.equal(event.href,'https://shop.test/huaxu-shop.html');assert.equal(saved.length,1);
});
const c={};vm.createContext(c);
vm.runInContext(admin.slice(admin.indexOf('const cartActivityStatusText ='),admin.indexOf('// Operations status:'))+'\nglobalThis.api={cartActivityStatusText,cartActivityHasSnapshot,cartActivityStageText,cartActivityIdentityText};',c);
test('old blank records are unknown, not zero purchase or proven checkout attempt',()=>{
  const row={eventType:'checkout_blocked',stage:'member_timeout',status:'blocked',itemsCount:0,subtotal:0};
  assert.equal(c.api.cartActivityHasSnapshot(row),false);
  assert.equal(c.api.cartActivityStatusText(row),'會員資料讀取失敗');
  assert.match(c.api.cartActivityStageText(row),/未證明曾按結帳/);
});
test('admin differentiates exits, redirects, cancellation and observed identities',()=>{
  assert.match(c.api.cartActivityStatusText({eventType:'page_leave',stage:'payment_redirect'}),/前往付款/);
  assert.match(c.api.cartActivityStatusText({eventType:'page_leave'}),/原因未確認/);
  assert.match(c.api.cartActivityStatusText({status:'closed'}),/非取消/);
  assert.equal(c.api.cartActivityStatusText({status:'cancelled'}),'已確認取消');
  assert.match(c.api.cartActivityIdentityText({schemaVersion:2,lineUserId:'Utest',identityState:'member_loaded'}),/未獨立驗證/);
  assert.match(admin,/@click="showCartActivitySession\(row\)"/);
});
