# 驗證紀錄

驗證日期：2026-10-15（台灣時間）。這是本機／隔離容器測試，尚未發布到你的正式 Cloudflare／GitHub 帳號。

## GitHub Pages＋Cloudflare 更新

專案已新增 `cloudflare/worker.ts`、D1 binding／migration、UTC 16:00（台灣午夜）與每 15 分鐘補刪排程，以及 GitHub Pages 子路徑建置／跨來源 API 設定。原本的 Node／Docker 版本保留。

- Cloudflare 核心測試 6 項通過：真實 SQLite 模擬 D1 atomic batch 契約，驗證 CORS preflight、允許來源、憑證隔離、同名競爭、重試冪等、逐筆授權、修改撤回、台灣午夜與多日實體刪除、限流及缺少 Secret 時拒絕服務。
- 實際 workerd／D1 binding 本機整合測試通過：無需帳號金鑰，使用隨機獨立 state，實際套用 migration、發送 HTTP 請求、觸發 `scheduled` handler，查核過期資料確實從主要資料庫刪除，重跑安全。
- Pages 跨來源瀏覽器整合測試通過：以 `/Tabletennis_team_Sign-in_system/` 建置並提供靜態網頁，兩個獨立瀏覽器連接另一個 origin 的真實 workerd／D1；登記、修改、撤回均自動同步，沒有 CORS／JavaScript 錯誤，手機沒有橫向溢出。
- `wrangler deploy --dry-run` 通過：Worker 可由官方工具打包，不會發布到帳號，也不會把 DB 管理金鑰放進前端。
- GitHub Pages 與 Cloudflare 的正式部署尚未執行；GitHub repository Secrets／Variables、D1／Worker 建立及 Pages 開關需由帳號擁有者完成。操作見 [CLOUD_DEPLOY.md](./CLOUD_DEPLOY.md)。
- Cloudflare D1 Time Travel 免費方案有最近 7 天的還原範圍；每日主要資料庫刪除不等於平台備份立刻清除。

## 已實作並執行測試

| 驗證 | 結果 | 範圍 |
| --- | --- | --- |
| TypeScript | 通過 | 前端及後端型別檢查 |
| 正式建置 | 通過 | Vite 靜態資產、編譯後 Node API／scheduler |
| 核心測試 | 8 項通過 | 真實 HTTP 與 SQLite，非前端陣列或 mock DB |
| Playwright Chromium | 3 項通過 | 獨立瀏覽器、真實 API、自動同步、手機排版與跨日 |
| Docker Linux ARM64 建置 | 通過 | Node 24、多階段建置、非 root 正式映像 |
| 隔離 Compose 容器測試 | 通過 | API／scheduler 各自健康、共用 volume、0600 DB 權限、實際刪除與重跑、app 重啟保留今日資料 |
| Caddy 設定檢查 | 通過 | 使用正式 Caddy 映像驗證設定語法；未申請正式憑證 |
| 本機操作命令 | 通過 | `db:migrate`、`cleanup`、`dev`，API／Vite／scheduler 均可啟動 |

核心測試包含：請假／遲到、必填與 Unicode 長度、空白輸入、ETA 格式、伺服器指定台灣日期、忽略客戶端日期、台灣午夜前後、排程暫時失敗仍隱藏舊資料、補刪多日資料、重跑清除不影響今天、檔案 DB 重開與多連線、同名併發確認、重複 POST 只有一筆、公開 API 不含管理憑證／雜湊、無憑證／錯誤憑證不能修改刪除、同源保護與限流。

瀏覽器測試包含：兩個獨立 context（洛杉磯與奧克蘭時區）取得同一份今日資料、缺少原因無法送出、模擬網路失敗後保留輸入並重試、同名確認、他人沒有管理按鈕且直接呼叫 API 也失敗、修改與撤回在另一瀏覽器自動出現、320/375/390/768/1280px 長姓名與長原因無橫向捲動、送出按鈕達 44px、篩選操作。跨日 UI 測試使用測試 route 提供午夜前的伺服器時間，然後中斷 API，確認午夜自動清掉舊名單；正式程式沒有測試時間端點。

容器測試的舊資料只放在隨機專案名稱的隔離 volume，結束後移除該專案容器、網路與 volumes，不建立正式示範資料。瀏覽器測試資料位於忽略追蹤的 `.test-data`，不會進入正式映像中的資料庫。瀏覽器測試沒有啟用 trace、錄影或分析服務。

## 仍需要部署後驗證

- 提供常駐主機與網域，設定 DNS／防火牆／NTP；確認外部 HTTPS 能取得憑證，手機行動網路可開啟。
- 用兩台實際裝置驗證公開存取、同一份名單、自動同步及原裝置管理。
- 確認持久化 volume、主機開機啟動、app 與 scheduler 監控；觀察實際台灣午夜排程與無訪客時刪除。測試已驗證 cron 下一次執行時間與清除函式，但不以此宣稱外部主機已在指定午夜執行。
- 在獨立 staging 模擬程序／主機中斷，確認恢復後補刪；確認監控會對 scheduler 不健康或心跳過期告警。
- 檢查主機商、磁碟、volume 備份／快照與既有備份；檢查 CDN/WAF／反向代理／平台日誌保留及 Authorization／body 遮蔽。主要 DB 刪除不等於所有平台副本立即消失。
- iOS Safari、Android 實機鍵盤、時間選擇器與輔助工具仍需現場驗證；目前自動 UI 測試為桌面 Chromium 的手機 viewport／觸控模擬。

完整啟動、環境變數、資料庫初始化、部署與排程操作見 [README.md](./README.md)。
