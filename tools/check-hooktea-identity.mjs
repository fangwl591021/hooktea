import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

const workerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../worker.js");
const source = fs.readFileSync(workerPath, "utf8");
const UID = "U" + "a".repeat(32);
const OTHER = "U" + "b".repeat(32);

function runtime(options = {}) {
  const values = new Map(Object.entries({
    SYSTEM_SETTINGS: { liff_id: "2007674851-test" },
    ["USER_" + UID]: { userId: UID, lineUserId: UID, linkedLineUid: UID, name: "Member" },
    ...options.values,
  }));
  const writes = [];
  const sandbox = {
    console, setTimeout, clearTimeout, URL, URLSearchParams, TextEncoder, TextDecoder,
    Request, Response, Headers, FormData, Blob, AbortSignal, AbortController, atob, btoa,
    crypto: webcrypto,
    createPointService: () => { throw new Error("unexpected point operation"); },
    fetch: async (url, init = {}) => {
      if (String(url).startsWith("https://api.line.me/oauth2/v2.1/verify?")) {
        return Response.json({ client_id: options.clientId || "2007674851", expires_in: options.expired ? 0 : 3600 }, { status: options.invalidToken ? 401 : 200 });
      }
      if (String(url) === "https://api.line.me/v2/profile") return Response.json({ userId: options.uid || UID, displayName: "Verified Member", pictureUrl: "" });
      throw new Error("Unexpected network request: " + url);
    },
  };
  const context = vm.createContext(sandbox);
  new vm.Script(source.replace(/^import[^\n]+\n/gm, "").replace(/\bexport default\s+\{/, "globalThis.__worker = {"), { filename: workerPath }).runInContext(context);
  context.safeGetKV = async (_env, key, fallback) => values.has(key) ? structuredClone(values.get(key)) : structuredClone(fallback);
  context.safePutKV = async (_env, key, value) => { writes.push(key); values.set(key, structuredClone(value)); return { ok: true }; };
  context.putUserKV = async (_env, _ctx, uid, value) => { writes.push("USER_" + uid); values.set("USER_" + uid, structuredClone(value)); };
  context.getHuaxuShopOrders = async () => structuredClone(options.orders || []);
  context.listKVRecords = async (_env, prefix) => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, data]) => ({ key, data: structuredClone(data) }));
  context.listUserRecords = async () => [...values].filter(([key]) => key.startsWith("USER_")).map(([, data]) => structuredClone(data));
  return { get: name => vm.runInContext(name, context), values, writes, context };
}
function request(route, payload, token = "") {
  return new Request("https://hooktea.test" + route, {
    method: payload === undefined ? "GET" : "POST",
    headers: { ...(payload === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: "Bearer " + token } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}
const env = { ADMIN_PASSWORD: "configured-secret" };

test("all personal write APIs reject absent and expired tokens before any write", async () => {
  for (const handler of ["handleHuaxuMemberProfile", "handleHuaxuUpdateMemberProfile", "handleHuaxuCreateOrder", "handleHuaxuCancelOrder", "handleHuaxuReportRemittance", "handleReferralRegister"]) {
    for (const invalidToken of [false, true]) {
      const rt = runtime({ invalidToken });
      const response = await rt.get(handler)(request("/api/test", { lineUserId: OTHER, accessToken: invalidToken ? "expired" : "" }), env, null, {});
      assert.equal(response.status, 401, handler);
      assert.equal(rt.writes.length, 0, handler);
    }
  }
});

test("verified tokens cannot claim a different LINE UID", async () => {
  const rt = runtime();
  for (const payload of [{ accessToken: "valid", lineUserId: OTHER }, { accessToken: "valid", lineProfile: { userId: OTHER } }]) {
    const result = await rt.get("requireHuaxuIdentity")(request("/api/test", payload), env, payload);
    assert.equal(result.response.status, 403);
  }
  assert.equal(rt.writes.length, 0);
});

test("token audience and expiry are validated against Login channel, not Messaging channel", async () => {
  const rt = runtime({ clientId: "999999" });
  const result = await rt.get("requireHuaxuIdentity")(request("/api/test", undefined, "valid"), { ...env, LINE_CHANNEL_ID: "999999" });
  assert.equal(result.response.status, 401);
  const expired = runtime({ expired: true });
  assert.equal((await expired.get("requireHuaxuIdentity")(request("/api/test", undefined, "valid"), env)).response.status, 401);
});

test("Bearer auth resolves an existing verified member without trusting submitted member IDs", async () => {
  const rt = runtime();
  const result = await rt.get("requireHuaxuIdentity")(request("/api/test", undefined, "valid"), env, { memberUid: "OTHER_LEGACY" });
  assert.equal(result.ok, true);
  assert.equal(result.memberUid, UID);
  assert.equal(result.profile.name, "Verified Member");
});

test("existing conflicting binding fails closed and stays unchanged", async () => {
  const fixture = {
    ["LINE_BIND_" + UID]: { lineUserId: UID, legacyUserId: "OLD_1" },
    USER_OLD_1: { userId: "OLD_1", lineUserId: OTHER, linkedLineUid: UID, name: "Wrong account" },
  };
  const rt = runtime({ values: fixture });
  const before = JSON.stringify([...rt.values]);
  const result = await rt.get("requireHuaxuIdentity")(request("/api/test", undefined, "valid"), env);
  assert.equal(result.response.status, 409);
  const binding = await rt.get("bindLegacyMemberToLine")(env, null, UID, { phone: "0912345678" });
  assert.equal(binding.bound, false);
  await assert.rejects(rt.get("ensureFastLineCheckinMember")(env, null, UID), /MEMBER_IDENTITY_REVIEW_REQUIRED/);
  assert.equal(JSON.stringify([...rt.values]), before);
  assert.equal(rt.writes.length, 0);
});

test("historical name-only links require review even when their UID fields agree", async () => {
  const rt = runtime({ values: {
    ["LINE_BIND_" + UID]: { lineUserId: UID, legacyUserId: "OLD_1", source: "exact_line_name" },
    USER_OLD_1: { userId: "OLD_1", lineUserId: UID, linkedLineUid: UID },
  } });
  assert.equal((await rt.get("requireHuaxuIdentity")(request("/api/test", undefined, "valid"), env)).response.status, 409);
  assert.equal(rt.writes.length, 0);
});

test("typed matching phone and unique display name cannot acquire an old account", async () => {
  const rt = runtime({ values: {
    LEGACY_PHONE_0912345678: { userId: "OLD_1" },
    USER_OLD_1: { userId: "OLD_1", legacyMemberId: "OLD_1", phone: "0912345678", name: "Verified Member" },
  } });
  const phone = await rt.get("bindLegacyMemberToLine")(env, null, UID, { phone: "0912345678" });
  assert.equal(phone.bound, false);
  assert.equal(phone.reason, "phone_match_requires_review");
  const name = await rt.get("bindUniqueLegacyMemberByLineName")(env, null, UID, { name: "Verified Member" });
  assert.equal(name.bound, false);
  assert.equal(rt.writes.length, 0);
});

test("trusted legacy binding resolves the server member and does not change identity", async () => {
  const rt = runtime({ values: {
    ["LINE_BIND_" + UID]: { lineUserId: UID, legacyUserId: "OLD_1", source: "admin_review" },
    USER_OLD_1: { userId: "OLD_1", lineUserId: UID, linkedLineUid: UID },
  } });
  const identity = await rt.get("requireHuaxuIdentity")(request("/api/test", undefined, "valid"), env);
  assert.equal(identity.ok, true);
  assert.equal(identity.memberUid, "OLD_1");
});

test("public order listing is denied, members see only their own orders", async () => {
  const orders = [
    { orderId: "own", userId: UID, lineProfile: { userId: UID } },
    { orderId: "other", userId: OTHER, lineProfile: { userId: OTHER }, phone: "PRIVATE" },
    { orderId: "conflicting", userId: UID, lineProfile: { userId: OTHER } },
    { orderId: "pointAliasOnly", userId: OTHER, pointsMemberUid: UID },
  ];
  const rt = runtime({ orders });
  assert.equal((await rt.get("handleHuaxuReadOrders")(request("/api/huaxu/orders"), env)).status, 401);
  const response = await rt.get("handleHuaxuReadOrders")(request("/api/huaxu/orders", undefined, "valid"), env);
  assert.deepEqual((await response.json()).map(row => row.orderId), ["own"]);
});

test("order status exposes only an allowlisted own-order view", async () => {
  const rt = runtime({ orders: [
    { orderId: "own", userId: UID, status: "PAID", phone: "PRIVATE", address: "PRIVATE", paymentStatus: "PAID", pointsUsed: 5 },
    { orderId: "other", userId: OTHER, phone: "PRIVATE" },
  ] });
  const own = await rt.get("handleHuaxuReadOrders")(request("/api/huaxu/orders/status?orderId=own", undefined, "valid"), env, true);
  const data = await own.json();
  assert.equal(data.order.orderId, "own");
  assert.equal(data.order.status, "PAID");
  assert.equal(Object.hasOwn(data.order, "phone"), false);
  assert.equal(Object.hasOwn(data.order, "address"), false);
  assert.equal((await rt.get("handleHuaxuReadOrders")(request("/api/huaxu/orders/status?orderId=other", undefined, "valid"), env, true)).status, 404);
});

test("configured admin auth retains order access, historical default passwords do not", async () => {
  const rt = runtime({ orders: [{ orderId: "private", userId: OTHER }] });
  for (const password of ["@1234", "Tonyffang123", "configured-secret"]) {
    const req = new Request("https://hooktea.test/api/huaxu/orders", { headers: { "x-hooktea-admin-password": password } });
    const result = await rt.get("handleHuaxuReadOrders")(req, env);
    assert.equal(result.status, password === "configured-secret" ? 200 : 401);
    const access = await rt.get("resolveAccess")(env, "GUEST", { adminPassword: password }, "", "");
    assert.equal(access.isAdmin, password === "configured-secret");
  }
});

test("authenticated member cannot cancel or report payment on another member's order", async () => {
  for (const handler of ["handleHuaxuCancelOrder", "handleHuaxuReportRemittance"]) {
    const rt = runtime({ values: { ORDERS: [{ orderId: "victim", userId: OTHER, status: "PENDING", paymentMethod: "REMITTANCE" }] } });
    const payload = { accessToken: "valid", orderId: "victim", remittance: "12345", memberUid: OTHER };
    const response = await rt.get(handler)(request("/api/test", payload), env, null, {});
    assert.equal(response.status, 403);
    assert.equal(rt.writes.length, 0);
  }
});

test("legacy API rejects conflicting binding before exposing member roles", async () => {
  const rt = runtime({ values: {
    ["LINE_BIND_" + UID]: { legacyUserId: "admin-record", lineUserId: UID },
    "USER_admin-record": { userId: "admin-record", lineUserId: OTHER, isAdmin: true },
  } });
  const access = await rt.get("resolveAccess")(env, UID, {}, "", "valid");
  assert.equal(access.identityConflict, true);
  assert.equal(access.isAdmin, false);
  assert.equal(access.hasVerifiedLineUser, false);
  assert.equal(access.userData, null);
});

test("referral registration verifies the new member before writing", async () => {
  const rt = runtime();
  const payload = { accessToken: "valid", lineUserId: UID, ref: OTHER, lineProfile: { userId: UID, displayName: "Forged Name" } };
  const response = await rt.get("handleReferralRegister")(request("/api/referral/register", payload), env, null);
  assert.equal(response.status, 200);
  assert.equal(rt.values.get("REFERRAL_REG_" + UID).displayName, "Verified Member");
  assert.equal(rt.values.get("USER_" + UID).referredBy, OTHER);
});
