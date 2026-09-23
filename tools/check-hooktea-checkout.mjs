import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {webcrypto} from 'node:crypto';

const worker = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const renderStart = worker.indexOf("function renderHuaxuShopHtml(");
const renderEnd = worker.indexOf("\nexport default", renderStart);
assert.ok(renderStart > 0 && renderEnd > renderStart);
const renderHtml = entry => vm.runInNewContext(worker.slice(renderStart, renderEnd) + '\nrenderHuaxuShopHtml("test-liff", '+JSON.stringify(entry)+');', {URL});
const html = renderHtml("https://shop.example.test/");
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

function storefront({ local = {}, session = {}, search = "", request = null, loggedIn = true, pathname = "/", sdkInit = null, registrationEntry = false } = {}) {
  const elements = new Map();
  const events = new Map();
  const calls = [];
  const makeElement = id => ({ id, value: id === "shippingCarrier" ? "FAMILY" : "", checked: false, disabled: false, textContent: "", innerHTML: "", style: {}, classList: { add() {}, remove() {}, toggle() {} }, closest: () => null, focus() {}, scrollIntoView() {}, appendChild() {}, setAttribute() {}, removeAttribute() {}, querySelector: () => null });
  const getElement = id => { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); };
  const localStorage = storage(local);
  const sessionStorage = storage(session);
  let token = "verified-test-token";
  let loginCount = 0;
  const location = { href: "https://shop.example.test" + pathname + search, search, origin: "https://shop.example.test", pathname, hash: "" };
  const setLocation = value => { const url = new URL(value, location.href); for (const key of ["href","search","origin","pathname","hash"]) location[key] = url[key]; };
  const liff = { init: async () => { if(sdkInit) await sdkInit(location, setLocation); }, isLoggedIn: () => loggedIn, isInClient: () => true, getAccessToken: () => token, getProfile: async () => ({ userId: uid, displayName: "Test" }), login: () => { loginCount++; } };
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const response = request ? await request(url, options) : null;
    if (response) return { status: response.status || 200, ok: (response.status || 200) < 400, json: async () => response.body };
    const body = url === "/api/huaxu/config" ? {} : url === "/api/huaxu/products" ? [{ id: "tea", price: 300, name: "茶", pointsPrice: 300 }] : url === "/api/huaxu/member" ? { ok: true, lineUserId: uid, memberUid: uid, bound: true, member: { registrationStatus: "registered" }, points: { balance: 100, source: "wetw", shared: { ok: true }, logs: [] }, orders: { count: 0, latest: [] } } : { ok: true };
    return { status: 200, ok: true, json: async () => body };
  };
  const sandbox = {
    console: { warn() {} }, crypto: webcrypto, localStorage, sessionStorage, location, URL, URLSearchParams, AbortController, Blob,
    navigator: { userAgent: "test" }, history: { replaceState: (_, __, value) => setLocation(value) }, fetch, liff,
    document: { getElementById: getElement, addEventListener: (name, listener) => { const listeners = events.get(name) || []; listeners.push(listener); events.set(name, listeners); }, querySelectorAll: () => [], querySelector: () => null, createElement: () => makeElement(""), body: makeElement("body") },
    window: { liff, addEventListener(name, listener) { const listeners=events.get(name)||[]; listeners.push(listener); events.set(name,listeners); }, scrollTo() {} }, setTimeout: () => 1, clearTimeout() {}, alert() {}, confirm: () => true,
  };
  const context = vm.createContext(sandbox);
  new vm.Script(script.replace('const REGISTRATION_ENTRY = false;', 'const REGISTRATION_ENTRY = '+registrationEntry+';').replace(/^\s*init\(\);\s*$/m, ""), { filename: "rendered-storefront.js" }).runInContext(context);
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

test("LIFF primary redirect keeps its endpoint and state intact until SDK initialization", async () => {
  let initObserved=false;
  const app=storefront({pathname:"/huaxu-shop.html",search:"?liff.state=%3Fopen%3Dregister",sdkInit:(location,setLocation)=>{
    initObserved=true;
    assert.equal(location.pathname,"/huaxu-shop.html");
    assert.equal(new URL(location.href).searchParams.get("liff.state"),"?open=register");
    setLocation("/huaxu-shop.html?open=register");
  }});
  await app.run("initLineIdentity()");
  assert.equal(initObserved,true);
  assert.equal(app.run("memberVerified"),true);
  assert.equal(app.run("activeMemberSection"),"個人基本資料");
  assert.equal(app.run("memberEditMode"),false,"registered users reuse their existing profile");
});

test("registration HTML has an immediate dedicated shell before the blocking SDK, for both LIFF redirect phases", () => {
  for(const query of ["?open=register","?liff.state=%3Fopen%3Dregister"]){
    const page=renderHtml("https://shop.example.test/huaxu-shop.html"+query);
    assert.match(page,/<body class="registration-entry">/);
    assert.match(page,/<title>HookTea 會員註冊<\/title>/);
    assert(page.indexOf('正在確認 LINE 身分') < page.indexOf('https://static.line-scdn.net/liff/edge/2/sdk.js'));
    assert.match(page,/返回商城/);
  }
  assert.match(html,/<body class="">/);
});

test("registration starts verified profile without waiting for catalog or diagnostic requests", async () => {
  const app=storefront({registrationEntry:true,search:"?open=register",local:{huaxu_cart:cart,huaxu_points_used:"100"},request:(url,options)=>{
    if(url==="/api/huaxu/liff-debug") return new Promise(()=>{});
    if(url==="/api/huaxu/config"||url==="/api/huaxu/products") throw Error('catalog must not be requested');
    if(url==="/api/huaxu/member") {
      assert.equal(JSON.parse(options.body).profileOnly,true);
      return {body:{ok:true,lineUserId:uid,memberUid:uid,member:{registrationStatus:"pending"},profileOnly:true}};
    }
  }});
  await app.run("init()");
  assert.equal(app.run("memberVerified"),true);
  assert.match(app.getElement("memberRows").innerHTML,/完成會員註冊/);
  assert.equal(app.localStorage.getItem("huaxu_points_used"),"100");
  assert.equal(app.run("cart.length"),1);
  assert.doesNotMatch(app.getElement("memberRows").innerHTML,/點數記載|訂單查詢/);
  assert.equal(app.calls.some(c=>c.url.includes('products')||c.url.includes('config')||c.url.includes('orders')),false);
});

test("OAuth callback restores saved registration intent after verified login", async () => {
  const app=storefront({pathname:"/huaxu-shop.html",search:"?code=synthetic&state=synthetic",session:{huaxu_entry_url:"https://shop.example.test/huaxu-shop.html?open=register"}});
  await app.run("initLineIdentity()");
  assert.equal(app.run("activeMemberSection"),"個人基本資料");
});

test("LIFF secondary redirect opens pending registration form after server verification", async () => {
  const app=storefront({pathname:"/huaxu-shop.html",search:"?liff.state=%3Fopen%3Dregister",sdkInit:(_,setLocation)=>setLocation("/huaxu-shop.html?open=register"),request:url=>url==="/api/huaxu/member"?{body:{ok:true,lineUserId:uid,memberUid:uid,member:{registrationStatus:"pending"}}}:null});
  await app.run("initLineIdentity()");
  assert.equal(app.run("memberVerified"),true);
  assert.equal(app.run("activeMemberSection"),"個人基本資料");
  assert.equal(app.run("memberEditMode"),true);
  assert.match(app.getElement("memberRows").innerHTML,/完成會員註冊/);
});

test("plain shop visits do not replay an old registration entry", async () => {
  const app=storefront({session:{huaxu_entry_url:"https://shop.example.test/?open=register"}});
  await app.run("initLineIdentity()");
  assert.equal(app.run("activeMemberSection"),"");
});

test("registration entry never opens private profile after server verification fails", async () => {
  const app=storefront({search:"?open=register",request:url=>url==="/api/huaxu/member"?{status:401,body:{ok:false}}:null});
  await app.run("initLineIdentity()");
  assert.equal(app.run("memberVerified"),false);
  assert.equal(app.run("activeMemberSection"),"");
});

test("checkout key is stable on retries but renewed for the next identical purchase", async () => {
  const app = storefront({ local: { huaxu_cart: cart } }); await app.ready();
  const first = app.run('buildClientOrderKey({name:"A",phone:"0912345678"})');
  assert.equal(app.run('buildClientOrderKey({name:"A",phone:"0912345678"})'), first);
  app.run('clearCheckoutDraft()');
  assert.notEqual(app.run('buildClientOrderKey({name:"A",phone:"0912345678"})'), first);
});

test("pending registration permits points and signin but blocks checkout while preserving cart and draft", async () => {
  const app = storefront({local:{huaxu_cart:cart,huaxu_points_used:'10'}}); await app.ready();app.fill();
  app.run('memberData.member.registrationStatus="pending"');
  assert.equal(app.run('requireReadyMember()'),true);
  await app.run('dailyCheckin()');
  assert.ok(app.calls.some(call=>call.url==='/api/huaxu/checkin'));
  app.run('memberData.member.registrationStatus="pending"');
  await app.run('checkout()');
  assert.equal(app.calls.filter(call=>call.url==='/api/huaxu/orders').length,0);
  assert.equal(app.run('memberEditMode'),true);
  assert.equal(app.run('cart.length'),1);assert.equal(app.run('pointDeduction'),10);
  assert.equal(JSON.parse(app.localStorage.getItem(userKey)).fields.name,fields.name);
  assert.match(app.run('renderProfileDetail()'),/完成會員註冊/);
});

test("single member entry offers registration by status without restricting member points", async () => {
  const app=storefront({search:'?open=member&source=line_member_area'});
  let memberOpened=false;
  app.getElement('member').classList.toggle=(name,open)=>{ if(name==='open') memberOpened=open; };
  await app.run('initLineIdentity()');
  assert.equal(memberOpened,true);
  assert.equal(app.getElement('memberRegistrationButton').textContent,'查看註冊資料');
  app.run('memberData.member.registrationStatus="pending"; renderMemberPanel()');
  assert.equal(app.getElement('memberRegistrationButton').textContent,'完成會員註冊');
  assert.equal(app.run('requireReadyMember()'),true);
  app.run('openRegistration()');
  assert.equal(app.run('memberEditMode'),true);
  assert.match(app.getElement('memberRows').innerHTML,/完成會員註冊/);
});

test("keyword registration deep link opens same member form after verified login", async () => {
  const app=storefront({search:'?open=register'}); await app.ready();
  app.run('memberData.member.registrationStatus="pending"; openRegistration()');
  assert.equal(app.run('activeMemberSection'),'個人基本資料');assert.equal(app.run('memberEditMode'),true);
  app.run('memberData.member.registrationStatus="registered"; openRegistration()');
  assert.equal(app.run('memberEditMode'),false);
});

test("unavailable points preserve the intended discount and prevent silently ordering at full price", async () => {
  const app = storefront({ local: { huaxu_cart: cart, huaxu_points_used: "50" } }); await app.ready(); app.fill();
  app.run('memberData.points = {balance:0,available:false,shared:{ok:false}}; renderCart()');
  assert.equal(app.run("pointDeduction"), 50);
  await app.run("checkout()");
  assert.equal(app.calls.filter(call => call.url === "/api/huaxu/orders").length, 0);
  assert.match(app.getElement("toast").textContent, /自行將折抵設為 0/);
});

test('product zero cap, quantity and member balance constrain the displayed deduction', async()=>{
  const app=storefront();await app.ready();
  app.run('products=[{id:"tea",name:"茶",price:100,pointsPrice:0}];cart=[{id:"tea",quantity:2}];pointDeduction=99;');
  assert.equal(app.run('cartTotals().allowedPoints'),0);
  app.run('products[0].pointsPrice=20;');assert.equal(app.run('cartTotals().allowedPoints'),40);
  app.run('memberData.points.balance=15;');assert.equal(app.run('cartTotals().allowedPoints'),15);
});

test('maximum discount is disabled while syncing and never erases a saved choice', async()=>{
  const app=storefront({local:{huaxu_cart:cart,huaxu_points_used:'50'}});await app.ready();
  assert.match(html,/id="useMaxPointsButton"[^>]*disabled/);
  app.run('memberLoading=true;renderCart();useMaxPoints()');
  assert.equal(app.getElement('useMaxPointsButton').disabled,true);
  assert.equal(app.run('pointDeduction'),50);
  assert.equal(app.localStorage.getItem('huaxu_points_used'),'50');
  app.run('memberLoading=false;renderCart()');
  assert.equal(app.getElement('useMaxPointsButton').disabled,false);
  assert.equal(app.run('pointDeduction'),50);
  app.run('useMaxPoints()');
  assert.equal(app.run('pointDeduction'),100);
});

test('unavailable, unverified and reconciling points cannot silently replace discount with zero', async()=>{
  for(const state of ['memberVerified=false','memberData.points.available=false','memberData.points.shared.ok=false','memberData.points.reconciliationRequired=true']){
    const app=storefront({local:{huaxu_cart:cart,huaxu_points_used:'50'}});await app.ready();
    app.run(state+';renderCart();useMaxPoints()');
    assert.equal(app.getElement('useMaxPointsButton').disabled,true,state);
    assert.equal(app.run('pointDeduction'),50,state);
    assert.equal(app.localStorage.getItem('huaxu_points_used'),'50',state);
  }
});

test('point preflight retains bounded identity and cart, never contact data or OAuth parameters', async()=>{
  const app=storefront({local:{huaxu_cart:cart,huaxu_points_used:'50'},search:'?code=private-code&state=private-state'});await app.ready();app.fill();
  app.run('memberData.points.available=false');
  await app.run('checkout()');await app.run('checkout()');
  assert.equal(app.calls.filter(c=>c.url==='/api/huaxu/orders').length,0);
  const events=app.calls.filter(c=>c.url==='/api/huaxu/cart-activity').map(c=>JSON.parse(c.options.body)).filter(e=>e.eventType==='checkout_blocked');
  assert.equal(events.length,1);
  assert.equal(events[0].stage,'points_unavailable');
  assert.equal(events[0].status,'blocked');
  assert.equal(events[0].lineUserId,uid);
  assert.equal(events[0].displayName,'Test');
  assert.equal(events[0].items[0].id,'tea');
  assert.ok(events[0].sessionId);
  assert.equal(events[0].href,'https://shop.example.test/');
  assert.doesNotMatch(JSON.stringify(events),/private-code|private-state|0912345678|test@example|重慶|verified-test-token/);
});

test('member preflight block is observable without allowing anonymous orders', async()=>{
  const app=storefront({local:{huaxu_cart:cart},loggedIn:false});
  await app.run('checkout()');
  const event=app.calls.filter(c=>c.url==='/api/huaxu/cart-activity').map(c=>JSON.parse(c.options.body)).find(e=>e.eventType==='checkout_blocked');
  assert.equal(event.stage,'member_unverified');
  assert.equal(app.calls.some(c=>c.url==='/api/huaxu/orders'),false);
});

test('diagnostic network failure never releases the discount guard or erases draft', async()=>{
  const app=storefront({local:{huaxu_cart:cart,huaxu_points_used:'50'},request:url=>{if(url==='/api/huaxu/cart-activity')throw new Error('offline');}});await app.ready();app.fill();
  app.run('memberData.points.available=false');await app.run('checkout()');
  assert.equal(app.run('pointDeduction'),50);
  assert.equal(app.run('cart.length'),1);
  assert.equal(app.calls.some(c=>c.url==='/api/huaxu/orders'),false);
  assert.equal(JSON.parse(app.localStorage.getItem(userKey)).fields.phone,fields.phone);
});

test('timed out member read preserves discount intent and records a fixed non-private reason', async()=>{
  const app=storefront({local:{huaxu_cart:cart,huaxu_points_used:'50'},request:url=>{
    if(url==='/api/huaxu/member'){const error=new Error('private upstream failure');error.name='AbortError';throw error;}
  }});await app.ready();
  assert.equal(app.run('pointDeduction'),50);
  assert.equal(app.getElement('useMaxPointsButton').disabled,true);
  const events=app.calls.filter(c=>c.url==='/api/huaxu/cart-activity').map(c=>JSON.parse(c.options.body));
  const failure=events.find(e=>e.stage==='member_timeout');
  assert.equal(failure.eventType,'member_read_failed');
  assert.equal(failure.lineUserId,uid);
  assert.equal(failure.trigger,'member_load');
  assert.equal(failure.errorCode,'MEMBER_READ_TIMEOUT');
  assert.equal(failure.items[0].id,'tea');
  assert.doesNotMatch(JSON.stringify(events),/private upstream failure/);
});

test('anonymous session, panel close and page leave never claim customer cancellation',()=>{
  const app=storefront({local:{huaxu_cart:cart}});
  app.run('toggleCart(false)');app.dispatch('pagehide');
  const events=app.calls.filter(c=>c.url==='/api/huaxu/cart-activity').map(c=>JSON.parse(c.options.body));
  assert.deepEqual(events.map(e=>e.status),['closed','left']);
  assert.equal(events[1].stage,'page_hidden_unknown');
  assert.equal(events[0].identityState,'anonymous');
  assert.equal(events[0].sessionId,events[1].sessionId);
  assert.equal(events[0].snapshotAvailable,false);
  assert.ok(events[1].sequence>events[0].sequence);
});

test('payment departure and server-confirmed cancellation are separate observations',async()=>{
  const app=storefront({local:{huaxu_cart:cart}});await app.ready();
  app.run('departureIntent="payment_redirect";activityOrderId="order-test"');app.dispatch('pagehide');
  await app.run('cancelOrder("order-test")');
  const events=app.calls.filter(c=>c.url==='/api/huaxu/cart-activity').map(c=>JSON.parse(c.options.body));
  assert.equal(events[0].stage,'payment_redirect');assert.equal(events[0].status,'left');
  assert.ok(events.some(e=>e.eventType==='order_cancelled'&&e.status==='cancelled'&&e.orderId==='order-test'));
  app.dispatch('pageshow');assert.equal(app.run('departureIntent'),'');
});

test('member HTTP error and recovery retain same correlation and bounded reason',async()=>{
  let failed=true;
  const app=storefront({local:{huaxu_cart:cart},request:url=>url==='/api/huaxu/member'&&failed?{status:503,body:{ok:false,message:'private address',code:'UPSTREAM_UNAVAILABLE'}}:null});
  await app.ready();failed=false;await app.ready();
  const events=app.calls.filter(c=>c.url==='/api/huaxu/cart-activity').map(c=>JSON.parse(c.options.body));
  assert.equal(events[0].httpStatus,503);
  assert.equal(events[0].errorCode,'UPSTREAM_UNAVAILABLE');
  assert.ok(events.some(e=>e.eventType==='member_read_recovered'&&e.sessionId===events[0].sessionId));
  assert.doesNotMatch(JSON.stringify(events),/private address|verified-test-token/);
});

test('diagnostic requests that never settle cannot hold order submission',async()=>{
  const app=storefront({local:{huaxu_cart:cart},request:url=>url==='/api/huaxu/cart-activity'?new Promise(()=>{}):null});
  await app.ready();app.fill();
  // Mock default order response is incomplete but the order request must occur.
  await app.run('checkout()');
  assert.ok(app.calls.some(c=>c.url==='/api/huaxu/orders'));
});
