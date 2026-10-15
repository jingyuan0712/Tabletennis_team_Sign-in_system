# 桌球隊請假／遲到登記

繁體中文、手機優先的免登入系統。只有今天請假或遲到才登記，**未填寫不代表缺席**。所有瀏覽器透過同一個 HTTP API 讀寫 SQLite，沒有示範資料、歷史表、會員或分析追蹤。

**目前主要上線方式已改為 GitHub Pages＋Cloudflare Workers／D1，操作步驟見 [CLOUD_DEPLOY.md](./CLOUD_DEPLOY.md)。不需要個人電腦或 VPS 常駐，也不需要購買網域。** 本文件下方的 Node／SQLite／Docker 是保留的本機開發與自架替代方案，其常駐主機要求不適用於雲端方案。前端與表單行為共用，Cloudflare 後端另由 `cloudflare/worker.ts` 實作。

## 架構與執行條件

- React 19、TypeScript、Vite 前端；Node.js **24.x** 原生 HTTP API 與內建 `node:sqlite`，不需安裝原生資料庫套件。Node 24 的 SQLite API 仍屬演進中的 API，請在升級 major 版本前執行測試。
- 一個常駐 API 程序、一個獨立常駐 Croner 排程程序，共用本機 SQLite 持久化磁碟。Docker Compose 另附 Caddy 自動 HTTPS。單台小型主機即可運作，沒有第三方資料庫金鑰。
- 適合小型球隊，**只部署一台主機／一個 app instance**。SQLite 不是跨主機資料庫；不要把檔案放在 NFS，也不要水平擴展 app。
- 正式環境必須是常駐主機，不能使用會休眠、縮到零、或磁碟會隨部署消失的平台。帳號、網域與主機需自行提供；本專案不會自動購買或部署到外部帳號。
- SQLite 直接檔案存取沒有 PostgreSQL 式的匿名角色／RLS。權限邊界是非 root 容器使用者、0700 資料目錄、0600 檔案，以及後端的逐筆憑證驗證。資料庫沒有對外網路埠或可供匿名使用的 SQL API。

## 本機啟動

安裝 Node.js 24.x。PowerShell 若不允許 `npm.ps1`，請使用下列 `npm.cmd` 指令；其他作業系統用 `npm`。

```powershell
npm.cmd ci
Copy-Item .env.example .env
npm.cmd run db:migrate
npm.cmd run dev
```

開啟 **http://localhost:5173**。開發命令同時啟動 Vite、3001 埠 API 與排程。`.env` 中的 `PUBLIC_ORIGIN` 必須與瀏覽器網址完全一致，包含通訊協定、主機及埠；`localhost` 和 `127.0.0.1` 不同。預設只監聽本機。

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run start
```

單獨用建置後的 app（3001 埠）時，先將 `.env` 的 `PUBLIC_ORIGIN` 改為 `http://localhost:3001`；另一個終端機執行 `npm.cmd run scheduler`。`start` 只啟動網頁服務，**正式環境不能省略 scheduler**。

Schema 由 `migrations/001_initial.sql` 建立；`db:migrate`、API 啟動、scheduler 啟動都會套用尚未執行的 migration，交易確保重跑安全。已套用的 migration 請勿修改，後續改動新增檔案。沒有 seed 指令，也不會新增正式測試隊員。

## 環境變數

| 變數 | 用途 |
| --- | --- |
| `NODE_ENV` | 正式為 `production`，會強制 HTTPS origin 與至少 32 字元的限流祕密 |
| `PUBLIC_ORIGIN` | 外部實際 origin，例如 `https://team.example.com`，不可有尾端 `/` 或路徑 |
| `RATE_LIMIT_SECRET` | 至少 32 字元隨機值，只在伺服器 HMAC 限流識別使用；開發空白時每次啟動隨機產生 |
| `DATABASE_PATH` | 本機預設 `./data/team.sqlite`；容器固定 `/data/team.sqlite` |
| `HOST` / `PORT` | 本機預設 `127.0.0.1:3001`；容器內為 `0.0.0.0:3001` |
| `TRUST_PROXY` | 只有在反向代理會覆寫 `X-Real-IP` 且無法繞過代理存取 app 時才設 `true` |
| `DOMAIN` | Compose/Caddy 的實際網域，例如 `team.example.com` |

產生祕密：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

把結果填入 `.env`。不要把它放入 `VITE_*` 變數或提交到 Git。Compose 明確挑選環境變數傳入容器，映像建置會排除 `.env`、資料庫與測試產物。應限制 `.env` 的主機檔案權限；本機開發檔案權限也依作業系統的 ACL 而定。

## 正式部署：Docker Compose＋HTTPS

需要：有 Docker Engine 與 Compose 的常駐 Linux VPS、一個網域、DNS A/AAAA 指向主機、開放 TCP 80/443（UDP 443 可選）。同步主機系統時鐘，建議啟用 NTP。部署命令在專案根目錄執行。

1. 將原始碼放上主機，複製 `.env.example` 為 `.env`。
2. 在 `.env` 填入 `DOMAIN=你的網域`、`PUBLIC_ORIGIN=https://你的網域`、隨機 `RATE_LIMIT_SECRET`。Compose 會覆寫資料庫路徑、HOST、NODE_ENV 和 TRUST_PROXY，不依賴開發值。
3. 執行以下命令：

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

4. 確認 `app` 與 `scheduler` 是 healthy；Caddy 會申請 TLS 憑證。用手機行動網路開啟網址，再以另一個瀏覽器確認共用名單。網站是公開的，**不要替它加登入閘道**，否則不符合免登入使用情境。
5. 設定主機開機啟動 Docker，並監控 app/scheduler 的容器健康狀態。`restart: unless-stopped` 會重啟退出的程序，但 **Docker 本身不會因為 unhealthy 自動重啟容器**；請在主機監控系統對 unhealthy／無心跳告警並處理。整台主機停機期間無法執行排程。

資料在命名 volume `team-data`，容器重建或一般 `docker compose down` 不會刪除。**不要執行 `docker compose down -v`，那會移除資料與 TLS volumes**。更新時拉取程式碼後重跑 `docker compose up -d --build`。資料庫檔案與 WAL 必須位於同一個可寫本機 volume；勿單獨搬運開啟中的 `.sqlite` 檔。

程式以 UID/GID 10001 非 root 執行。Docker volume 第一次建立時會承接映像中 `/data` 的擁有者；若改用 bind mount，需先將資料目錄權限設為該使用者可讀寫，其他使用者不可讀取。只有 proxy 對外暴露埠；不要另行公開 app 的 3001 埠。若改用 CDN／另一層 proxy，須重新設定可信 IP 邊界，不能直接信任客戶端帶來的 IP 標頭。

## 每日刪除與台灣日期

所有日期由伺服器接到請求時的時間換算成 `Asia/Taipei`，忽略客戶端傳來的日期；表單中的 ETA 也是台灣時間。讀取使用 `WHERE day = 伺服器今天`，即使排程失敗，過期資料也不會回傳。

`server/scheduler.ts` 在**台灣時間 00:00**執行 `DELETE FROM entries WHERE day < 今天`，並每五分鐘補執行。啟動時也立刻補刪，停機數日後會一次刪掉所有更早的資料。這是伺服器常駐程序的排程，沒有訪客也會運作。排程沒有公開 HTTP 清除端點，也沒有歷史表。SQLite `secure_delete=ON` 與清除後的 WAL checkpoint 減少主要檔案的殘留頁面，但不保證所有磁碟／平台副本即時消失。

每次清除成功更新不含姓名原因的心跳檔；失敗只記錄 `CLEANUP_FAILED` 並退出，由 Compose 重啟後重試。系統排程與 OS 可能有短暫執行延遲，這不是硬即時保證；讀取的今日過濾始終獨立生效。

前端每 10 秒取得同一份名單；使用伺服器時間與瀏覽器單調時鐘計算午夜，不採用裝置日期。持續開啟的頁面到午夜會先清除昨日名單，再嘗試同步，即使暫時斷線也不會繼續展示昨日登記。重新聚焦／回到頁面／網路恢復也會更新。未送出的表單保留，舊的修改模式與憑證會到期。

手動補刪（不會刪除今天）：

```sh
docker compose exec app node dist-server/server/cleanup-cli.js
```

### 部署後確認排程真的執行

```sh
docker compose logs --tail 20 scheduler
docker compose exec app node -e "const fs=require('node:fs'); console.log(new Date(Number(fs.readFileSync('/data/team.sqlite.scheduler-heartbeat','utf8'))).toISOString())"
```

確認午夜前後心跳與主要資料庫舊紀錄數量。不要將正式姓名／原因匯出到終端機；可只查筆數：

```sh
docker compose exec app node --input-type=module -e "import {openDatabase} from './dist-server/server/db.js'; import {taipeiDay} from './dist-server/shared/model.js'; const db=openDatabase('/data/team.sqlite'); console.log(db.prepare('SELECT count(*) AS expired FROM entries WHERE day < ?').get(taipeiDay(new Date()))); db.close()"
```

請在獨立 staging volume 測試過期資料，不在正式環境留下測試姓名與原因。測試環境先建一筆舊日期資料，在沒有開啟網頁時等待排程執行，確認資料庫筆數減少且重跑不影響今天資料。要驗證指定 00:00 的平台執行情況，仍需部署後跨午夜觀察。

## 安全與個資範圍

- 姓名 20 字、原因 200 字，Unicode 字元計數、去除頭尾空白、前後端驗證；DB 再限制欄位、狀態與 ETA。SQL 皆使用綁定參數。React 以純文字渲染原因，不當成 HTML。
- 瀏覽器以 Web Crypto 產生 256-bit 隨機管理憑證、UUID；在送出前保存憑證於本機 localStorage，避免伺服器已成功而回應丟失時失去管理能力。只保存自己的 ID、憑證、日期，**不保存全隊名單或原因**。同一天可管理本機送出的多筆登記。共用瀏覽器／相同瀏覽器設定檔視為同一個裝置。
- 憑證只透過 HTTPS `Authorization: Bearer` 傳送，伺服器只保存 SHA-256 雜湊，固定時間比較；公開 API 的明確欄位清單排除雜湊與憑證。知道姓名或 ID 不足以修改／撤回。遺失瀏覽器資料、換裝置或無痕視窗關閉後無法恢復管理，不提供免登入找回機制。
- 同一 id＋憑證重試 POST 會回傳原登記，不重複新增；同名檢查與寫入同一交易，沒有覆寫別人資料的路徑。同名確認只用於新增自己的獨立登記或修改已有權限的登記，不會授予他人紀錄權限。
- 所有 API 回應 `Cache-Control: no-store`。寫入須為同源 Origin，POST/PUT 須為 JSON；無跨域 CORS。瀏覽器憑證不放 URL 或公開 API。CSP、禁止 iframe、Referrer-Policy 與正式環境 HSTS 降低外洩風險。
- 持久化 SQLite 限流：每 IP 每 10 分鐘共 30 次寫入（包含失敗嘗試），讀取每分鐘 600 次，配合 4KiB body、10 秒請求上限。只存含日期的 IP HMAC，不存原 IP；過期限流桶由排程清除。共用球館 Wi-Fi 可能共用額度，可依隊伍規模調整 `server/app.ts`。基本限流無法阻止分散式攻擊，公開網址仍可能被亂填；需要時在反向代理加流量限制，不能靠姓名當作身份驗證。
- app 不記錄請求、姓名、原因、憑證、原始錯誤或識別碼；scheduler 只記錄成功／失敗代碼。沒有 analytics、Sentry、第三方字型或圖片服務，Caddy 沒開 access log。不要開啟 body/header debug logging、APM payload capture、SQL statement/parameter tracing、`docker compose config` 的完整輸出或將 `.env` 放進 CI artifact；`config --quiet` 只驗證設定。

### 刪除並不代表平台所有副本立即消失

本方案沒有啟用自動 DB 備份或匯出。但 VPS 供應商可能預設備份整台主機、磁碟、Docker volume、快照；主機管理員也可能有檔案系統快照、備份代理、日誌收集或災難復原複本。部署前應逐項檢查並停用 `team-data` 的備份／快照、調整供應商保留期與刪除既有備份；供應商是否允許排除或立即刪除，須依實際方案確認。SQLite 刪除不控制硬碟／SSD、雲端底層複本的實體抹除時間。

Docker 的 app 日誌已輪替且不含提交內容，但 Caddy、CDN、WAF、負載平衡器、主機平台可能各自保留來源 IP、URL、時間、標頭甚至偵錯 payload。關閉不必要 access logs／追蹤、遮蔽 Authorization、禁止收集 body、採用最短可行保留期，依供應商文件確認；不要假設專案關閉 access log 就能關閉上游日誌。本機開發瀏覽器、使用者截圖／複製、瀏覽器備份與使用者電腦也不在伺服器刪除控制範圍。

如果部署環境強制保留無法關閉的備份，需誠實告知隊員此保留範圍，或選擇能符合隊伍要求的平台。本專案承諾主要資料庫刪除，不宣稱所有平台副本立即完全消失。

## 必要測試

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npx.cmd playwright install chromium
npm.cmd run test:e2e
# Optional, requires Docker; uses only isolated test volumes, removes them afterward:
npm.cmd run test:container
```

`tests/core.test.ts` 用真實 HTTP＋SQLite 驗證輸入、請假／遲到、同名競爭、重試冪等、公開欄位、權限、修改撤回、限流、午夜／多日補刪、實體刪除重跑，以及不同連線／重啟持久化。時鐘由測試注入，正式 API 沒有可調整時間的後門。

`tests/browser/app.spec.ts` 用兩個獨立瀏覽器 context、不同裝置時區操作真正 API，驗證每 10 秒同步、自己的操作權限、錯誤重試、缺少原因、同名確認、修改與撤回；另檢查 320/375/390/768/1280px 長內容與午夜斷線切日。最後一項用測試 route 模擬伺服器午夜時間，其他流程不以假資料替代 API。瀏覽器測試資料使用 `.test-data/browser-*` 的獨立資料庫，不會碰正式／開發 DB；測試產物不提交。不要把真實資料用於測試。

已執行的測試結果與環境限制見 [VERIFICATION.md](./VERIFICATION.md)。正式 DNS、TLS、volume、排程存活、備份／日誌設定及跨裝置實際網路仍須依該部署環境驗證，不能以本機通過代表已部署成功。

## 主要檔案

| 檔案 | 用途 |
| --- | --- |
| `shared/model.ts` | 共用驗證與台灣日期 |
| `server/app.ts` | 公開 API、逐筆授權與限流 |
| `server/cleanup.ts` / `server/scheduler.ts` | 實體刪除及台灣午夜排程 |
| `migrations/001_initial.sql` | schema／索引／資料約束 |
| `src/App.tsx` | 單頁 UI、同步、跨日與修改撤回 |
| `compose.yaml` / `deploy/Caddyfile` | 常駐部署、持久化磁碟、HTTPS |

技術參考：[Node SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)、[Croner timezone 設定](https://croner.56k.guru/usage/configuration/)、[Docker Compose 啟動與健康檢查](https://docs.docker.com/compose/how-tos/startup-order/)。
