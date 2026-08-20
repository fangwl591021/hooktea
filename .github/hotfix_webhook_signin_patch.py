from pathlib import Path

path = Path("worker.js")
text = path.read_text(encoding="utf-8")

def replace_once(old: str, new: str, label: str):
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, got {count}")
    text = text.replace(old, new, 1)

# Re-sign any rebuilt LINE webhook body.
anchor = "async function verifyLineWebhookSignature(env, rawText, signature) {"
helper = '''async function signLineWebhookBody(env, rawText) {
  const secret = getLineChannelSecret(env);
  if (!secret) return "";
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(String(rawText || "")));
  let binary = "";
  for (const byte of new Uint8Array(signed)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

'''
if "async function signLineWebhookBody(env, rawText)" not in text:
    replace_once(anchor, helper + anchor, "sign helper")

# Atomic D1 claim before mother-site mutation.
replace_once(
'''  queueDiagnostic({ status: "matched_entered" });
  const timeout = (ms, value) => new Promise(resolve => setTimeout(() => resolve(value), ms));

  const existing = await getKvJsonOnly(env, recordKey, null);''',
'''  queueDiagnostic({ status: "matched_entered" });
  const timeout = (ms, value) => new Promise(resolve => setTimeout(() => resolve(value), ms));
  const lineEventId = String(event?.webhookEventId || event?.message?.id || "").trim();

  if (env.DB) {
    try {
      const claimInsert = await env.DB.prepare(`
        INSERT OR IGNORE INTO daily_signin_claims
          (line_user_id, claim_date, status, line_event_id, reward_points, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(lineUid, rewardDate, lineEventId || null, points).run();
      const inserted = Number(claimInsert?.meta?.changes || 0) > 0;
      const claim = await env.DB.prepare(`
        SELECT status, mother_balance_after
        FROM daily_signin_claims
        WHERE line_user_id = ? AND claim_date = ?
        LIMIT 1
      `).bind(lineUid, rewardDate).first();
      if (!inserted) {
        const balanceText = Number.isFinite(Number(claim?.mother_balance_after))
          ? ` 點數餘額 ${Number(claim.mother_balance_after)} 點數。`
          : "";
        const duplicateText = claim?.status === "failed"
          ? "今天簽到狀態待確認，為避免重複贈點，系統不會再次自動加點。請至會員專區確認點數或通知管理員。"
          : `今天已領取虎克茶簽到贈點，不能重複領取。${balanceText}`;
        const delivery = await deliverKeywordRewardReplyFast(env, lineUid, replyToken, textLineMessage(duplicateText), 1800);
        queueDiagnostic({ status: "d1_duplicate", claimStatus: claim?.status || "unknown", balanceAfter: claim?.mother_balance_after ?? null, delivery });
        return true;
      }
      queueDiagnostic({ status: "d1_claim_created", lineEventId });
    } catch (error) {
      queueDiagnostic({ status: "d1_claim_error", error: error?.message || String(error) });
    }
  }

  const existing = await getKvJsonOnly(env, recordKey, null);''',
"daily claim"
)

# Preserve prior local POINTS history.
replace_once(
'''  const pointUid = memberUid || lineUid;
  const pointData = { balance: 0, logs: [] };
  const rewardReason = "虎克茶簽到贈點 " + rewardDate;
  queueDiagnostic({ status: "point_record_skipped_for_daily_signin", memberUid, pointUid });''',
'''  const pointLookup = await getPointDataForUid(env, memberUid || lineUid, { balance: 0, logs: [] });
  const pointUid = pointLookup.pointUid || memberUid || lineUid;
  const pointData = pointLookup.data || { balance: 0, logs: [] };
  const rewardReason = "虎克茶簽到贈點 " + rewardDate;
  queueDiagnostic({ status: "point_record_loaded_for_daily_signin", memberUid, pointUid, localBalance: Number(pointData.balance || 0), localLogCount: Array.isArray(pointData.logs) ? pointData.logs.length : 0 });''',
"preserve point history"
)

replace_once(
'''  queueDiagnostic({ status: "mother_sync_started", memberUid, pointUid });
  const wpRes = await Promise.race([''',
'''  queueDiagnostic({ status: "mother_sync_started", memberUid, pointUid });
  if (env.DB) {
    await env.DB.prepare(`
      UPDATE daily_signin_claims
      SET status = 'reconciling', member_uid = ?, point_uid = ?, reward_points = ?, updated_at = CURRENT_TIMESTAMP
      WHERE line_user_id = ? AND claim_date = ? AND status = 'pending'
    `).bind(memberUid, pointUid, points, lineUid, rewardDate).run().catch(() => {});
  }
  const wpRes = await Promise.race([''',
"reconciling state"
)

replace_once(
'''    const delivery = await deliverKeywordRewardReplyFast(env, lineUid, replyToken, textLineMessage("簽到失敗，母站點數暫時無法同步，請稍後再試。"));''',
'''    if (env.DB) {
      await env.DB.prepare(`
        UPDATE daily_signin_claims
        SET status = 'failed', member_uid = ?, point_uid = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE line_user_id = ? AND claim_date = ?
      `).bind(memberUid, pointUid, String(wpRes?.message || wpRes?.error || "mother_balance_unavailable").slice(0, 500), lineUid, rewardDate).run().catch(() => {});
    }
    const delivery = await deliverKeywordRewardReplyFast(env, lineUid, replyToken, textLineMessage("簽到失敗，母站點數狀態待確認。為避免重複贈點，今天不會再次自動加點；請至會員專區確認或通知管理員。"));''',
"failed state"
)

replace_once(
'''  const delivery = await deliverKeywordRewardReplyFast(env, lineUid, replyToken, textLineMessage(`簽到成功，已贈送 ${points} 點數。點數餘額 ${balanceAfter} 點數。`));''',
'''  if (env.DB) {
    await env.DB.prepare(`
      UPDATE daily_signin_claims
      SET status = 'claimed', member_uid = ?, point_uid = ?, mother_balance_after = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE line_user_id = ? AND claim_date = ?
    `).bind(memberUid, pointUid, balanceAfter, lineUid, rewardDate).run().catch(() => {});
  }
  const delivery = await deliverKeywordRewardReplyFast(env, lineUid, replyToken, textLineMessage(`簽到成功，已贈送 ${points} 點數。點數餘額 ${balanceAfter} 點數。`));''',
"claimed state"
)

# Mother-site fallback: never invent a local +1 credit.
start = text.index("async function handleMotherKeywordFallback")
end = text.index("async function handleLineReferralInviteText", start)
block = text[start:end]
target = '      await api.updatePoints(env, null, memberUid, 1, "會員打卡 CRM fallback", { source: "mother_keyword_crm_fallback" });\n      addedPoints = 1;'
if block.count(target) != 1:
    raise SystemExit(f"mother fallback mutation: expected 1 match, got {block.count(target)}")
block = block.replace(target, '      console.warn("[MotherKeywordFallback] skipped local +1 point mutation to avoid duplicate mother-site credit");\n      addedPoints = 0;', 1)
if block.count("        localMirrored: true,") != 1:
    raise SystemExit("mother fallback localMirrored marker mismatch")
block = block.replace("        localMirrored: true,", "        localMirrored: false,\n        fallbackNoLocalMutation: true,", 1)
block = block.replace('        source: "mother_keyword_crm_fallback",', '        source: "mother_keyword_crm_fallback_no_local_points",', 1)
text = text[:start] + block + text[end:]

# Early return only when all incoming events are mother-site events.
replace_once(
"      if (motherKeywordEvents.length) {",
"      if (motherKeywordEvents.length && motherKeywordEvents.length === events.length) {",
"mother all-events gate"
)

# In a mixed payload, reserve mother-only events for the forward subset.
loop_old = "      for (const event of events) {\n        let handled = false;"
loop_new = "\n".join([
"      for (const event of events) {",
"        const mixedMotherKeywordEvent = event?.type === \"message\"",
"          && event?.message?.type === \"text\"",
"          && isMotherSiteKeyword(event.message.text)",
"          && !isHookTeaDailySigninKeyword(event.message.text)",
"          && !isHookTeaCheckinTemplateTrigger(hookTeaCheckinTemplateForWebhook, event.message.text);",
"        if (mixedMotherKeywordEvent) {",
"          await appendLineMonitorEvent(env, ctx, event).catch(e => console.error(\"LINE Monitor Append Error:\", e));",
"          unhandledEvents.push(event);",
"          continue;",
"        }",
"        let handled = false;",
])
replace_once(loop_old, loop_new, "mixed mother routing")

# Forward only unhandled subset, with a fresh LINE HMAC signature for that exact body.
forward_old = "        if (forwardWebhook && unhandledEvents.length) {\n          await safePutKV(env, \"WEBHOOK_FORWARD_ATTEMPT_LAST\", {"
forward_new = "        if (forwardWebhook && unhandledEvents.length) {\n          const filteredForwardBody = JSON.stringify(forwardPayload);\n          const filteredForwardSignature = await signLineWebhookBody(env, filteredForwardBody).catch(() => \"\");\n          await safePutKV(env, \"WEBHOOK_FORWARD_ATTEMPT_LAST\", {"
replace_once(forward_old, forward_new, "filtered forward preparation")

fetch_old = "\n".join([
"            headers: {",
"              \"Content-Type\": \"application/json\",",
"              \"x-line-signature\": signature",
"            },",
"              body: rawText,",
])
fetch_new = "\n".join([
"            headers: {",
"              \"Content-Type\": \"application/json\",",
"              ...(filteredForwardSignature ? { \"x-line-signature\": filteredForwardSignature } : {})",
"            },",
"              body: filteredForwardBody,",
])
replace_once(fetch_old, fetch_new, "filtered forward body")

path.write_text(text, encoding="utf-8")
print("scoped patch applied")
