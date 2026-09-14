import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const worker = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const renderStart = worker.indexOf("function renderHuaxuShopHtml(");
const renderEnd = worker.indexOf("\nexport default", renderStart);
assert.ok(renderStart > 0 && renderEnd > renderStart);
const html = vm.runInNewContext(worker.slice(renderStart, renderEnd) + '\nrenderHuaxuShopHtml("test-liff");');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(Boolean);
const script = scripts.find(value => value.includes("function checkout()"));
assert.ok(script, "execute the actual rendered storefront script");
new vm.Script(script, { filename: "rendered-storefront.js" });
const uid = "U" + "1".repeat(32);
const otherUid = "U" + "2".repeat(32);
const prefix = "huaxu_checkout_draft_v2";
const userKey = prefix + ":" + uid;
const pendingKey = "huaxu_pending_checkout_v1";
const cart = [{ id: "tea", quantity: 1 }];
const fields = { name: "王測試", phone: "0912345678", email: "test@example.test", postalCode: "100", city: "臺北市", district: "中正區", address: "重慶南路一段1號", shippingCarrier: "POST", shippingStoreInfo: "", note: "測試備註" };
const draft = (values = fields, savedAt = Date.now() - 1000) => ({ fields: { ...values }, savedAt, sameAsRegistered: false });

function storage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

function storefront({ local = {}, session = {}, search = "", request = null, loggedIn = true } = {}) {
  const elements = new Map();
  const events = new Map();
  const calls = [];
  const makeElement = id => ({ id, value: id === "shippingCarrier" ? "FAMILY" : "", checked: false, disabled: false, textContent: "", innerHTML: "", style: {}, classList: { add() {}, remove() {}, toggle() {} }, closest: () => null, focus() {}, scrollIntoView() {}, appendChild() {}, setAttribute() {}, removeAttribute() {}, querySelector: () => null });
  const getElement = id => { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); };
  const localStorage = storage(local);
  const sessionStorage = storage(session);
  let token = "verified-test-token";
  let loginCount = 0;
  const location = { href: "https://shop.example.test/" + search, search, origin: "https://shop.example.test", pathname: "/", hash: "" };
  const liff = { init: async () => {}, isLoggedIn: () => loggedIn, isInClient: () => true, getAccessToken: () => token, getProfile: async () => ({ userId: uid, displayName: "Test" }), login: () => { loginCount++; } };
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const response = request ? await request(url, options) : null;
    if (response) return { status: response.status || 200, ok: (response.status || 200) < 400, json: async () => response.body };
    const body = url === "/api/huaxu/config" ? {} : url === "/api/huaxu/products" ? [{ id: "tea", price: 300, name: "茶", pointsPrice: 300 }] : url === "/api/huaxu/member" ? { ok: true, lineUserId: uid, memberUid: uid, bound: true, member: {}, points: { balance: 100, source: "wetw", shared: { ok: true }, logs: [] }, orders: { count: 0, latest: [] } } : { ok: true };
    return { status: 200, ok: true, json: async () => body };
  };
  const sandbox = {
    console: { warn() {} }, localStorage, sessionStorage, location, URL, URLSearchParams, AbortController, Blob,
    navigator: { userAgent: "test" }, history: { replaceState() {} }, fetch, liff,
    document: { getElementById: getElement, addEventListener: (name, listener) => { const listeners = events.get(name) || []; listeners.push(listener); events.set(name, listeners); }, querySelectorAll: () => [], querySelector: () => null, createElement: () => makeElement(""), body: makeElement("body") },
    window: { liff, addEventListener() {}, scrollTo() {} }, setTimeout: () => 1, clearTimeout() {}, alert() {}, confirm: () => true,
  };
  const context = vm.createContext(sandbox);
  new vm.Script(script.replace(/^\s*init\(\);\s*$/m, ""), { filename: "rendered-storefront.js" }).runInContext(context);
  const run = expression => vm.runInContext(expression, context);
  const ready = async () => { run('lineProfile = { userId: ' + JSON.stringify(uid) + ', displayName: "Test" }; products = [{id:"tea",name:"茶",price:300,pointsPrice:300}];'); await run('loadMemberData("verified-test-token")'); };
  const fill = (values = fields) => Object.entries(values).forEach(([key, value]) => { getElement(key).value = value; });
  return { run, ready, fill, calls, getElement, localStorage, sessionStorage, setToken: value => { token = value; }, loginCount: () => loginCount, dispatch: (type, id) => (events.get(type) || []).forEach(listener => listener({ target: getElement(id), isTrusted: true })) };
}

test("real startup never overwrites a saved member draft with default anonymous shipping", async () => {
  const app = storefront({ local: { [userKey]: draft() } });
  await app.run("init()");
  // init launches LIFF asynchronously; wait for its finite promise chain.
  for (let step = 0; step < 30 && !app.run("memberVerified"); step++) await Promise.resolve();
  assert.equal(app.run("memberVerified"), true);
  assert.equal(app.getElement("name").value, fields.name);
  assert.equal(JSON.parse(app.localStorage.getItem(userKey)).fields.phone, fields.phone);
  assert.equal(app.sessionStorage.getItem(prefix + ":anon"), null);
});

test("a newer meaningful anonymous draft survives login and becomes this member's draft", async () => {
  const app = storefront({ local: { [userKey]: draft() } });
  app.fill({ ...fields, name: "新收件人" });
  app.run("saveCheckoutDraft()");
  await app.ready();
  assert.equal(app.getElement("name").value, "新收件人");
  assert.equal(JSON.parse(app.localStorage.getItem(userKey)).fields.name, "新收件人");
});

test("an old blank anonymous draft cannot shadow a complete member draft", async () => {
  const app = storefront({ local: { [userKey]: draft() }, session: { [prefix + ":anon"]: draft({ shippingCarrier: "FAMILY", name: "" }, Date.now()) } });
  app.run("restoreCheckoutDraft(); saveCheckoutDraft()");
  await app.ready();
  assert.equal(app.getElement("name").value, fields.name);
});

test("a failed server identity check never restores private per-member saved fields", async () => {
  const app = storefront({ local: { [userKey]: draft() }, request: url => url === "/api/huaxu/member" ? { status: 401, body: { ok: false, message: "驗證失敗" } } : null });
  await app.ready();
  assert.equal(app.run("memberVerified"), false);
  assert.equal(app.getElement("name").value, "");
  assert.equal(JSON.parse(app.localStorage.getItem(userKey)).fields.name, fields.name);
});

test("successful response for a different UID is rejected", async () => {
  const app = storefront({ request: url => url === "/api/huaxu/member" ? { body: { ok: true, lineUserId: otherUid } } : null });
  await app.ready();
  assert.equal(app.run("memberVerified"), false);
});

test("orders with zero points also require server-verified login", async () => {
  const app = storefront({ local: { huaxu_cart: cart }, loggedIn: false });
  app.fill();
  await app.run("checkout()");
  assert.equal(app.calls.filter(call => call.url === "/api/huaxu/orders").length, 0);
  assert.equal(app.getElement("name").value, fields.name);
  assert.equal(JSON.parse(app.sessionStorage.getItem(prefix + ":anon")).fields.phone, fields.phone);
});

test("authenticated checkout sends bearer token and preserves every field on HTTP 401", async () => {
  const app = storefront({ local: { huaxu_cart: cart }, request: url => url === "/api/huaxu/orders" ? { status: 401, body: { ok: false, message: "登入失效" } } : null });
  await app.ready(); app.fill();
  await app.run("checkout()");
  const orderCall = app.calls.find(call => call.url === "/api/huaxu/orders");
  assert.ok(orderCall, "valid form reaches authenticated order endpoint");
  assert.equal(orderCall.options.headers.authorization, "Bearer verified-test-token");
  assert.equal(app.run("memberVerified"), false);
  for (const [key, value] of Object.entries(fields)) assert.equal(app.getElement(key).value, value);
  assert.equal(JSON.parse(app.localStorage.getItem(userKey)).fields.name, fields.name);
  assert.equal(app.run("cart.length"), 1);
});

test("remittance and cancellation send bearer authentication", async () => {
  const app = storefront(); await app.ready();
  app.getElement("remit_order-1").value = "12345";
  await app.run('reportRemittance("order-1")');
  await app.run('cancelOrder("order-1")');
  for (const path of ["/api/huaxu/member", "/api/huaxu/orders/remittance", "/api/huaxu/orders/cancel"]) {
    assert.equal(app.calls.find(call => call.url === path).options.headers.authorization, "Bearer verified-test-token");
  }
});

test("expired token prevents order write even when UI still has a member profile", async () => {
  const app = storefront({ local: { huaxu_cart: cart }, loggedIn: false });
  await app.ready(); app.fill(); app.setToken("");
  await app.run("checkout()");
  assert.equal(app.calls.filter(call => call.url === "/api/huaxu/orders").length, 0);
  assert.equal(app.run("memberVerified"), false);
});

function paymentApp(status, extra = {}) {
  const pending = { orderId: "order-1", lineUserId: uid, cart: JSON.stringify(cart), pointsUsed: 50 };
  return storefront({ local: { huaxu_cart: cart, huaxu_points_used: "50", [userKey]: draft(), ...(extra.local || {}) }, session: { [pendingKey]: pending, ...(extra.session || {}) }, search: "?linepay=success&orderId=order-1", request: url => url.startsWith("/api/huaxu/orders/status?") ? { body: { ok: true, order: { orderId: "order-1", status, paymentStatus: status === "PAID" ? "SUCCESS" : "LINEPAY_REQUESTED" } } } : null });
}

test("a success query parameter does not clear an unpaid order's cart or draft", async () => {
  const app = paymentApp("PENDING"); await app.ready();
  await app.run("verifyPaymentReturn()");
  assert.equal(app.run("cart.length"), 1);
  assert.ok(app.localStorage.getItem(userKey));
  assert.equal(app.calls.find(call => call.url.startsWith("/api/huaxu/orders/status?")).options.headers.authorization, "Bearer verified-test-token");
});

test("server-confirmed paid order clears only its matching cart, draft and point selection", async () => {
  const app = paymentApp("PAID"); await app.ready();
  await app.run("verifyPaymentReturn()");
  assert.equal(app.run("cart.length"), 0);
  assert.equal(app.localStorage.getItem(userKey), null);
  assert.equal(app.localStorage.getItem("huaxu_points_used"), "0");
  assert.equal(app.sessionStorage.getItem(pendingKey), null);
  app.run("saveCheckoutDraft()");
  assert.equal(app.localStorage.getItem(userKey), null, "pagehide cannot recreate a completed checkout draft");
});

test("returning from a paid order never deletes a subsequently changed cart", async () => {
  const app = paymentApp("PAID", { local: { huaxu_cart: [{ id: "tea", quantity: 2 }] } }); await app.ready();
  await app.run("verifyPaymentReturn()");
  assert.equal(app.run("cart[0].quantity"), 2);
  assert.ok(app.localStorage.getItem(userKey));
});

test("payment-return state for a different member never clears current member data", async () => {
  const app = paymentApp("PAID", { session: { [pendingKey]: { orderId: "order-1", lineUserId: otherUid, cart: JSON.stringify(cart), pointsUsed: 50 } } }); await app.ready();
  await app.run("verifyPaymentReturn()");
  assert.equal(app.run("cart.length"), 1);
  assert.ok(app.localStorage.getItem(userKey));
});

test("cancelled payment keeps fields and cart while releasing the pending-checkout guard", async () => {
  const app = paymentApp("CANCELLED"); await app.ready();
  await app.run("verifyPaymentReturn()");
  assert.equal(app.run("cart.length"), 1);
  assert.equal(app.getElement("name").value, fields.name);
  assert.equal(app.sessionStorage.getItem(pendingKey), null);
});

test("a still-pending payment blocks creating a second order", async () => {
  const app = paymentApp("PENDING"); await app.ready(); app.fill();
  await app.run("checkout()");
  assert.equal(app.calls.filter(call => call.url === "/api/huaxu/orders").length, 0);
  assert.ok(app.sessionStorage.getItem(pendingKey));
});

test("a manual recipient edit disables registered shipping and remains saved on refresh", async () => {
  const app = storefront(); await app.ready(); app.fill();
  app.run("bindCheckoutDraftPersistence()");
  app.getElement("sameAsRegistered").checked = true;
  app.getElement("name").value = "手填收件人";
  app.dispatch("input", "name");
  assert.equal(app.getElement("sameAsRegistered").checked, false);
  await app.run('loadMemberData("verified-test-token")');
  assert.equal(app.getElement("name").value, "手填收件人");
});

test("pending points are displayed separately and never added to spendable balance", async () => {
  const app = storefront({ local: { huaxu_cart: cart } }); await app.ready();
  app.run('memberData.points = {balance:20,pendingBalance:100,source:"wetw",shared:{ok:true},logs:[]}; pointDeduction=120; renderCart()');
  assert.equal(app.run("cartTotals().allowedPoints"), 20);
  assert.match(app.run("renderPointsDetail()"), /待同步點數：100/);
  app.run('memberData.points.reconciliationRequired=true');
  assert.equal(app.run("cartTotals().allowedPoints"), 0);
});

test("login and payment return parameters are excluded from the next checkout return URL", () => {
  const app = storefront({ search: "?linepay=success&orderId=old-order&code=secret&campaign=tea" });
  const entry = app.run("restoreEntryContext()");
  assert.equal(new URL(entry.url).searchParams.get("linepay"), null);
  assert.equal(new URL(entry.url).searchParams.get("code"), null);
  assert.equal(new URL(entry.url).searchParams.get("campaign"), "tea");
});

test("checkout key is stable on retries but renewed for the next identical purchase", async () => {
  const app = storefront({ local: { huaxu_cart: cart } }); await app.ready();
  const first = app.run('buildClientOrderKey({name:"A",phone:"0912345678"})');
  assert.equal(app.run('buildClientOrderKey({name:"A",phone:"0912345678"})'), first);
  app.run('clearCheckoutDraft()');
  assert.notEqual(app.run('buildClientOrderKey({name:"A",phone:"0912345678"})'), first);
});

test("unavailable points preserve the intended discount and prevent silently ordering at full price", async () => {
  const app = storefront({ local: { huaxu_cart: cart, huaxu_points_used: "50" } }); await app.ready(); app.fill();
  app.run('memberData.points = {balance:0,available:false,shared:{ok:false}}; renderCart()');
  assert.equal(app.run("pointDeduction"), 50);
  await app.run("checkout()");
  assert.equal(app.calls.filter(call => call.url === "/api/huaxu/orders").length, 0);
  assert.match(app.getElement("toast").textContent, /自行將折抵設為 0/);
});
