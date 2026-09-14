import assert from "node:assert/strict";
import { createHmac, webcrypto } from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const signatureHelpers = source.slice(source.indexOf("async function verifyLineWebhookSignature("), source.indexOf("function extractResponseText("));
const webhookMethod = source.slice(source.indexOf("  async handleLineWebhook(request, env, ctx) {"), source.indexOf("  async handleLinePayConfirm(request, env, ctx) {"));
assert.ok(signatureHelpers && webhookMethod, "real Worker webhook code must be loaded");

const secret = "hooktea-test-channel-secret";
const sign = body => createHmac("sha256", secret).update(body).digest("base64");
const message = (text, id = text) => ({ type: "message", webhookEventId: id, replyToken: "reply-" + id, source: { userId: "U-" + id }, message: { id, type: "text", text } });
const follow = { type: "follow", webhookEventId: "follow-new", replyToken: "reply-follow", source: { userId: "U-new" } };

function harness(options = {}) {
  const calls = { reward: [], daily: [], template: [], bind: [], monitor: [], referral: [], fetch: [], diagnostics: new Map(), errors: [] };
  const env = { LINE_CHANNEL_SECRET: secret, FORWARD_WEBHOOK_URL: "https://mother.invalid/webhook", ...(options.env || {}) };
  const runLocal = name => async (...args) => {
    const event = args[2] || args[1];
    calls[name].push(event);
    if (options[name] instanceof Error) throw options[name];
    return options[name] ?? true;
  };
  const sandbox = {
    crypto: webcrypto, TextEncoder, Uint8Array, btoa, atob, Request, Response, AbortSignal,
    console: { error: (...args) => calls.errors.push(args) },
    getLineChannelSecret: env => env.LINE_CHANNEL_SECRET,
    getLineChannelAccessToken: () => "configured",
    safeGetKV: async () => ({}),
    safePutKV: async (_, key, value) => calls.diagnostics.set(key, value),
    getHookTeaCheckinTemplate: async () => ({}),
    isConfiguredShopKeywordReward: (_, text) => (options.rewardKeywords || ["954e"]).includes(text),
    isHookTeaCheckinTemplateTrigger: (_, text) => (options.templateKeywords || ["template"]).includes(text),
    isHookTeaDailySigninKeyword: text => text === "daily",
    isMotherSiteKeyword: text => ["會員專區", "會員打卡", "分享好友"].includes(text),
    motherSiteKeywordType: () => "member",
    isReferralInviteKeyword: text => ["推薦好友", "分享好友"].includes(text),
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
      return event.message.text === "bind";
    },
    appendLineMonitorEvent: async (_, __, event) => calls.monitor.push(event),
    buildReferralInviteUrl: () => "https://shop.invalid/invite",
    buildReferralShareUrl: () => "https://shop.invalid/share",
    referralShareFlexMessage: args => args,
    replyLineMessage: async (_, replyToken) => {
      calls.referral.push(replyToken);
      return { ok: true };
    },
    fetch: async (url, request) => {
      calls.fetch.push({ url, ...request });
      if (options.forwardError) throw new Error("simulated uncertain forward failure");
      return new Response("mother reply", { status: options.forwardStatus || 200 });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(signatureHelpers + "\nconst handler = {\n" + webhookMethod + "\n}; globalThis.handler = handler;", sandbox);
  return {
    calls, env, sandbox,
    async post(events, { raw, signature, noContext = false } = {}) {
      const body = raw || JSON.stringify({ destination: "test-OA", events });
      const request = new Request("https://hooktea.invalid/webhook", { method: "POST", body, headers: { "x-line-signature": signature === undefined ? sign(body) : signature } });
      const pending = [];
      const response = await sandbox.handler.handleLineWebhook(request, env, noContext ? null : { waitUntil: promise => pending.push(promise) });
      while (pending.length) await Promise.all(pending.splice(0));
      return response;
    },
  };
}
const tests = [];
function test(name, body) { tests.push({ name, body }); }
const forwardedIds = call => JSON.parse(call.body).events.map(event => event.webhookEventId);

test("mixed mother + local reward + follow has no lost events and a correct filtered signature", async () => {
  const h = harness({ env: { GAS_URL: "https://gas.invalid/duplicate" } });
  const response = await h.post([message("會員專區", "mother"), message("954e", "gift"), follow]);
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
  const events = [message("會員專區", "mother"), message("一般訊息", "general")];
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
  await h.post([message("954e", "gift"), message("daily", "daily"), message("會員專區", "mother")]);
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

test("local configured reward wins overlaps, template precedes daily, mother owns its referral keyword", async () => {
  const h = harness({ rewardKeywords: ["954e", "會員打卡"], templateKeywords: ["template", "daily"] });
  await h.post([message("會員打卡", "reward-overlap"), message("daily", "template-overlap"), message("分享好友", "mother-referral"), message("推薦好友", "local-referral")]);
  assert.equal(h.calls.reward.length, 1);
  assert.equal(h.calls.template.length, 1);
  assert.equal(h.calls.daily.length, 0);
  assert.equal(h.calls.referral.length, 1);
  assert.deepEqual(forwardedIds(h.calls.fetch[0]), ["mother-referral"]);
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
    await h.post([message("會員專區")]);
    assert.equal(h.calls.fetch.length, 1);
    assert.equal(h.calls.diagnostics.get("WEBHOOK_FORWARD_LAST").ok, false);
  }
});

for (const { name, body } of tests) {
  await body();
  console.log("PASS " + name);
}
console.log(tests.length + "/" + tests.length + " webhook routing regressions passed (all network/storage mocked).");
