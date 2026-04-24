# SpeedGun — 棒球投球分析

以深度學習分析棒球投球的開源專案，支援**離線 iOS App** 與 **Web 前後端**兩種使用模式，提供球速測量、球種辨識、落點標記、球路位移（Break）分析等功能。

---

## 功能總覽

| 功能 | iOS App（離線） | Web（後端） |
|------|:--------------:|:-----------:|
| 棒球偵測（YOLO） | CoreML on-device | PyTorch |
| 姿勢分析（Pose） | CoreML on-device | MediaPipe |
| 球速計算 | 
| 球種辨識 | 規則分類器 | 規則分類器 |
| 好球帶落點 | 動畫顯示 | 
| 球路位移（Break）圖 | MLB 風格 X/Y 圖 | 
| Overlay 影片輸出 | 
| 歷史紀錄 | 

---

## 專案結構

```
speedgun-mobile/
├── mobile/                         # [主要] Expo React Native iOS App
│   ├── modules/expo-speedgun/      # 原生 Swift 分析模組（Expo Module）
│   │   └── ios/
│   │       ├── SpeedgunPipeline.swift      # 主流程協調器
│   │       ├── YOLODetector.swift          # CoreML YOLO 棒球偵測
│   │       ├── PoseEstimator.swift         # CoreML 姿勢估計
│   │       ├── SORTTracker.swift           # 物件追蹤（SORT 演算法）
│   │       ├── BallSpeedCalculator.swift   # 球速計算（透視修正）
│   │       ├── ReleasePointDetector.swift  # 出球點偵測
│   │       ├── PitchClassifier.swift       # 球種辨識（規則分類器）
│   │       ├── BallKinematics.swift        # 球路位移（Break）分析
│   │       ├── OverlayGenerator.swift      # Overlay 影片產生
│   │       ├── FrameInterpolator.swift     # 影格插值（Metal）
│   │       └── Types.swift                 # 共用資料型別與常數
│   ├── src/
│   │   ├── screens/
│   │   │   ├── AnalyzeScreen.tsx           # 主分析頁
│   │   │   ├── ResultScreen.tsx            # 結果頁（球速、落點、位移圖）
│   │   │   ├── HistoryScreen.tsx           # 歷史紀錄
│   │   │   ├── SessionDetailScreen.tsx     # 單次投球詳情
│   │   │   └── SettingsScreen.tsx          # 設定（距離、閾值等）
│   │   ├── components/
│   │   │   ├── StrikeZone.tsx              # 好球帶落點動畫（軌跡 + 3D 效果）
│   │   │   ├── BreakChart.tsx              # 球路位移 MLB 風格 X/Y 散佈圖
│   │   │   ├── PitchCard.tsx               # 單球資訊卡片
│   │   │   ├── PitchTypeBadge.tsx          # 球種
│   │   │   └── AnalysisProgress.tsx        # 分析進度條
│   │   ├── context/
│   │   │   ├── ResultContext.tsx           # 本次投球 Session 狀態管理
│   │   │   └── SettingsContext.tsx         # 設定狀態管理
│   │   ├── hooks/
│   │   │   ├── useOfflineAnalysis.ts       # 呼叫原生分析模組的 Hook
│   │   │   └── useLocalHistory.ts          # 本機歷史紀錄 Hook
│   │   ├── utils/
│   │   │   ├── conversions.ts              # 單位換算、顏色對應等
│   │   │   ├── coaching.ts                 # 球種教練提示文字
│   │   │   └── pipelineStages.ts           # 分析階段進度對應
│   │   └── types.ts                        # 共用 TypeScript 型別定義
│   └── ios/                                # Xcode 專案（CocoaPods 管理）
├── backend/                        # FastAPI 後端（Web 模式）
│   ├── main.py                     # API 入口（/analyze, /overlays, /history）
│   └── requirements.txt
├── frontend/                       # React + Vite Web 前端
│   └── src/
│       └── pages/                  # UploadPage, ResultPage, HistoryPage …
├── pitch_classifier/               # Python 球種辨識模組（後端 / 研究）
│   ├── feature_extractor.py        # 從軌跡提取特徵（對應 Swift PitchClassifier）
│   └── rule_classifier.py          # 規則分類器（對應 Swift RuleBasedPitchClassifier）
├── src/                            # Python 電腦視覺核心（後端共用）
│   ├── pipelines/yolov8_pipeline.py
│   ├── get_pitch_frames_yolov8.py
│   ├── ball_speed_calculator.py
│   ├── generate_overlay.py
│   └── release_point_detector.py
├── yolov8/                         # YOLO 模型權重與訓練工具
└── scripts/                        # 開發輔助腳本
    ├── bootstrap_dev.sh            # 一鍵建立 venv + 安裝依賴
    └── doctor.py                   # 環境健檢
```

---

### 環境需求

- **macOS** 13+
- **Xcode** 15+
- **Node.js** 20+（建議透過 nvm 管理）
- **CocoaPods** (`gem install cocoapods`)

### 安裝與 Build

```bash
# 1. 進入 mobile 目錄
cd mobile

# 2. 安裝 JS 依賴
npm install

# 3. 安裝 CocoaPods 依賴
cd ios && pod install && cd ..

# 4. 用 Xcode 開啟（第一次設定 Signing 需要）
open ios/SpeedGun.xcworkspace
```

> **Signing**：在 Xcode 的 `Signing & Capabilities` 設定你的 Apple ID 或 Team，選 `Automatically manage signing`。

### 連線到 iOS 裝置（Wi-Fi）

先在 Xcode → Windows → Devices and Simulators 配對裝置，之後可用指令 build：

```bash
xcodebuild \
  -workspace ios/SpeedGun.xcworkspace \
  -scheme SpeedGun \
  -configuration Release \
  -destination "id=你的裝置UDID" \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM=你的TeamID \
  build
```

查詢裝置 UDID：

```bash
xcrun devicectl list devices
```

安裝到裝置：

```bash
xcrun devicectl device install app \
  --device 你的裝置UDID \
  "$(find ~/Library/Developer/Xcode/DerivedData -name 'SpeedGun.app' -path '*Release-iphoneos*' -print -quit)"
```

> **離線使用**：App 採用 Release 設定 Build，JS Bundle 已嵌入 App，不需要 Metro 伺服器，手機離線也能分析。

---

## Web 後端快速上手

### 環境需求

- **Python** 3.10 或 3.11
- **Node.js** 20+
- YOLO 權重檔（見下方）

### 安裝與啟動

```bash
# 1. 初始化（建立 venv + 安裝依賴 + 建立 .env）
./scripts/bootstrap_dev.sh

# 2. 安裝前端依賴
cd frontend && npm install && cd ..

# 3. 取得 YOLO 權重，放到：
#    yolov8/runs/detect/baseball_yolo26n_v4/weights/best.pt
#    或在 .env 設定：YOLO_WEIGHTS=/path/to/best.pt

# 4. 一鍵啟動後端 + 前端
./dev_start.sh
```
---

## 主要分析功能

### 球速計算

透過 YOLO 追蹤球的像素位移，結合投手丘距離與姿勢估計的相機距離，計算出手速度：

- **出手速度**（release speed）：距離估計 + 透視修正
- **最大速度 / 平均速度**：整段飛行計算
- **自動距離估算**：偵測投手雙肩寬度像素值，從焦距倒推相機距離（可在設定頁手動覆蓋）

### 球種辨識

1. **`PitchFeatureExtractor`**：從軌跡計算高階特徵
   - 軌跡平滑（移動平均）
   - 早期 / 晚期 break 方向與大小（`earlyBreakX/Y`、`lateBreakX/Y`、`lateBreakRatio`）
   - 軌跡線性度（R²）、360° 方向變化量
2. **`RuleBasedPitchClassifier`**：四種球種評分
   - 四縫線速球（Fastball）、曲球（Curveball）、滑球（Slider）、變速球（Changeup）
   - 以 Gaussian bump + Sigmoid rise，避免硬閾值邊界效應
   - Margin-based confidence

### 球路位移分析（Break Chart）

以 **MLB Baseball-Savant** X/Y 位移圖顯示：

- **X 軸（水平位移）**：+ = 往右、− = 往左（投手視角）
- **Y 軸（Induced Vertical Break）**：扣除重力後的 Magnus 垂直位移，+ = 上抬（fastball），− = 下沉（curveball）
- 以好球帶寬度（MLB 43.18 cm）做像素 → 公分校正
- 可信度以光暈大小表示（可信度越低光暈越大）

### 好球帶落點動畫

- 每球從固定「投手出手點」沿 3D 曲線飛向落點，以 cubic Bezier 模擬真實棒球軌跡
- 落點以球種顏色標記，落在好球帶內外顯示不同樣式
- 支援多球循環播放、impact ring 動畫

---

## 設定參數說明

| 參數 | iOS key | 後端 key | 預設值 | 說明 |
|------|---------|----------|--------|------|
| 投手丘距離 | `moundDistanceM` | `mound_distance_m` | 0（自動） | 0 = 從姿勢自動估算 |
| 跨步修正 | `strideCorrectionM` | `stride_correction_m` | 0 | 投手跨步縮短的飛行距離 |
| YOLO 信心閾值 | `confThreshold` | `conf_threshold` | 0.03 | 偵測最低信心分數 |
| 投手身高 | `pitcherHeightM` | — | 選填 | 協助改善自動距離估算精度 |

---

## 後端 API 

| 用途 | 方法 | 路徑 |
|------|------|------|
| 上傳並分析 | POST | `/analyze` |
| 取得 overlay | GET | `/overlays/<id>.mp4` |
| 歷史紀錄 | GET | `/history` |

環境變數：

- `YOLO_WEIGHTS`：YOLO 權重路徑（必備）
- `LOCAL_DATA_DIR`：overlay 與紀錄目錄（預設 `/tmp/speedgun_dev`）
- `API_BASE_URL`：回傳給前端的 base URL
- `BACKEND_PORT` / `FRONTEND_PORT`：服務 port（統一在 `.env` 管理）

---

## 常見問題

**Q：分析跑完但偵測不到球？**
- 確認 YOLO 權重路徑正確（`YOLO_WEIGHTS` 或 `yolov8/runs/detect/.../best.pt`）
- 嘗試降低信心閾值（設定頁調整，預設 0.03）
- 確認影片拍攝角度清楚、有足夠對比度

**Q：iOS App 顯示「No script URL provided」？**
- 必須使用 **Release** 設定 Build（非 Debug），Release build 才會嵌入 JS bundle。

**Q：`mediapipe` 找不到 `solutions`？**
```bash
pip uninstall -y mediapipe
pip install mediapipe==0.10.21
```

**Q：前端打不到後端？**
- 確認 `.env` 的 `BACKEND_PORT` 與後端實際 port 一致
- 可在 `frontend/.env.local` 設定：`VITE_API_BASE_URL=http://localhost:8080`

**Q：環境建置有問題？**
```bash
python scripts/doctor.py
```

---

## 技術

### iOS App
- **React Native / Expo** — JS 層
- **Swift** — 原生分析模組（Expo Module）
- **CoreML** — YOLO 棒球偵測 + 姿勢估計（離線）
- **Metal** — 影格插值加速
- **react-native-svg** — 好球帶動畫 / Break Chart
- **AVFoundation** — 影片讀取與 Overlay 輸出

### Python 後端
- **FastAPI + Uvicorn** — HTTP API
- **Ultralytics YOLO** — 棒球偵測
- **MediaPipe** — 姿勢估計
- **OpenCV** — 影像處理
- **SORT** — 物件追蹤

---

## 授權

本專案採用 **MIT** 授權，詳見 [LICENSE](LICENSE)。

- [Ultralytics](https://github.com/ultralytics/ultralytics) — YOLO
- [MediaPipe](https://mediapipe.dev/) — 姿勢估計
- [SORT](https://github.com/abewley/sort) — 物件追蹤
