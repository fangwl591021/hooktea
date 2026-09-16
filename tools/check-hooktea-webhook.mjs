import assert from "node:assert/strict";
import { createHmac, webcrypto } from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { reportIssue } from '../operational-alerts.js';

const source = process.argv.includes("--baseline")
  ? execFileSync("git", ["show", "HEAD:worker.js"], { cwd: new URL("../", import.meta.url), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
  : fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const signatureHelpers = source.slice(source.indexOf("async function verifyLineWebhookSignature("), source.indexOf("function extractResponseText("));
const keywordHelpers = source.slice(source.indexOf("function configuredKeywordRewards("), source.indexOf("async function deliverKeywordRewardReply("))
  + source.slice(source.indexOf('async function buildMemberAreaLineMessage('), source.indexOf('async function handleMotherKeywordFallback('))
  + source.slice(source.indexOf('const HOOKTEA_DAILY_SIGNIN_KEYWORD ='), source.indexOf('function hookTeaDailySigninPoints('))
  + source.slice(source.indexOf('function isReferralInviteKeyword('), source.indexOf('function isPlainMotherWebhookAck('))
  + source.slice(source.indexOf('function getHookTeaCheckinTemplateTriggerState('), source.indexOf('async function rotateHookTeaCheckinTemplatePages('));
const webhookMethod = source.slice(source.indexOf("  async handleLineWebhook(request, env, ctx) {"), source.indexOf("  async handleLinePayConfirm(request, env, ctx) {"));
assert.ok(signatureHelpers && webhookMethod, "real Worker webhook code must be loaded");

const secret = "hooktea-test-channel-secret";
const sign = body => createHmac("sha256", secret).update(body).digest("base64");
const actualText = text => ({ daily: "虎克茶簽到贈點", bind: "綁定會員" }[text] || text);
const message = (text, id = text) => ({ type: "message", webhookEventId: id, replyToken: "reply-" + id, source: { userId: "U-" + id }, message: { id, type: "text", text: actualText(text) } });
const follow = { type: "follow", webhookEventId: "follow-new", replyToken: "reply-follow", source: { userId: "U-new" } };

function harness(options = {}) {
  const calls = { memberArea: [], registration: [], reward: [], daily: [], template: [], bind: [], monitor: [], referral: [], fetch: [], diagnostics: new Map(), errors: [] };
  const env = { LINE_CHANNEL_SECRET: secret, FORWARD_WEBHOOK_URL: "https://mother.invalid/webhook", ...(options.env || {}) };
  const runLocal = name => async (...args) => {
    const event = args[2] || args[1];
    calls[name].push(event);
    if (options[name] instanceof Error) throw options[name];
    if (typeof options[name] === "function") return options[name](event);
    return options[name] ?? true;
  };
  const sandbox = {
    reportIssue,
    crypto: webcrypto, TextEncoder, Uint8Array, btoa, atob, Request, Response, AbortSignal, URLSearchParams,
    console: { error: (...args) => calls.errors.push(args) },
    getLineChannelSecret: env => env.LINE_CHANNEL_SECRET,
    getLineChannelAccessToken: () => "configured",
    getHuaxuShopConfig: async () => ({ shopLiffId: "2007674851-test" }),
    safeGetKV: async () => ({ shop_keyword_reward_points: 100, shop_keyword_reward_keywords: (options.rewardKeywords || ["954e"]).map(actualText).join(",") }),
    safePutKV: async (_, key, value) => {
      calls.diagnostics.set(key, value);
      if (options.diagnosticGate) await options.diagnosticGate;
    },
    getHookTeaCheckinTemplate: async () => ({ active: true, keywords: (options.templateKeywords || ["template"]).map(actualText), pages: [{ imageUrl: "https://test.invalid/card.png" }] }),
    handleShopKeywordReward: runLocal("reward"),
    handleHookTeaDailySigninReward: runLocal("daily"),
    maybeReplyHookTeaCheckinTemplate: async (_, event) => {
      calls.template.push(event);
      if (options.template instanceof Error) throw options.template;
      return options.template ?? true;
    },
    handleLineMemberBindText: async (_, __, event) => {
      calls.bind.push(event);
      if (options.bind instanceof Error) throw options.bind;
      return options.bind ?? event.message.text === "綁定會員";
    },
    appendLineMonitorEvent: async (_, __, event) => calls.monitor.push(event),
    buildReferralInviteUrl: () => "https://shop.invalid/invite",
    buildReferralShareUrl: () => "https://shop.invalid/share",
    referralShareFlexMessage: args => args,
    replyLineMessage: async (_, replyToken, messages) => {
      if (messages?.[0]?.altText === "HookTea 會員專區") {
        calls.memberArea.push({ replyToken, messages });
        if (options.memberAreaError) throw Error("synthetic member area reply failure");
        return { ok: options.memberAreaOk ?? true };
      }
      if (messages?.[0]?.text?.includes("會員註冊")) {
        calls.registration.push({ replyToken, messages });
        if (options.registrationError) throw Error("synthetic registration reply failure");
        return { ok: true };
      }
      calls.referral.push(replyToken);
      return { ok: true };
    },
    fetch: async (url, request) => {
      calls.fetch.push({ url, ...request });
      if (options.forwardGate) await options.forwardGate;
      if (options.forwardError) throw new Error("simulated uncertain forward failure");
      return new Response("mother reply", { status: options.forwardStatus || 200 });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(keywordHelpers + signatureHelpers + "\nconst handler = {\n" + webhookMethod + "\n}; globalThis.handler = handler;", sandbox);
  return {
    calls, env, sandbox,
    async post(events, { raw, signature, noContext = false, drain = true } = {}) {
      const body = raw || JSON.stringify({ destination: "test-OA", events });
      const request = new Request("https://hooktea.invalid/webhook", { method: "POST", body, headers: { "x-line-signature": signature === undefined ? sign(body) : signature } });
      const pending = [];
      const response = await sandbox.handler.handleLineWebhook(request, env, noContext ? null : { waitUntil: promise => pending.push(promise) });
      if (drain) while (pending.length) await Promise.all(pending.splice(0));
      else this.pending = pending;
      return response;
    },
  };
}
const tests = [];
function test(name, body) { tests.push({ name, body }); }
const forwardedIds = call => JSON.parse(call.body).events.map(event => event.webhookEventId);

test("mixed mother + local reward + follow has no lost events and a correct filtered signature", async () => {
  const h = harness({ env: { GAS_URL: "https://gas.invalid/duplicate" } });
  const response = await h.post([message("會員中心", "mother"), message("954e", "gift"), follow]);
  assert.equal(response.status, 200);
  assert.equal(h.calls.reward.length, 1);
  assert.equal(h.calls.fetch.length, 1, "only one downstream reply owner, even if GAS is configured");
  const forwarded = h.calls.fetch[0];
  assert.deepEqual(forwardedIds(forwarded), ["mother", "follow-new"]);
  assert.equal(forwarded.headers["x-line-signature"], sign(forwarded.body));
  assert.equal(JSON.parse(forwarded.body).destination, "test-OA");
  assert.deepEqual(h.calls.monitor.map(event => event.webhookEventId), ["mother", "gift", "follow-new"]);
  assert.equal(h.calls.bind.length, 0, "mother keyword does not enter pending local bind");
});

test("all unhandled events preserve original formatting and signature", async () => {
  const h = harness();
  const events = [message("會員中心", "mother"), message("一般訊息", "general")];
  const raw = JSON.stringify({ destination: "test-OA", events, marker: "escaped\\n中文" }, null, 2) + "\n";
  await h.post(events, { raw });
  assert.equal(h.calls.fetch[0].body, raw);
  assert.equal(h.calls.fetch[0].headers["x-line-signature"], sign(raw));
  assert.deepEqual(forwardedIds(h.calls.fetch[0]), ["mother", "general"]);
});

test("reward is not resent with an ordinary message", async () => {
  const h = harness();
  await h.post([message("954e", "gift"), message("一般訊息", "general")]);
  assert.equal(h.calls.reward.length, 1);
  assert.deepEqual(forwardedIds(h.calls.fetch[0]), ["general"]);
  assert.equal(h.calls.fetch[0].headers["x-line-signature"], sign(h.calls.fetch[0].body));
});

test("local exception or false result retains owner without retry or mother fallback", async () => {
  const h = harness({ reward: new Error("write already completed; reply unavailable"), daily: false });
  await h.post([message("954e", "gift"), message("daily", "daily"), message("會員中心", "mother")]);
  assert.equal(h.calls.reward.length, 1);
  assert.equal(h.calls.daily.length, 1);
  assert.equal(h.calls.template.length, 0);
  assert.equal(h.calls.bind.length, 0);
  assert.deepEqual(forwardedIds(h.calls.fetch[0]), ["mother"]);
  assert.equal(h.calls.diagnostics.get("WEBHOOK_EVENT_ERROR_LAST").status, "local_handler_declined");
});

test("configured template false result also retains its reply owner", async () => {
  const h = harness({ template: false });
  await h.post([message("template")]);
  assert.equal(h.calls.template.length, 1);
  assert.equal(h.calls.daily.length + h.calls.reward.length + h.calls.fetch.length + h.calls.bind.length, 0);
});

test("reserved mother and daily commands win configuration overlaps, both sites keep their own referrals", async () => {
  const h = harness({ rewardKeywords: ["954e", "會員打卡"], templateKeywords: ["template", "daily"] });
  await h.post([message("會員打卡", "reward-overlap"), message("daily", "template-overlap"), message("分享好友", "mother-referral"), message("我的推薦", "local-referral")]);
  assert.equal(h.calls.reward.length, 0);
  assert.equal(h.calls.template.length, 0);
  assert.equal(h.calls.daily.length, 1);
  assert.equal(h.calls.referral.length, 1);
  assert.deepEqual(forwardedIds(h.calls.fetch[0]), ["reward-overlap", "mother-referral"]);
});

test("member bind releases only explicit no-match, keeps ownership on exception", async () => {
  const bound = harness();
  await bound.post([message("bind"), message("general")]);
  assert.deepEqual(forwardedIds(bound.calls.fetch[0]), ["general"]);
  const failed = harness({ bind: new Error("reply may already be consumed") });
  await failed.post([message("bind")]);
  assert.equal(failed.calls.bind.length, 1);
  assert.equal(failed.calls.fetch.length, 0);
});

test("missing or invalid signature rejects before any event side effect", async () => {
  for (const signature of ["", "invalid", sign("different-body")]) {
    const h = harness();
    const response = await h.post([message("954e"), follow], { signature });
    assert.equal(response.status, 403);
    assert.equal(h.calls.reward.length + h.calls.monitor.length + h.calls.fetch.length, 0);
  }
});

test("missing channel secret fails closed for events and empty verification pings", async () => {
  for (const events of [[message("954e")], []]) {
    const h = harness({ env: { LINE_CHANNEL_SECRET: "" } });
    const response = await h.post(events);
    assert.equal(response.status, 503);
    assert.equal(h.calls.reward.length + h.calls.monitor.length + h.calls.fetch.length, 0);
  }
});

test("correctly signed empty verification ping succeeds without forwarding", async () => {
  const h = harness();
  const response = await h.post([]);
  assert.equal(response.status, 200);
  assert.equal(h.calls.fetch.length, 0);
  assert.equal(h.calls.diagnostics.get("LINE_WEBHOOK_PING_LAST").signatureVerified, true);
});

test("filtered forwarding refuses a missing signer, and signed mutations fail verification", async () => {
  const h = harness();
  const payload = { destination: "test-OA", events: [message("954e"), follow] };
  const raw = JSON.stringify(payload);
  await assert.rejects(h.sandbox.buildLineWebhookForwardRequest({}, payload, raw, sign(raw), [follow]), /missing_channel_secret_for_filtered_webhook/);
  const changed = await h.sandbox.verifyLineWebhookSignature(h.env, raw + " ", sign(raw));
  assert.equal(changed.valid, false);
});

test("no-context execution still finishes monitoring and one forward", async () => {
  const h = harness();
  const response = await h.post([follow], { noContext: true });
  assert.equal(response.status, 200);
  assert.equal(h.calls.monitor.length, 1);
  assert.equal(h.calls.fetch.length, 1);
});

test("downstream failure is recorded without blind retry or GAS fallback", async () => {
  for (const options of [{ forwardError: true }, { forwardStatus: 500 }]) {
    const h = harness({ ...options, env: { GAS_URL: "https://gas.invalid/duplicate" } });
  await h.post([message("會員中心")]);
    assert.equal(h.calls.fetch.length, 1);
    assert.equal(h.calls.diagnostics.get("WEBHOOK_FORWARD_LAST").ok, false);
  }
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("independent branch did not progress within one second");
}

test("all reserved mother commands survive overlapping child reward and template configuration", async () => {
  const keywords = ["會員專區", "會員中心", "會員註冊", "註冊", "注册", "加入會員", "會員分享", "分享好友", "推薦好友", "邀請好友", "會員打卡", "打卡"];
  const h = harness({ rewardKeywords: keywords, templateKeywords: keywords });
  await h.post(keywords.map(text => message(text)));
  assert.equal(h.calls.reward.length + h.calls.template.length + h.calls.bind.length, 0);
  assert.deepEqual(forwardedIds(h.calls.fetch[0]), keywords.filter(text => !["會員註冊", "會員專區"].includes(text)));
  assert.equal(h.calls.memberArea.length, 1);
  assert.equal(h.calls.registration.length, 1);
  assert.match(h.calls.registration[0].messages[0].text, /open=register/);
});

test("exact template, actual daily claim and numeric reward all work in one batch", async () => {
  const h = harness({ templateKeywords: ["簽到", "簽到贈點活動", "虎克茶簽到贈點"] });
  await h.post([message("簽到贈點活動", "card"), message("虎克茶簽到贈點", "claim"), message("９５４Ｅ", "gift"), message("會員中心", "member")]);
  assert.deepEqual(h.calls.template.map(e => e.webhookEventId), ["card"]);
  assert.deepEqual(h.calls.daily.map(e => e.webhookEventId), ["claim"]);
  assert.deepEqual(h.calls.reward.map(e => e.webhookEventId), ["gift"]);
  assert.deepEqual(forwardedIds(h.calls.fetch[0]), ["member"]);
});

test("substring template and pending binding cannot swallow unlisted mother keywords", async () => {
  const h = harness({ templateKeywords: ["活動", "點數"], bind: true });
  await h.post([message("母站活動優惠", "custom"), message("查詢點數", "points"), message("虎克茶簽到贈點查詢", "daily-query")]);
  assert.equal(h.calls.template.length + h.calls.bind.length + h.calls.daily.length, 0);
  assert.deepEqual(forwardedIds(h.calls.fetch[0]), ["custom", "points", "daily-query"]);
});

test("binding still accepts explicit identity input; a no-match is forwarded exactly once", async () => {
  const h = harness({ bind: false });
  await h.post([message("會員中心", "mother"), message("姓名 王小明", "name"), message("0912345678", "phone")]);
  assert.deepEqual(h.calls.bind.map(e => e.webhookEventId), ["name", "phone"]);
  assert.deepEqual(h.calls.fetch.flatMap(forwardedIds), ["mother", "name", "phone"]);
  for (const call of h.calls.fetch) assert.equal(call.headers["x-line-signature"], sign(call.body));
});

test("production card entry, signup button, daily claim and reward each keep their owner", async () => {
  const h = harness({ templateKeywords: ["簽到贈點活動"], rewardKeywords: ["954e"], bind: true });
  await h.post([message("簽到贈點活動", "card"), message("我想報名", "signup"), message("虎克茶簽到贈點", "signin"), message("954e", "gift"), message("會員專區", "member")]);
  assert.deepEqual(h.calls.template.map(e => e.webhookEventId), ["card"]);
  assert.deepEqual(h.calls.daily.map(e => e.webhookEventId), ["signin"]);
  assert.deepEqual(h.calls.reward.map(e => e.webhookEventId), ["gift"]);
  assert.equal(h.calls.bind.length, 0, "pending identity collection cannot intercept 我想報名");
  assert.deepEqual(forwardedIds(h.calls.fetch[0]), ["signup"]);
  assert.equal(h.calls.memberArea.length, 1);
});

test("slow child reward does not block mother forwarding or webhook acknowledgement", async () => {
  const gate = deferred();
  const h = harness({ reward: () => gate.promise });
  try {
    const responsePromise = h.post([message("954e"), message("會員中心")], { drain: false });
    await until(() => h.calls.fetch.length === 1);
    let acknowledged = false;
    responsePromise.then(() => { acknowledged = true; });
    await until(() => acknowledged);
    assert.equal((await responsePromise).status, 200);
    assert.deepEqual(forwardedIds(h.calls.fetch[0]), ["會員中心"]);
  } finally {
    gate.resolve(true);
    await Promise.all(h.pending || []);
  }
});

test("slow mother does not block child keyword or acknowledgement", async () => {
  const gate = deferred();
  const h = harness({ forwardGate: gate.promise });
  try {
    const response = await h.post([message("會員中心"), message("954e")], { drain: false });
    assert.equal(response.status, 200);
    await until(() => h.calls.reward.length === 1);
  } finally {
    gate.resolve();
    await Promise.all(h.pending || []);
  }
});

test("slow diagnostic storage does not block either keyword branch", async () => {
  const gate = deferred();
  const h = harness({ diagnosticGate: gate.promise });
  try {
    const responsePromise = h.post([message("954e"), message("會員中心")], { drain: false });
    await until(() => h.calls.reward.length === 1 && h.calls.fetch.length === 1);
    assert.equal((await responsePromise).status, 200);
  } finally {
    gate.resolve();
    await Promise.all(h.pending || []);
  }
});

test("local ordering is retained per member without blocking other members", async () => {
  const gate = deferred();
  const h = harness({ reward: e => e.webhookEventId === "first" ? gate.promise : true });
  const first = message("954e", "first");
  const next = { ...message("daily", "next"), source: first.source };
  try {
    await h.post([first, next, message("954e", "other")], { drain: false });
    await until(() => h.calls.reward.length === 2);
    assert.equal(h.calls.daily.length, 0);
  } finally {
    gate.resolve(true);
    await Promise.all(h.pending || []);
  }
  assert.equal(h.calls.daily.length, 1);
});

test("postbacks and non-text events remain mother-owned alongside local keywords", async () => {
  const postback = { ...follow, type: "postback", webhookEventId: "postback", postback: { data: "member" } };
  const photo = { ...message("", "photo"), message: { type: "image", id: "photo" } };
  const h = harness();
  await h.post([message("954e"), postback, photo, follow]);
  assert.deepEqual(forwardedIds(h.calls.fetch[0]), ["postback", "photo", "follow-new"]);
  assert.equal(h.calls.reward.length, 1);
});

test("child registration reply failure never releases its event or duplicates a mother's reply", async () => {
  const h=harness({registrationError:true});
  await h.post([message('會員註冊','registration'),message('會員中心','area'),message('daily','daily')]);
  assert.equal(h.calls.registration.length,1);assert.equal(h.calls.daily.length,1);
  assert.deepEqual(forwardedIds(h.calls.fetch[0]),['area']);assert.equal(h.calls.fetch.length,1);
});

test("child member area replies once with a single member link, without rewarding or binding", async () => {
  const h = harness({rewardKeywords:["會員專區"], templateKeywords:["會員專區"]});
  await h.post([message("會員專區","area"), message("daily","daily"), follow, message("會員中心","mother")]);
  assert.equal(h.calls.memberArea.length,1);
  assert.equal(h.calls.daily.length,1);
  assert.equal(h.calls.reward.length+h.calls.bind.length+h.calls.template.length,0);
  assert.deepEqual(forwardedIds(h.calls.fetch[0]),["follow-new","mother"]);
  assert.equal(h.calls.fetch[0].headers["x-line-signature"],sign(h.calls.fetch[0].body));
  const card = h.calls.memberArea[0].messages[0];
  const buttons = JSON.parse(JSON.stringify(card.contents.footer.contents));
  assert.deepEqual(buttons.map(b=>b.action.label),["開啟會員專區"]);
  for (const button of buttons) {
    const url = new URL(button.action.uri);
    assert.equal(url.origin,"https://liff.line.me");
    assert.equal(url.pathname,"/2007674851-test");
    assert.equal(url.searchParams.has("lineUid"),false);
  }
  assert.equal(new URL(buttons[0].action.uri).searchParams.get("open"),"member");
});

test("child member area exception or rejected reply never falls through to mother", async () => {
  for (const options of [{memberAreaError:true},{memberAreaOk:false}]) {
    const h=harness(options);
    await h.post([message("會員專區")]);
    assert.equal(h.calls.memberArea.length,1);
    assert.equal(h.calls.fetch.length+h.calls.reward.length+h.calls.bind.length,0);
    assert.ok(h.calls.diagnostics.has("WEBHOOK_EVENT_ERROR_LAST"));
  }
});

const filter = process.argv.find(arg => arg.startsWith("--filter="))?.slice(9);
const selected = tests.filter(test => !filter || test.name.includes(filter));
for (const { name, body } of selected) {
  await body();
  console.log("PASS " + name);
}
console.log(selected.length + "/" + selected.length + " webhook routing regressions passed (all network/storage mocked).");
