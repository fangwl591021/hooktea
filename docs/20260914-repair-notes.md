# HookTea 點數與訂單修復（2026-09-14）

## 行為
- LINE token 驗證、會員綁定衝突和訂單擁有者檢查採取拒絕不確定身分的方式；暱稱或手填手機不能自動取得舊會員。
- 所有 LINE 事件逐筆決定處理者，僅轉送未處理事件，重組的內容重新簽章。
- 共用可用餘額以母站查詢為準。本機歷史點數只保存為待核對快照，不自動相加或補差額。
- 新贈點使用 D1 操作日誌與每個 LINE 帳戶的鎖。未送出的正數操作可於已驗證會員查詢時續處理；未知 POST 結果只用精確交易標記對帳，不自動重送。
- 舊註冊只對尚未有會員資料的新註冊建立一次性贈點意圖；歷史會員編輯不再贈點。兩個既有每日活動仍各自獨立。
- 建單使用 D1 持久請求識別。驗證失敗可重試；已建立訂單的付款失敗保留同一訂單，重試回傳原結果。
- LINE Pay 取消回站本身不修改訂單或退點。會員取消、建單與付款確認使用同一把本地訂單鎖；付款確認須匹配已保存交易編號、未取消且折抵已確認。
- 只有伺服器確認已付款後，前端才清除該次匹配的購物車、草稿與折抵值。

## 驗證
Node.js 24，使用 node:sqlite 執行真正的 SQL 約束；所有網路與會員資料均為本機測試資料。
- node tools/check-hooktea-regressions.mjs：23 項
- node tools/check-hooktea-checkout.mjs：20 項
- node tools/check-hooktea-identity.mjs：14 項
- node tools/check-hooktea-webhook.mjs：13 項
- node --check worker.js / point-service.js
- git diff --check
- npx wrangler@4.102.0 deploy --dry-run --keep-vars

## 部署
先套用 migrations/0005_point_operations.sql，再 deploy --keep-vars。
0004 已於本次之前在正式 D1 套用；保留其 migration 檔以使 GitHub 與正式環境歷史一致。
健康路由 GET /api/health 只回傳服務名稱和發布識別，不讀取會員、點數或訂單。

## 恢復與限制
- queued / pending_member / pending_config：母站確認未送出，正數贈點可於本人已驗證的會員查詢時續處理。
- sending / reconciling：可能已入帳，保留帳戶鎖；精確 [HT:operation_id] 標記且金額吻合才確認。查不到標記、超出母站最近 100 筆或母站異常時，需要管理員查母站原始交易，禁止以餘額差額猜測或直接刪除操作紀錄。
- POINTS_PENDING 訂單：先確認 order-spend 操作。查點不會自動執行尚未送出的扣點。扣點確認後可由已驗證會員取消並建立一次性 order-restore；尚未確認時取消會拒絕。
- PAYMENT_INIT_FAILED 訂單：已保存失敗狀態與請求回應。會員可確認或取消原單後再購物；不盲目重發付款要求。
- 歷史 reconciling / 本機差額：保留為人工核對，不在部署時回補或刪除。新日誌無法證明舊交易是否已入帳。
- order_action_locks 無超時偷鎖：若執行環境中斷留下鎖，須由營運核實執行已停止並檢查對應訂單、付款與操作日誌後再處理；不能在仍有執行中的請求時刪除。
- 帳戶鎖只協調 HookTea；母站與其他商店並行扣點的最終交易保護仍由母站 API 負責。
- 本次不執行正式個人資料端點、真實加點、付款或取消。需由實際會員在 LINE 內進行最終端到端驗收。
