import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('// Order purchase presentation:'), html.indexOf('// End order purchase presentation.'));
const ctx = {formatPrice: n => Number(n).toLocaleString('en-US')};
vm.createContext(ctx);
vm.runInContext(source + '\nglobalThis.api={orderPurchasedItems,orderSnapshotNumber,orderSnapshotMoney};', ctx);
const {orderPurchasedItems: items, orderSnapshotMoney: money} = ctx.api;

test('all saved product lines display snapshot quantity and price without mutation', () => {
  const order = {type:'PRODUCT', productName:'old summary', items:[
    {name:'檸檬茶', code:'A', quantity:2, price:350, lineTotal:700},
    {name:'茶包', id:'B', quantity:1, price:350, lineTotal:350}]};
  const before = JSON.stringify(order);
  const lines = items(order);
  assert.equal(lines.length, 2); assert.equal(lines[0].name, '檸檬茶');
  assert.equal(lines[0].quantity, 2); assert.equal(lines[0].price, 350);
  assert.equal(lines[1].lineTotal, 350); assert.equal(lines[1].code, 'B');
  assert.equal(JSON.stringify(order), before);
});
test('legacy single product uses saved fields, never divides the paid amount', () => {
  const line = items({type:'PRODUCT', productName:'舊茶包', quantity:3, unitPrice:400, originalAmount:1200, amount:1050})[0];
  assert.equal(line.quantity, 3); assert.equal(line.price, 400); assert.equal(line.lineTotal, 1200);
  assert.equal(items({type:'PRODUCT', productName:'只有名稱', amount:1050})[0].price, null);
});
test('legacy multiple-product summary is preserved without assigning total quantity per line', () => {
  const line = items({type:'PRODUCT', productName:'甲 x 2\n乙', productId:'A,B', quantity:3, originalAmount:1050})[0];
  assert.equal(line.name, '甲 x 2\n乙'); assert.equal(line.quantity, null); assert.equal(line.lineTotal, null);
});
test('unknown and malformed amounts remain unknown; explicit zero stays zero', () => {
  for (const value of [undefined, null, '', ' ', false, {}, [], 'bad', -1, Infinity]) assert.equal(money(value), '未記錄');
  assert.equal(money(0), '$0'); assert.equal(money('1050'), '$1,050');
  assert.equal(items({type:'PRODUCT', items:[null, 'bad']})[0].name, '商品明細未記錄');
  assert.equal(items({type:'COURSE'}).length, 0);
});
test('purchase section belongs to edit modal, is read-only, and uses escaped Vue text', () => {
  const modal = html.slice(html.indexOf('<div v-if="editingOrder"'), html.indexOf('const editingOrder ='));
  const block = modal.slice(modal.indexOf('<section'), modal.indexOf('</section>'));
  assert.match(block, /order-purchased-items/);
  assert.match(block, /orderPurchasedItems\(editingOrder\)/);
  assert.match(block, /\{\{ item.name \}\}/);
  assert.doesNotMatch(block, /v-html|v-model|<input|<button|callApi/);
  assert.match(block, /editingOrder.shippingFee/); assert.match(block, /editingOrder.pointsUsed/);
  const save = html.slice(html.indexOf('const saveOrderUpdate ='), html.indexOf('const transferOrder', html.indexOf('const saveOrderUpdate =')));
  assert.doesNotMatch(save, /items:\s*editingOrder|productName:\s*editingOrder/);
});
test('order table does not truncate multi-item names and has neutral all-order labels', () => {
  const start = html.indexOf('<div v-if="canViewFinance && view === \'orders\'"');
  const table = html.slice(start, html.indexOf('<div v-if="canViewFinance && view === \'cart_activity\'"', start));
  assert.match(table, /orderPurchasedItems\(o\)/);
  assert.doesNotMatch(table, /split\('\\n'\)\[0\]/);
  assert.match(table, /商品 \/ 課程/); assert.match(table, /購買 \/ 收件資料/);
});
test('admin inline JavaScript parses', () => {
  for (const s of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if(s[1].trim()) new vm.Script(s[1]);
});
