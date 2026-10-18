# 驗證紀錄

最新驗證日期：2026-10-18（台灣時間）。本次修正已在本機與隔離環境驗證，尚未推送／部署；正式網站另做唯讀檢查。下方舊日期區段保留各次檢查當時的狀態。

## 2026-10-18 專案總檢查

檢查前端、Node／Cloudflare API、輸入驗證、逐筆管理憑證、管理員 session、schema／migration、台灣日期與清除排程、環境變數、Docker 及 GitHub 部署設定。沒有重設正式密碼、變更資料庫 schema 或新增正式測試資料。

已修正並加入回歸測試：

1. **成功回覆丟失後修改內容再重試，可能誤報成功。** 原後端對相同 ID 一律回傳舊內容 200；新增測試先重現此錯誤。現在相同內容仍可安全重試，不同內容回傳明確衝突，前端保留輸入並切換為「儲存修改」，確認後更新同一筆資料。
2. **慢速連線的輪詢互相干擾。** 原本每 10 秒開始新請求，會使仍在等待的前一個回覆失效；連線長期超過 10 秒時可能一直無法更新。現在一次只讀取一份名單，後續刷新合併排隊；修改、撤回、換日與頁面喚醒仍使舊快照失效。
3. **本機密碼工具將 dotenv 當作 JSON 編碼。** 雙引號／反斜線可能改變實際保存的密碼。現在採用可由 Node 與 Compose 正確讀取的引號並驗證回讀結果，單引號包覆也避免 Compose 展開 `$`。無法相容的特殊組合會明確報錯且不改檔；可直接設定伺服器環境。現有 `.env` 與正式 Secrets 未修改。

| 本次實際執行 | 結果 |
| --- | --- |
| `npm run typecheck`、`npm run build` | 通過；前端、Node、Worker 型別及正式產物 |
| `npm test` | 11 項通過；真實 HTTP／SQLite，包含特殊字元密碼設定及重試衝突 |
| `npm run test:cloudflare` | 10 項通過；D1 交易契約、權限、管理員、限流、跨日刪除及重試衝突 |
| `npm run test:e2e` | 6 項通過；Chromium，包含成功回覆中斷後修改重試、慢速輪詢、雙瀏覽器同步、手機長內容、離線午夜及管理員流程 |
| `npm run test:pages:e2e` | 通過；實際 workerd／隔離 D1、Pages 子路徑、跨來源雙瀏覽器、管理員及 scheduled handler 實體刪除與重跑 |
| `npm run cloudflare:check` | 通過；官方 Wrangler 僅打包，不發布 |
| `npm run test:container` | 通過；Linux ARM64 正式映像、非 root、資料庫權限、獨立 scheduler、重啟保存、過期過濾、實體刪除重跑與 Caddy 語法 |
| `npm audit --json` | 當次官方漏洞資料庫回傳 0 項已知漏洞，包含開發依賴；不代表未來不會發現漏洞 |
| 前端產物祕密檢查 | 未發現本機已設定的管理員密碼／限流祕密；檢查不印出值，前端只使用公開 API URL |
| `git diff --check` | 通過 |

瀏覽器手機排版測試涵蓋 320／375／390／768／1280px、20 字姓名、長連續原因與至少 44px 主要按鈕。測試只使用獨立資料庫／隔離 volume；容器測試結束已移除自身容器與 volumes。

正式站唯讀查核：GitHub Pages、`/api/health`、`/api/today` 均回應 200；API 台灣日期符合查核當天，回傳紀錄日期與公開欄位符合規則，`no-store` 與允許來源正確。真實 Chromium 開啟正式站，表單可操作、管理員入口存在、未發現頁面 JavaScript 錯誤或 375px 橫向溢出。未輸出正式姓名／原因，未提交、修改或刪除正式資料，亦未用正式管理員帳密登入。

上述正式站結果屬於**既有部署**，不表示這次修正已上線。需要提交／推送本次變更，待 `Test` 與 `Deploy GitHub Pages and Cloudflare` 成功；不需新增 Secret、migration 或手動改排程。正式帳號的午夜排程事件、平台備份／日誌設定、真機 iOS Safari／Android 行為，仍須依部署文件現場確認。自動測試無法保證任何情況都沒有 bug。

## 2026-10-16 管理員功能更新

新增頁尾登入入口、管理員修改／刪除今日登記、伺服器端 2 小時隨機 session、登出撤銷、登入限流與過期 session 清除。帳密只由伺服器環境設定，公開 API 不會傳回管理員密碼、session token 或 fingerprint。一般隊員的表單、管理自己的憑證、篩選、自動同步與午夜清除保持原有規則。

本機 Node 核心測試 9 項、Cloudflare 核心測試 9 項通過，包含未登入／一般個人憑證無法管理他人、錯誤帳密、有效 session 修改他人、原填寫者仍可修改、登出後拒絕、到期拒絕、密碼更換後拒絕、登入限流、同名確認與過期資料不可管理。使用測試專用帳密，不將正式帳密寫進測試或原始碼。

Playwright 4 項測試通過，新增頁尾登入、錯誤密碼、重新整理登入還原、管理他人登記、其他瀏覽器自動同步、登出撤銷與手機寬度檢查。實際 workerd／D1 加 Pages 子路徑的跨來源瀏覽器測試亦通過同一管理流程；未使用假的 API 取代雲端執行環境。

本次為本機變更，正式網站需新增 GitHub Secret `ADMIN_PASSWORD` 並推送新版，才能使用新增入口。這份紀錄不表示新管理員功能已在正式帳號部署。

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
