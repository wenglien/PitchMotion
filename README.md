# SpeedGun — iOS 棒球投球分析

SpeedGun 是以 **iOS 離線分析**為主的棒球投球分析 App。影片會在裝置端透過 CoreML / Swift 管線完成球體偵測、姿勢估距、球速計算、球種辨識、好球帶落點、位移量（Break）與分析品質評估。

> 目前不再維護桌面版或 Web frontend。`frontend/` 已移除；Python 後端保留作為開發、研究與模型驗證輔助。

---

## 目前重點功能

| 功能 | 狀態 | 說明 |
|------|------|------|
| 離線 iOS 分析 | 支援 | CoreML YOLO + Pose，全程 on-device |
| 球速計算 | 支援 | 透過軌跡、飛行時間、距離估算與透視修正計算 |
| 30/60fps 補幀 | 支援 | 低 FPS 影片會自動提高分析密度，目標接近 120fps |
| 軌跡補點 | 支援 | YOLO 中途漏偵時會補出連續軌跡，避免 overlay 斷線 |
| 角度容錯 | 支援 | 強化偏斜拍攝時的追蹤選球與 plate/catcher 估計 |
| MLB ABS 好球帶 | 支援 | 分析前必填打者身高，依 ABS 比例計算好球帶高度 |
| 好球帶落點 | 支援 | 2D 平面顯示，軌跡線保留 3D 視覺厚度與光影 |
| 位移量 Break | 支援 | 顯示水平位移、Induced Vertical Break、可信度與來源 |
| 分析品質 | 支援 | 結果頁顯示偵測覆蓋率、實測軌跡比例、落點與位移信心 |
| Overlay 影片 | 支援 | 原影片上疊加軌跡、球速與好球帶資訊 |
| 歷史紀錄 | 支援 | 本機保存分析紀錄與單次投球詳情 |

---

## 專案結構

```text
speedgun-mobile/
├── mobile/                         # 主要 App：Expo React Native iOS
│   ├── modules/expo-speedgun/      # 原生 Swift 分析模組（Expo Module）
│   │   ├── src/ExpoSpeedgun.ts     # JS/TS bridge
│   │   └── ios/
│   │       ├── ExpoSpeedgunModule.swift    # analyzeVideoOffline / getVideoMetadata
│   │       ├── SpeedgunPipeline.swift      # 主分析流程
│   │       ├── YOLODetector.swift          # CoreML YOLO 棒球偵測
│   │       ├── PoseEstimator.swift         # CoreML 姿勢估計
│   │       ├── SORTTracker.swift           # 物件追蹤
│   │       ├── FrameInterpolator.swift     # 影格插值 / 補幀
│   │       ├── BallSpeedCalculator.swift   # 球速計算
│   │       ├── BallKinematics.swift        # 位移量 / Break
│   │       ├── PitchClassifier.swift       # 球種辨識
│   │       ├── OverlayGenerator.swift      # Overlay 影片輸出
│   │       └── Types.swift                 # 共用型別與分析常數
│   ├── src/
│   │   ├── screens/
│   │   │   ├── AnalyzeScreen.tsx           # 選影片、打者身高、影片規格、開始分析
│   │   │   ├── ResultScreen.tsx            # 結果、分析品質、好球帶、位移圖
│   │   │   ├── HistoryScreen.tsx           # 歷史紀錄
│   │   │   ├── SessionDetailScreen.tsx     # 單次投球詳情
│   │   │   └── SettingsScreen.tsx          # 設定
│   │   ├── components/
│   │   │   ├── StrikeZone.tsx              # 好球帶落點與 3D 視覺軌跡線
│   │   │   ├── BreakChart.tsx              # MLB 風格 X/Y 位移圖
│   │   │   ├── PitchCard.tsx               # 單球資訊卡片
│   │   │   └── AnalysisProgress.tsx        # 分析進度
│   │   ├── hooks/
│   │   │   ├── useOfflineAnalysis.ts       # 呼叫原生分析模組
│   │   │   └── useLocalHistory.ts          # 本機歷史紀錄
│   │   └── types.ts                        # TypeScript 型別
│   └── ios/                                # Xcode workspace / CocoaPods
├── backend/                        # 可選 FastAPI 後端（開發 / 研究）
├── pitch_classifier/               # Python 球種分類研究工具
├── src/                            # Python CV / overlay 工具
├── train_tool/                     # YOLO 訓練與模型資料
├── scripts/                        # 開發輔助腳本
└── dev_start.sh                    # 啟動可選後端
```

---

## iOS App 開發

### 環境需求

- macOS 13+
- Xcode 15+
- Node.js 20+
- CocoaPods

### 安裝與啟動

```bash
cd mobile
npm install
cd ios && pod install && cd ..
open ios/SpeedGun.xcworkspace
```

在 Xcode 內選擇 `SpeedGun` scheme，設定 Signing 後即可 build 到模擬器或實機。

### 實機 Release Build

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

安裝到裝置：

```bash
xcrun devicectl device install app \
  --device 你的裝置UDID \
  "$(find ~/Library/Developer/Xcode/DerivedData -name 'SpeedGun.app' -path '*Release-iphoneos*' -print -quit)"
```

> Release build 會嵌入 JS bundle，手機離線也能分析，不需要 Metro server。

---

## 使用流程

1. 在分析頁選擇投球影片。
2. App 會讀取影片規格：FPS、解析度、原始幀數、分析 FPS 與補幀倍率。
3. 輸入打者身高（公尺）。系統會依 MLB ABS 規則計算好球帶：
   - 寬度：43.18 cm
   - 高度：打者身高的 27% 到 53.5%
4. 開始分析。
5. 結果頁會顯示球速、球種、好球帶落點、軌跡、Break、overlay 影片與分析品質。

---

## 分析管線

### 1. 影片讀取與補幀

- 讀取原始影片 FPS、解析度、duration 與 frame count。
- 30fps / 60fps 影片會自動做影格插值，提高偵測密度。
- 結果頁會顯示原始 FPS、分析 FPS、有效 capture FPS 與補幀倍率。

### 2. 球體偵測與追蹤

- 使用 CoreML YOLO 偵測棒球。
- 使用 SORT 追蹤球體軌跡。
- 追蹤關聯距離會依 frame 尺寸調整，改善偏斜拍攝時的掉追問題。
- 對低 FPS 影片避免過度縮小球體搜尋半徑。

### 3. 軌跡補點

當 YOLO 在中途漏偵時，管線會利用既有軌跡補出缺失段落：

- 保留真實偵測點與補出點數量。
- overlay 與結果頁會使用連續軌跡，減少「中途斷掉」的視覺問題。
- 分析品質會把「實測軌跡比例」納入評分，避免補點過多時看起來過度自信。

### 4. 球速與距離估算

- 可使用手動投手丘距離。
- 未設定距離時，會從姿勢估計與相機 metadata 推估。
- 結果會標示距離來源：`manual`、`pose_estimated` 或 `default`。
- 飛行時間會綜合 release frame、catch/plate frame 與軌跡估計。

### 5. 好球帶與落點

- 分析前需輸入打者身高。
- 好球帶以 MLB ABS 規則推算實際寬高。
- plate/catcher 估計會把好球帶定位到本次影片的 plate plane。
- 結果會回傳：
  - `plate_x_norm`
  - `plate_y_norm`
  - `pitch_loc_x`
  - `pitch_loc_y`
  - `is_strike`
  - `catch_point_confidence`
  - `plate_fit_error_px`
  - `plate_zone`

### 6. 位移量 Break

位移量會以好球帶寬度與高度做像素到公分校正，並輸出：

- `horizontal_break_cm`
- `vertical_break_cm`
- `induced_vertical_break_cm`
- `total_break_cm`
- `break_angle_deg`
- `break_confidence`
- `break_actual_sample_ratio`
- `break_endpoint_source`

Break Chart 採用 MLB 風格 X/Y 顯示：

- X 軸：水平位移，正值往右。
- Y 軸：Induced Vertical Break，正值代表扣除重力後的上抬效果。

### 7. 球種辨識

`PitchClassifier` 會根據速度、位移、軌跡形狀與 late break 特徵進行規則分類，目前支援：

- Fastball
- Curveball
- Slider
- Changeup

結果會包含 `pitch_type` 與 `pitch_confidence`。

---

## UI / UX 更新

### 分析頁

- 新增影片規格卡片。
- 開始分析前必填打者身高。
- 顯示 ABS 好球帶寬度、高度與比例。
- 顯示原始 FPS、分析 FPS、補幀倍率、解析度與幀數。

### 結果頁

- 新增分析品質分數。
- 顯示偵測覆蓋率、實測軌跡比例、落點信心、位移信心。
- 分析詳情包含補幀設定、落點來源、plate error、距離來源。
- 好球帶動畫改為 2D 平面，軌跡線保留 3D 厚度、陰影與高光。

---

## 可選 Python 後端

Python 後端目前主要用於開發、研究、模型驗證與舊流程測試；一般 iOS 離線分析不需要啟動後端。

### 安裝

```bash
./scripts/bootstrap_dev.sh
```

### 啟動

```bash
./dev_start.sh
```

預設設定在 `.env.example`：

```bash
BACKEND_PORT=8000
YOLO_WEIGHTS=train_tool/runs/detect/baseball_yolo26n_v5/weights/best.pt
```

啟動後：

- API：http://localhost:8000
- Docs：http://localhost:8000/docs

---

## 常用檢查

### TypeScript

```bash
cd mobile
npx tsc --noEmit
```

### iOS Build

```bash
xcodebuild \
  -workspace mobile/ios/SpeedGun.xcworkspace \
  -scheme SpeedGun \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  build
```

### Shell Script 語法

```bash
bash -n dev_start.sh
bash -n scripts/bootstrap_dev.sh
```

---

## 常見問題

**Q：為什麼 30/60fps 影片比較容易不準？**

低 FPS 代表球在相鄰幀之間位移更大，偵測器看到的樣本更少，因此 release/catch frame、軌跡連續性與球速都會更敏感。App 會自動補幀到接近 120fps 的分析密度，但原始影像若模糊或球太小，仍會影響結果。

**Q：拍攝角度偏一點就會不準嗎？**

角度會影響球體大小、plate plane、catcher 位置與姿勢估距。管線已加入更寬容的追蹤與 plate/catcher 推估，但建議仍讓鏡頭靠近本壘後方、固定不晃動，並讓投手到捕手路徑清楚可見。

**Q：分析品質分數低代表什麼？**

通常代表偵測覆蓋不足、補點比例偏高、落點信心低、位移樣本不足或距離來源較不可靠。結果頁會列出主要原因與重拍建議。

**Q：iOS App 顯示 `No script URL provided`？**

請使用 Release 設定 build，Release build 才會嵌入 JS bundle。

**Q：Signing 出現 bundle identifier 無法註冊？**

在 Xcode 的 Signing & Capabilities 修改 bundle identifier，例如改成你 Apple Developer Team 底下唯一的 `com.yourname.speedgun`。

---

## 技術

- React Native / Expo
- Swift Expo Module
- CoreML
- AVFoundation
- Metal
- react-native-svg
- FastAPI / Python（可選開發工具）
- YOLO / SORT

---

## 授權

本專案採用 MIT 授權，詳見 [LICENSE](LICENSE)。
