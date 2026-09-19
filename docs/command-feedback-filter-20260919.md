# 系統關鍵字誤報修正

基底：正式版對應 commit 89cb9d52e3dbcc645177c2ccaa0720d85c7a0965；checkout work/hooktea-alert-hotfix。

## 原因

監控把所有文字交給 AI 分類，純「會員專區」可能被分類為 identity。入佇列及發送時均未排除系統指令，形成客戶詢問誤報。

## 變更

- 新增 monitor-commands.js，只負責監控資格，不更動 webhook 回覆所有權、活動設定或點數交易。
- 收錄與背景分類排除完整相同的固定／自訂／停用活動指令；保留原文，category=none、analysis_state=done、analysis_error=system_command，不呼叫 AI、不建立通知。
- 每次發送前依當時 KV 設定及原始證據重核，包含舊版待送佇列。命中指令標記 feedback_system_command，停止再送，但 sent_at 保持 NULL，不假稱送達、不刪除歷史。
- 指令比較採 NFKC、空白及零寬字元正規化，非子字串比對。「會員專區打不開，怎麼辦？」仍保留為詢問。
- 補上請問／如何／怎麼等實際詢問辨識；資訊不足或設定讀取失敗保留後台待查，不送含糊通知。
- 不更動正式設定／會員／點數／訂單，不發送真實 LINE 或 Telegram 測試。

## 測試

通過 check-owner-feedback-and-signin、check-monitor-safety、check-operational-alerts、check-hooktea-webhook、check-monitor-auth、check-new-member-points、check-hooktea-checkout，以及 git diff --check。

新增案例：28 種固定、自訂、停用、全形與空白指令；舊 pending 分類；舊佇列誤報；發送前更新關鍵字；設定讀取失败；同批指令與真實產品問題；保留含關鍵字的真正詢問。

## 明確限制

這次僅修正關鍵字誤報。既有通知時間策略未變更；「超過 10 分鐘且無人工回覆」的完整判定尚未接通，尤其目前不能由監控紀錄證明 LINE OA 後台是否人工回覆。通知仍使用「請先確認是否已有人回覆」而非宣稱客戶未獲回覆。不可把本次修正描述為完整逾時客服提醒已完成。

無資料庫 migration。部署後預期 /api/health.alertRelease 為 20260919-command-feedback-filter-v1；實際部署與正式驗證另記於工作區 outputs/COMMAND-FILTER-RELEASE-20260919.md，不以此設計文件宣稱線上已生效。
