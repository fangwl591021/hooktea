import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPointService } from '../point-service.js';

const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('worker.js', root), 'utf8');
const UID = 'U' + 'a'.repeat(32);
const OTHER = 'U' + 'b'.repeat(32);
const member = { userId: UID, lineUserId: UID, linkedLineUid: UID, name: 'Test', phone: '0912345678' };
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0003_daily_signin_claims.sql','0004_reward_claims.sql','0005_point_operations.sql']) {
    sqlite.exec(fs.readFileSync(new URL('migrations/' + file, root), 'utf8'));
  }
  return { sqlite, prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind(...values) { return {
      async run() { const result = statement.run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
      async first() { return statement.get(...values) || null; },
      async all() { return { results: statement.all(...values) }; },
    }; } };
  } };
}
function ledger(options = {}) {
  const db = database();
  const state = { balance: options.balance || 0, list: [], posts: 0, available: true, unknown: false, ...options };
  const service = createPointService({ db,
    query: async () => state.available ? { ok: true, balance: state.balance, list: structuredClone(state.list) } : { ok: false, status: 404, reason: 'user_not_found' },
    insert: async (_, amount, reason) => {
      state.posts++;
      state.balance += amount;
      state.list.unshift({ id: String(state.posts), event_content: reason, get_point: amount, point_balance: state.balance });
      if (state.unknown) throw new Error('connection lost after commit');
      return { ok: true, balance: state.balance };
    },
  });
  const input = (id, amount = 100) => ({ id, lineUid: UID, memberUid: UID, kind: 'reward', amount, reason: 'Test reward' });
  return { db, state, service, input };
}
function runtime(options = {}) {
  const l = ledger(options);
  const values = new Map(Object.entries({
    SYSTEM_SETTINGS: { reward_daily: 1, reward_register: 100, shop_payment_methods: 'LINEPAY,REMITTANCE,COD' },
    ['USER_' + UID]: member, ORDERS: [], ...options.values,
  }));
  const pending = [];
  const ctx = { waitUntil(p) { pending.push(p); } };
  const sandbox = { console, setTimeout, clearTimeout, URL, URLSearchParams, TextEncoder, TextDecoder, Request, Response, Headers,
    FormData, Blob, AbortSignal, AbortController, atob, btoa, crypto: webcrypto, createPointService,
    fetch: async () => { throw new Error('unexpected network'); } };
  vm.createContext(sandbox);
  vm.runInContext(source.replace(/^import[^\n]+\n/gm, '').replace(/\bexport default\s+\{/, 'globalThis.worker = {'), sandbox);
  sandbox.safeGetKV = async (_, key, fallback) => structuredClone(values.has(key) ? values.get(key) : fallback);
  sandbox.getKvJsonOnly = sandbox.safeGetKV;
  sandbox.safePutKV = async (_, key, value) => { values.set(key, structuredClone(value)); return { ok: true }; };
  sandbox.putKvJsonOnly = sandbox.safePutKV;
  sandbox.putOrdersKV = async (_, __, value) => { values.set('ORDERS', structuredClone(value)); };
  sandbox.putUserKV = async (_, __, uid, value) => { values.set('USER_' + uid, structuredClone(value)); };
  sandbox.getPointDataForUid = async (_, uid) => ({ pointUid: uid, data: values.get('POINTS_' + uid) || { balance: 0, logs: [] } });
  sandbox.createHookTeaPointService = () => l.service;
  sandbox.requireHuaxuIdentity = async () => ({ ok: true, lineUid: UID, memberUid: UID, member: values.get('USER_' + UID), profile: { name: 'Verified' } });
  sandbox.findHuaxuMemberByLineUidFast = async () => ({ memberUid: UID, member: values.get('USER_' + UID) });
  sandbox.ensureFastLineCheckinMember = async () => ({ memberUid: UID, member: values.get('USER_' + UID) || member });
  sandbox.getHuaxuShopProducts = async () => [{ id: 'P', name: 'Tea', price: 100, pointsPrice: 100 }];
  sandbox.getHuaxuShopOrders = async () => values.get('ORDERS');
  sandbox.sendTelegramNotification = async () => {};
  sandbox.appendPaymentLog = async () => {};
  sandbox.bindLegacyMemberToLine = async () => ({ bound: false });
  sandbox.resolveAccess = async () => ({ userId: UID, lineUserId: UID, hasVerifiedLineUser: true, isAdmin: false, settings: values.get('SYSTEM_SETTINGS') });
  sandbox.worker.sendTgMessage = async () => {};
  const env = { DB: l.db, ACTION_DATA: { async put() {}, async get() { return null; } }, ADMIN_PASSWORD: 'test' };
  const get = name => vm.runInContext(name, sandbox);
  const request = payload => new Request('https://hooktea.test/api/huaxu/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const checkout = (extra = {}) => ({ clientOrderKey: 'checkout-1', items: [{ id: 'P', quantity: 1 }], paymentMethod: 'COD',
    customer: { name: 'Test', phone: '0912345678', postalCode: '100', city: '臺北市', district: '中正區', address: '忠孝西路一段10號' }, ...extra });
  return { ...l, values, sandbox, env, ctx, get, request, checkout, async settle() { await Promise.all(pending.splice(0)); },
    async action(action, payload = {}) { return sandbox.worker.handleApiActions(request({ action, payload }), env, ctx, {}); } };
}

test('different simultaneous rewards serialize and retain both credits', async () => {
  const h = ledger();
  await Promise.all([h.service.submit(h.input('first'), member), h.service.submit(h.input('second'), member)]);
  await h.service.resume(UID, member);
  assert.equal(h.state.balance, 200);
  assert.equal(h.state.posts, 2);
  assert.equal((await h.service.get('first')).status, 'confirmed');
  assert.equal((await h.service.get('second')).status, 'confirmed');
});
test('same reward submitted concurrently posts once', async () => {
  const h = ledger();
  await Promise.all(Array.from({ length: 5 }, () => h.service.submit(h.input('same'), member)));
  assert.equal(h.state.posts, 1);
  assert.equal(h.state.balance, 100);
});
test('mother missing member queues without changing spendable balance and safely resumes', async () => {
  const h = ledger({ available: false });
  const result = await h.service.submit(h.input('missing'), member);
  assert.equal(result.status, 'pending_member');
  assert.equal(h.state.posts, 0);
  assert.equal((await h.service.read(UID, member)).balance, 0);
  h.state.available = true;
  await h.service.resume(UID, member);
  assert.equal(h.state.posts, 1);
  assert.equal(h.state.balance, 100);
});
test('unknown POST reconciles by exact marker without another insert', async () => {
  const h = ledger({ unknown: true });
  assert.equal((await h.service.submit(h.input('unknown'), member)).status, 'reconciling');
  h.state.unknown = false;
  await h.service.resume(UID, member);
  assert.equal((await h.service.get('unknown')).status, 'confirmed');
  assert.equal(h.state.posts, 1);
});
test('ambiguous result without exact evidence remains locked after repeated reads', async () => {
  const h = ledger({ unknown: true });
  await h.service.submit(h.input('unknown'), member);
  h.state.list = [{ event_content: 'unrelated', get_point: 100 }];
  for (let i = 0; i < 3; i++) await h.service.resume(UID, member);
  assert.equal(h.state.posts, 1);
  assert.equal((await h.service.read(UID, member)).available, false);
});
test('concurrent deductions recheck balance after the account lock', async () => {
  const h = ledger({ balance: 100 });
  await Promise.all([h.service.submit(h.input('spend1', -80), member), h.service.submit(h.input('spend2', -80), member)]);
  await h.service.attempt('spend2', member);
  assert.equal(h.state.balance, 20);
  assert.equal(h.state.posts, 1);
});
test('ordinary profile resume never starts a queued checkout deduction', async () => {
  const h = ledger({ available: false, balance: 100 });
  await h.service.submit(h.input('spend', -50), member);
  h.state.available = true;
  await h.service.resume(UID, member);
  assert.equal(h.state.posts, 0);
});
test('conflicting secondary identity field rejects before any point operation', async () => {
  const h = ledger();
  await assert.rejects(h.service.submit(h.input('bad'), { ...member, linkedLineUid: OTHER }), /POINT_IDENTITY_CONFLICT/);
  assert.equal(h.state.posts, 0);
});
test('old local balance is snapshotted but never added to mother available balance', async () => {
  const h = runtime({ balance: 30, values: { ['POINTS_' + UID]: { balance: 150, logs: [{ reason: 'old' }] } } });
  const points = await h.get('readAuthoritativePoints')(h.env, UID, member);
  assert.equal(points.balance, 30);
  assert.equal(points.legacyReviewRequired, true);
  assert.equal(h.state.posts, 0);
});
test('pre-journal claimed and uncertain rewards never create a new journal award', async () => {
  for (const status of ['claimed','reconciling']) {
    const h = runtime();
    h.db.sqlite.prepare('INSERT INTO daily_signin_claims(line_user_id,claim_date,status) VALUES(?,?,?)').run(UID, '2026-09-14', status);
    const result = await h.get('claimHookTeaReward')(h.env, h.ctx, { lineUid: UID, kind: 'daily_signin', key: '2026-09-14', amount: 1, reason: 'daily' });
    assert.equal(result.duplicate, true);
    assert.equal(h.state.posts, 0);
  }
});
test('legacy registration repeats and concurrent profile edits cannot award twice or grant roles', async () => {
  const h = runtime({ values: { ['USER_' + UID]: {} } });
  await Promise.all([h.action('REGISTER_USER', { name: 'A', isAdmin: true, memberTier: 'admin' }), h.action('REGISTER_USER', { name: 'A' })]);
  await h.action('REGISTER_USER', { name: 'B' });
  assert.equal(h.state.posts, 1);
  assert.equal(h.values.get('USER_' + UID).isAdmin, undefined);
  assert.equal(h.values.get('USER_' + UID).memberTier, '一般會員');
  await h.settle();
});
test('legacy daily concurrent requests award once and outage preserves pending intent', async () => {
  const h = runtime({ available: false });
  await h.action('DAILY_CHECKIN');
  assert.equal(h.state.posts, 0);
  assert.equal([...h.values.keys()].some(key => key.startsWith('CHECKIN_')), false);
  h.state.available = true;
  await h.service.resume(UID, member);
  await Promise.all([h.action('DAILY_CHECKIN'),h.action('DAILY_CHECKIN')]);
  assert.equal(h.state.posts, 1);
  assert.equal(h.state.balance, 1);
});
test('LINE Pay cancel callback does not read or mutate an order or credit points', async () => {
  const h = runtime();
  h.sandbox.safeGetKV = async () => { throw new Error('unexpected order read'); };
  const response = await h.sandbox.worker.handleLinePayCancel(new Request('https://hooktea.test/linepay/cancel?orderId=paid&redirect=https://evil.test'), h.env, h.ctx);
  assert.equal(response.status, 302);
  assert.ok(response.headers.get('location').startsWith('https://hooktea.test/huaxu-shop.html'));
  assert.equal(h.state.posts, 0);
});
test('paid evidence prevents authenticated cancellation even when status says pending', async () => {
  const h = runtime({ values: { ORDERS: [{ orderId: 'paid', userId: UID, status: 'PENDING', paymentStatus: 'SUCCESS', pointsUsed: 10, pointsDeductedAt: 'before' }] } });
  const response = await h.get('handleHuaxuCancelOrder')(h.request({ orderId: 'paid' }), h.env, h.ctx, h.sandbox.worker);
  assert.equal(response.status, 409);
  assert.equal(h.state.posts, 0);
});
test('simultaneous and repeated authenticated cancellations refund once', async () => {
  const h = runtime({ values: { ORDERS: [{ orderId: 'unpaid', userId: UID, status: 'PENDING', pointsUsed: 10, pointsDeductedAt: 'before' }] } });
  const cancel = () => h.get('handleHuaxuCancelOrder')(h.request({ orderId: 'unpaid' }), h.env, h.ctx, h.sandbox.worker);
  await Promise.all([cancel(), cancel()]);
  await cancel();
  assert.equal(h.state.posts, 1);
  assert.equal(h.state.balance, 10);
  assert.equal(h.values.get('ORDERS')[0].status, 'CANCELLED');
});
test('payment confirm rejects transaction mismatch before provider call', async () => {
  const h = runtime({ values: { ORDERS: [{ orderId: 'pending', userId: UID, status: 'PENDING', paymentMethod: 'LINEPAY', linePayTransactionId: 'correct' }] } });
  let calls = 0;
  h.sandbox.callLinePayApi = async () => { calls++; return {}; };
  await h.sandbox.worker.handleLinePayConfirm(new Request('https://hooktea.test/linepay/confirm?orderId=pending&transactionId=wrong'), h.env, h.ctx);
  assert.equal(calls, 0);
  assert.equal(h.values.get('ORDERS')[0].status, 'PENDING');
});
test('journal refund blocks payment confirm even when order cache write previously failed', async () => {
  const h = runtime({ values: { ORDERS: [{ orderId: 'pending', userId: UID, status: 'PENDING', paymentMethod: 'LINEPAY', linePayTransactionId: 'correct' }] } });
  await h.service.submit({ ...h.input('order-restore:pending', 10), kind: 'order_restore' }, member);
  let calls = 0;
  h.sandbox.callLinePayApi = async () => { calls++; return {}; };
  await h.sandbox.worker.handleLinePayConfirm(new Request('https://hooktea.test/linepay/confirm?orderId=pending&transactionId=correct'), h.env, h.ctx);
  assert.equal(calls, 0);
});
test('checkout concurrent and later retries return one durable order', async () => {
  const h = runtime();
  const make = () => h.get('handleHuaxuCreateOrder')(h.request(h.checkout()), h.env, h.ctx, h.sandbox.worker);
  const responses = await Promise.all([make(), make()]);
  assert.ok(responses.some(r => r.status === 200));
  const again = await make();
  assert.equal(again.status, 200, JSON.stringify(await again.clone().json()));
  assert.equal((await again.json()).duplicate, true);
  assert.equal(h.values.get('ORDERS').length, 1);
});
test('failed payment initialization is persisted and retry does not create another order', async () => {
  const h = runtime();
  let calls = 0;
  h.sandbox.worker.preparePayment = async () => { calls++; throw new Error('timeout'); };
  const make = () => h.get('handleHuaxuCreateOrder')(h.request(h.checkout({ paymentMethod: 'LINEPAY' })), h.env, h.ctx, h.sandbox.worker);
  assert.equal((await make()).status, 502);
  assert.equal((await make()).status, 502);
  assert.equal(h.values.get('ORDERS').length, 1);
  assert.equal(h.values.get('ORDERS')[0].status, 'PAYMENT_INIT_FAILED');
  assert.equal(calls, 1);
});
test('unavailable mother balance never permits local-only checkout points', async () => {
  const h = runtime({ available: false, values: { ['POINTS_' + UID]: { balance: 1000, logs: [] } } });
  const response = await h.get('handleHuaxuCreateOrder')(h.request(h.checkout({ pointsUsed: 50 })), h.env, h.ctx, h.sandbox.worker);
  assert.equal(response.status, 409);
  assert.equal(h.values.get('ORDERS').length, 0);
  assert.equal(h.state.posts, 0);
});

test('point preflight failure can be retried with the same key once mother recovers', async () => {
  const h = runtime({ available: false, balance: 100 });
  const make = () => h.get('handleHuaxuCreateOrder')(h.request(h.checkout({ pointsUsed: 50 })), h.env, h.ctx, h.sandbox.worker);
  assert.equal((await make()).status, 409);
  h.state.available = true;
  assert.equal((await make()).status, 200);
  assert.equal(h.values.get('ORDERS').length, 1);
  assert.equal(h.state.posts, 1);
});
test('malformed mother 200 response is not success and absent balance stays unknown', async () => {
  const h = runtime();
  h.sandbox.fetch = async () => new Response('not-json', { status: 200 });
  const env = { WP_SYNC_ENABLED: 'true', WP_API_KEY: 'test', WP_SHOP_ID: '35' };
  assert.equal((await h.get('queryWetwPointList')({}, member, env)).ok, false);
  assert.equal((await h.get('insertWetwPoint')({}, UID, 1, 'test', env, member)).ok, false);
  assert.equal(h.get('extractWetwInsertBalance')({ ok: true, data: {} }), null);
});
test('HTTP signin recognizes historical D1 claims without relying on a KV mirror', async () => {
  const h = runtime();
  const date = h.get('taipeiDateKey')();
  h.db.sqlite.prepare('INSERT INTO daily_signin_claims(line_user_id,claim_date,status) VALUES(?,?,?)').run(UID, date, 'claimed');
  const response = await h.get('handleHuaxuMemberCheckin')(h.request({}), h.env, h.ctx);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).alreadyCheckedIn, true);
  assert.equal(h.state.posts, 0);
});
