# 證據不足的追蹤紀錄不發 Telegram

範圍只限 tracking_unresolved / tracking_recovered。這兩類只表示結束紀錄缺漏或後續補記，不能推定客戶交易失敗。後台保留待查與歷史通知，不刪除紀錄、不偽造送達、不把未知改成成功。

- 排程核對只維護 crm_request_reviews，不建立上述 Telegram 告警。
- 新通知入口、durable outbox、發送 claim、排程 drain 與最終 sender 均阻擋上述代碼；舊版已排隊但未送出的同類通知也不發送。
- 後台對上述歷史告警顯示「此類現僅後台待查、不再通知」；未送出顯示「僅後台待查，不發 Telegram」。
- 已確認的服務、付款、點數錯誤及客戶反饋不在本次靜默範圍。
- 不包含尚未完成的 10 分鐘客戶待處理提醒，不改 LINE 回覆、帳本、訂單或資料庫結構。

驗證：9 組 workerd 告警測試、12 組安全監控測試、24 項後台測試、git diff --check 與 Wrangler dry-run 通過。外部 LINE/Telegram/AI 在測試中完全模擬。

原測試把全佇列待送數硬編碼為零，但前段刻意保留一筆限流告警；修正為比較基準待送數，並等待前段背景工作完成，確保真實錯誤沒有被誤清除。

部署：Worker 使用原有設定，監控 HTML 同步 GitHub main 與 R2 static/line-oa-monitor.html。無 D1 migration。回復需還原 Worker 及該 HTML，注意舊版會重新啟用未確認追蹤通知，故不應自動回復此政策。

依 Workers 與 Wrangler 技能執行隔離驗證、部署演練與回復確認。參考 [Cloudflare Workers 最佳實務](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。
