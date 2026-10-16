# GitHub Pages＋Cloudflare：一次設定，之後推送自動部署

這份設定對應你的 repository：

- 程式碼：https://github.com/jingyuan0712/Tabletennis_team_Sign-in_system
- 預期網頁：https://jingyuan0712.github.io/Tabletennis_team_Sign-in_system/
- API：`https://tabletennis-team-api.你的子網域.workers.dev`（必須用 Cloudflare 實際提供的網址）

你的電腦可以關機。不需要租 VPS、不需要購買網域、不需要 Docker；GitHub Pages 提供網頁，Cloudflare Workers 執行 API 與伺服器排程，D1 保存共用資料。現有 Node／Docker 版本保留供本機開發或自行架站。

目前只有程式與設定完成；你的帳號內資源、Secrets、GitHub Pages 開關仍須由你完成。**不要把 Token、密碼或 RATE_LIMIT_SECRET 貼進聊天或 GitHub 檔案。**

## 1. 在 Cloudflare 建立 D1 資料庫

登入 [Cloudflare Dashboard](https://dash.cloudflare.com/)，找到 **Storage & databases → D1 SQL Database**（也可在導覽搜尋 D1），建立資料庫：

```text
tabletennis-team
```

記下資料庫詳細頁的 **Database ID**，是一組 UUID，例如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`。請不要把 Account ID 或資料庫名稱當作 Database ID。

資料表不需要手動建立，也不要放測試隊員。首次部署會套用 `migrations/001_initial.sql`，後續只套用未執行的 migration。D1 沒有對瀏覽器開放的 SQL API／匿名 DB 角色，只有 Worker 的 `DB` binding 和你的帳號／Token 能存取；前端不會得到資料庫管理金鑰。

## 2. 建立 Worker，取得自己的 API 網址

在 **Compute → Workers & Pages** 找到建立 Worker，選擇簡單的 Hello World 起始方式，名稱必須填：

```text
tabletennis-team-api
```

先部署初始 Worker。若首次使用需設定 `workers.dev` 子網域，照畫面設定，不必購買網域。複製 Worker 詳細頁的 HTTPS 網址，例如：

```text
https://tabletennis-team-api.your-name.workers.dev
```

不要包含尾端 `/`，也不要帶 `/api`。目前 Hello World 還不是登記後端；GitHub Actions 會用本專案程式取代它。不用在 Worker 的網頁編輯器手動貼入程式，也不用建立 Cloudflare Pages 專案或另外連接 Workers Builds，以免兩套部署互相覆蓋。

保留 Worker 的公開 `workers.dev` 存取，不要啟用 Cloudflare Access 登入閘道，隊員才可免登入使用。

同一帳號的 **Account ID** 可從 Workers／帳號詳細頁取得；它通常是 32 位十六進位字元。

## 3. 建立部署用 API Token

到 [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)，建立 Custom Token，選擇只限本次帳號的權限：

| 範圍 | 權限 |
| --- | --- |
| Account | Workers Scripts → Edit（新介面若稱 Write，選寫入權限） |
| Account | D1 → Edit |
| Account | Account Settings → Read |

帳號資源只選你的目標帳號；不需要所有 Zone、DNS 編輯或 Global API Key。若帳號使用新版細分 Workers 角色，需對本 Worker 有 Editor 權限，並能讀寫 D1。選合理到期日，屆時更新 GitHub Secret。

Token 通常只會完整顯示一次，**直接保存到下一步的 GitHub Secrets**。不要傳給其他人，不要寫進 `.env.example` 或 repository。部署過程不需要 Cloudflare 登入密碼。

## 4. 設定 GitHub Secrets 與 Variables

打開 repository 的 **Settings → Secrets and variables → Actions**。

在 **Secrets → New repository secret** 新增：

| 名稱 | 值 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 的 Account ID |
| `CLOUDFLARE_API_TOKEN` | 剛建立的 API Token |
| `RATE_LIMIT_SECRET` | 自己產生的 64 字元隨機值 |
| `ADMIN_PASSWORD` | 你要使用的管理員密碼（至少 8 字元）；只填 Secret，不寫進程式碼 |

產生 `RATE_LIMIT_SECRET`：在電腦終端機執行以下命令，將結果直接填入 GitHub Secret，不用貼回聊天。

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

接著在 **Variables → New repository variable** 新增：

| 名稱 | 值 |
| --- | --- |
| `CLOUDFLARE_DATABASE_ID` | 第 1 步的 Database ID |
| `CLOUDFLARE_API_URL` | 第 2 步的完整 Worker origin，不能有尾端 `/` |

這兩個 variable 是部署用的資源識別／公開 API 網址，不是管理密鑰。`VITE_API_BASE_URL` 與 `VITE_BASE_PATH` 由 workflow 自動提供，不必額外設定；只有公開 URL 會進入前端。

`wrangler.json` 的全零 Database ID 是本機開發佔位值，不能拿來正式部署。workflow 會根據上述 variable 產生忽略追蹤的 `wrangler.deploy.json`，不會修改已提交的檔案。

## 5. 啟用 GitHub Pages，再推送專案

在 repository 的 **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。不要選「Deploy from a branch」直接發布原始碼，因為 React／TypeScript 必須先建置。

將目前工作目錄的專案檔案 commit／push 到 `main`（或 `master`）。請用 IDE 的版本控制介面確認提交範圍，只提交程式碼；`.env`、`.dev.vars`、資料庫、node_modules 與本機產物已在 `.gitignore` 排除。

在 **Actions → Deploy GitHub Pages and Cloudflare** 查看結果；若你先推送才設定 Secrets，初次失敗是正常的，設定完成後使用 **Run workflow** 或重新執行該工作流程。

流程會：

1. 安裝鎖定版本的依賴，檢查前後端型別與兩組核心測試。
2. 將 migration 套用到遠端 D1，僅建立／更新 schema，不新增示範資料。
3. 部署 `tabletennis-team-api`，將限流秘密經 stdin 設為 Worker Secret。
4. 檢查真正 API 的 `/api/health`；不把名單內容輸出到 Actions log。
5. 以正確的 repository 子路徑與 API URL 建置前端，再發布 GitHub Pages。

Token／Secret 不會放入命令參數、前端或產物。第一次 Worker 部署到 Secret 設定完成之間，API 會短暫回傳「尚未完成設定」，不會以無保護狀態接受資料。workflow 不使用 GitHub Actions 定時任務刪除資料；每日清除由 Cloudflare Cron 在無訪客時執行。

### 已上線專案新增管理員功能

在原本的 repository Secrets 額外新增 `ADMIN_PASSWORD`，填入自己指定的管理員密碼；不用更改原本 3 個 Secrets 與 2 個 Variables。帳號預設是 `jingyuan`，位於伺服器設定 `ADMIN_USERNAME`，不需額外新增 GitHub variable。

然後將新版程式推送到 `main`，workflow 會自動套用 `002_admin_sessions.sql` 並設定 Worker Secret。沒有提供密碼時，公開登記／讀取仍可使用，但管理員登入會回覆尚未設定；程式沒有內建預設密碼。若先前直接在 Cloudflare 設過同名 Secret，空白的 GitHub Secret 不會將它刪除；建議統一以 GitHub Secret 管理。

使用方法：到網站最底下點「管理員登入」，輸入帳號／密碼。成功後今日所有登記會出現「修改／刪除」，修改沿用原表單，刪除須再次確認，其他裝置依原本每 10 秒機制同步。管理員不會取得或改變原填寫者的個人管理憑證。

登入憑證由伺服器安全隨機產生，僅保存於目前分頁的 sessionStorage，最長 2 小時；重新整理會向後端驗證登入狀態。資料庫只保存登入憑證雜湊、憑證設定的 HMAC 指紋及到期時間，不保存管理員密碼，不新增登記歷史。登出會在伺服器撤銷該憑證；修改帳號、密碼或限流 Secret 後，舊憑證也無法通過驗證。過期 session 由現有清除排程刪除，無需另外建立排程。

後端每次管理操作都檢查 session、有效期限與台灣今天日期。一般隊員的管理憑證不能呼叫管理員 API；未登入者即使知道紀錄 ID 仍無權修改他人。登入額外限制為每來源 IP 每 15 分鐘 5 次、全域每 15 分鐘 60 次，包含正確及錯誤嘗試；達到限制不影響公開讀取與一般登記的原本額度。

需要更換密碼時，更新 GitHub 的 `ADMIN_PASSWORD` Secret，重新執行 deployment workflow。不要把密碼放進 Variables、`VITE_*`、`wrangler.json` 或 GitHub 檔案。Cloudflare 的 Workers Secrets 是伺服器端加密環境設定；應用程式不記錄登入帳密、session token 或原始驗證錯誤。

兩個 workflows 分工：`Test` 對 PR／push 執行測試，不需要你的帳號憑證；`Deploy GitHub Pages and Cloudflare` 只對正式分支 push 或手動執行，串接真正部署。請勿把 deployment Secrets 提供給不信任的 PR。

## 6. 上線後檢查

- 開啟預期網頁網址，應顯示當天台灣日期，不是 Hello World 或空白頁。
- 用兩個裝置填寫／讀取；另一裝置應在約 10 秒內同步，且看不到他人的管理按鈕。
- 確認原裝置能修改、撤回，且另一裝置名單也會更新。測試資料用完立即撤回。
- 在 Cloudflare Worker 的 **Settings → Triggers／Cron Triggers** 確認兩個排程存在：`0 16 * * *` 與 `5,20,35,50 * * * *`。
- Cron 使用 UTC，`16:00 UTC` 就是台灣隔天 `00:00`；另一排程每 15 分鐘補刪（各小時第 5／20／35／50 分）。若午夜排程失敗，後續排程會補刪所有較早資料；讀取 API 一直只回傳台灣今天。
- Cron 新增／更新可能最多約 15 分鐘才傳播完成。部署後請觀察排程執行事件與主要 DB 的過期筆數；本機測試通過不代表你的帳號已在指定午夜執行。
- 在 D1 console 只查數量即可，不需要將隊員資料輸出到日誌：

```sql
SELECT count(*) AS expired
FROM entries
WHERE day < date('now', '+8 hours');
```

如果要驗證清除實際執行，請另建 staging D1／Worker 測試，避免在正式資料庫放過期測試姓名與原因。所有 schema／排程均在版本控制中；不要在 Dashboard 修改後忘記同步，下一次部署會依 `wrangler.json` 覆寫設定。

## 費用與免費額度

查核日期：2026-10-15。依官方定價，Workers Free 為每天 100,000 次請求；D1 Free 每天 500 萬 rows read、10 萬 rows written，帳號總儲存 5GB。索引維護也計算寫入；本專案每次輪詢會更新一個限流桶，因此不能只以「登記次數」估計用量。免費方案超出額度可能暫時無法讀寫。小型球隊通常可落在免費額度內，但不保證所有流量／濫用情境都免費；請維持 Free 方案並觀察用量，不需為本專案主動升級付費。

官方：[Workers 定價](https://developers.cloudflare.com/workers/platform/pricing/)、[D1 定價](https://developers.cloudflare.com/d1/platform/pricing/)。GitHub Pages／Actions 是否可用與額度也取決於 repository 可見性及 GitHub 方案。

## 資料刪除、備份與日誌：必讀

**D1 有自動 Time Travel，不需要手動啟用。** 官方目前列出免費方案可還原最近 7 天，付費方案 30 天。本專案沒有提供關閉 Time Travel 的設定，也不把每日 DELETE 宣稱成平台備份即時刪除。若隊伍要求「所有副本當天完全消失」，D1 這個方案不應被當作符合該要求；需要另選能滿足保留政策的平台。

`wrangler.json` 明確關閉 `observability.enabled`，程式不記錄姓名、原因、管理憑證或原始 DB 錯誤，沒有分析服務；排程失敗只拋出固定 `CLEANUP_FAILED` 以讓平台標記失敗。不要開啟請求 body／Authorization 的偵錯追蹤、第三方 APM payload capture、SQL 參數日誌、Tail Worker 或 Logpush 收集敏感資料。Cloudflare 底層安全／請求中繼資料、GitHub Pages 存取紀錄及供應商內部副本的保留，不由這份程式完全控制，需查帳號與供應商政策。若之前啟用過額外日誌／匯出／備份，也需處理既有資料。

官方：[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)、[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)、[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。

## 故障排除

| 狀況 | 檢查 |
| --- | --- |
| Actions 顯示缺少設定 | Secrets／Variables 名稱需完全一致，且設在 repository Actions，不能放到 Codespaces 或其他 environment |
| Cloudflare Authentication error／403 | Token 是否過期、帳號範圍、Workers Scripts 寫入與 D1 編輯權限，Account ID 是否正確 |
| Worker 已存在但仍 Hello World | deployment workflow 的 API 步驟是否成功，Worker 名稱是否剛好是 `tabletennis-team-api` |
| API 回傳 503 設定未完成 | Worker Secret 是否有 `RATE_LIMIT_SECRET`（至少 32 字元），不要只設 GitHub variable |
| 網頁空白／assets 404 | 必須用 Actions 建置發布，不能直接發布 src；檢查網頁的 repository 子路徑是否正確 |
| 網頁連線失敗但 API 可開 | `CLOUDFLARE_API_URL` 是否正確；網頁必須使用 `jingyuan0712.github.io` origin，不能用其他網域／HTTP |
| 換成自訂網域 | 一併修改 Worker 的允許來源產生規則與 Pages 網址／base path，不能只改其中一邊 |
| 清除沒執行 | Cron 是否已傳播、執行事件是否失敗、D1 免費額度是否耗盡；後續排程會補刪，API 不回傳舊資料 |

本機仍可沿用 README 的 Node 開發模式，不需 Cloudflare 帳號。若要直接測試 Worker：

```powershell
Copy-Item .dev.vars.example .dev.vars
npm.cmd run db:cloudflare:local
npm.cmd run dev:cloudflare
```

本機 Wrangler 使用獨立 `.wrangler` 資料，不會寫正式 D1。預設 CORS 允許正式 Pages origin；本機前端若要連這個 Worker，請另建忽略追蹤的本機 config，把 `ALLOWED_ORIGIN` 設為本機前端 origin，並設定其公開 API base。不要為了開發而把正式 CORS 改成 `*`。自動化的 `test:pages:e2e` 會建立隔離設定來測這個完整流程。
