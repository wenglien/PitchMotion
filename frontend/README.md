# SpeedGun Frontend（React + Vite）

這個目錄是 SpeedGun 的 Web 前端，提供「上傳影片 → 分析 → 結果與歷史紀錄 → 設定」的一頁式介面。

前端主要只做三件事：

- **與後端 API 溝通**：所有請求都經由 `src/api.js`。
- **管理使用者流程**：在 `src/pages/` 切分成上傳、結果、歷史、單日明細、設定等畫面。
- **顯示棒球資訊**：在 `src/components/` 實作如 `PitchCard`、`StrikeZone`、`TabBar` 等 UI。

---

## 目錄結構（前端）

```bash
frontend/
├── src/
│   ├── App.jsx             # App shell：切換分頁、共享設定
│   ├── api.js              # 後端 API 封裝（唯一對 FastAPI 的呼叫入口）
│   ├── pages/
│   │   ├── UploadPage.jsx        # 上傳影片、填寫距離/跨步/信心閾值，呼叫 /analyze
│   │   ├── ResultPage.jsx        # 顯示單次分析的 overlay 影片與速度資訊
│   │   ├── HistoryPage.jsx       # 顯示歷史列表（/history）
│   │   ├── SessionDetailPage.jsx # 顯示單一日期/場次的多筆投球細節
│   │   └── SettingsPage.jsx      # 編輯預設距離、跨步修正等設定
│   ├── components/
│   │   ├── PitchCard.jsx   # 單次投球卡片（速度、球種、指標）
│   │   ├── StrikeZone.jsx  # 好球帶視覺化
│   │   └── TabBar.jsx      # 底部分頁切換
│   ├── main.jsx
│   ├── App.css
│   └── index.css
├── vite.config.js          # Vite 設定（含 dev server proxy）
├── package.json
└── README.md
```

---

## API base URL 設定

前端所有 API 呼叫都透過 `src/api.js`，並由環境變數決定要打哪個後端：

- `VITE_API_BASE_URL`：在 `.env.local` 或部署環境中設定。  
  - 若 **未設定**，開發模式會走 `vite.config.js` 的 proxy（通常指向 `http://localhost:8080`）。  
  - 若有設定，例如 `VITE_API_BASE_URL=https://speedgun-backend-xxxx.a.run.app`，則會直接呼叫該 URL。

請確認：

- 本機開發時，後端 uvicorn 實際 Port 與 `VITE_API_BASE_URL` 或 Vite proxy 一致。
- 部署到 Cloud Run / 其他服務時，前端 build 用的 `VITE_API_BASE_URL` 指向正確的 HTTPS 網域。

---

## 與後端路由對應

`src/api.js` 對應的主要後端路由：

- `POST /analyze`  
  - 由 `analyzeVideo(file, { moundDistanceM, strideCorrectionM, confThreshold }, onProgress)` 發送  
  - 表單欄位名稱與後端 FastAPI 完全一致：`video`, `mound_distance_m`, `stride_correction_m`, `conf_threshold`
- `GET /history?limit=N`  
  - 由 `fetchHistory(limit)` 發送，回傳 `records` 陣列
- `GET /health`  
  - 由 `checkHealth()` 發送，作為簡單連線檢查

如果要新增 API，建議：

1. 先在後端 `backend/main.py` 或未來的 `backend/api/routes.py` 新增路由。
2. 在 `src/api.js` 新增對應函式，負責包裝 URL 與錯誤處理。
3. 讓 React component 只呼叫 `api.js`，不要在頁面裡直接硬編 URL。
