# hooktea

Hooktea Cloudflare Worker project copied from `fangwl591021/action`.

Production Worker:

https://hooktea.fangwl591021.workers.dev/

## Worker variables for LINE Pay

- `LINEPAY_ENV`: `sandbox` or `production`
- `LINEPAY_CHANNEL_ID`: LINE Pay channel ID
- `LINEPAY_CHANNEL_SECRET`: LINE Pay channel secret
- `LINEPAY_CURRENCY`: default `TWD`

## Keyword reward duplicate rule

This rule is fixed behavior and must not be changed without explicit approval.

- Keyword rewards are one-time per LINE user and keyword.
- The duplicate key is `KEYWORD_REWARD_${LINE_UID}_${keywordHash}`.
- On every keyword message, the Worker must check this key before any CRM lookup, points lookup, or mother-site sync.
- If the key already exists, reply immediately: `這組活動關鍵字已領取過，不能重複領取。`
- Duplicate requests must not call WordPress/WETW point insert again.
- Do not move duplicate detection behind CRM/member lookup; slow CRM lookup previously caused no reply in LINE.
