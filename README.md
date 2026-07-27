# SpeedGun — iOS 棒球投球分析

SpeedGun 是一款 **iOS 離線棒球投球分析 App**。影片會在裝置端透過 CoreML / Swift 管線完成球體偵測、姿勢輔助定位、球速計算、球種辨識、好球帶落點、位移量（Break）與分析品質評估。

> 專案目前只建置 iOS App，不再維護 Android、桌面版、Web frontend 或伺服器端分析流程。影片與分析結果不需要上傳伺服器。

---

## 目前重點功能

| 功能 | 狀態 | 說明 |
|------|------|------|
| 離線 iOS 分析 | 支援 | CoreML YOLO + Pose，全程 on-device |
| 球速計算 | 支援 | 透過軌跡、飛行時間、手動量測距離與透視修正計算 |
| 30/60fps 補幀 | 支援 | 低 FPS 影片會自動提高分析密度，目標接近 120fps |
| 軌跡補點 | 支援 | YOLO 中途漏偵時會補出連續軌跡，避免 overlay 斷線 |
| 角度容錯 | 支援 | 強化偏斜拍攝時的追蹤選球與 plate/catcher 估計 |
| MLB ABS 好球帶 | 支援 | 依打者身高計算，亦支援外部 2D / 3D 相機校正資料 |
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
│   ├── modules/expo-speedgun/      # 原生分析模組（Expo Module）
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
│   │       ├── PlatePositionEstimator.swift # 本壘板交會點估算
│   │       ├── StrikeZoneCalibration.swift  # 好球帶座標與世界座標換算
│   │       ├── ABSStrikeZoneRenderer.swift  # ABS 2D / 3D overlay
│   │       ├── TrajectoryMath.swift         # 加權軌跡擬合
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
├── pitch_classifier/               # Python 球種分類研究工具
├── src/                            # Python CV / overlay 工具
├── scripts/                        # 開發輔助腳本
└── yolov26n/                       # YOLO 訓練資料與研究資產（非 App runtime）
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
npm ci
cd ios && pod install && cd ..
open ios/SpeedGun.xcworkspace
```

在 Xcode 內選擇 `SpeedGun` scheme，設定 Signing 後即可 build 到模擬器或實機。日常開發也可以在 `mobile/` 執行 `npm run ios`。

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
3. 在設定中用捲尺量測並輸入「投手板前緣到本壘板後尖端」的投打距離（3–30m）。未完成手動校正時，App 不會輸出正式球速。
4. 輸入打者身高（公尺）。系統會依 MLB ABS 規則計算好球帶：
   - 寬度：43.18 cm
   - 高度：打者身高的 27% 到 53.5%
5. 開始分析。
6. 結果頁會顯示球速、球種、好球帶落點、軌跡、Break、overlay 影片與分析品質。

---

## ABS 好球帶校正

一般使用情境只需提供打者身高；App 會依 ABS 比例建立好球帶。若已有外部相機或場地校正資料，原生分析 API 也接受 `absCalibration` 物件或 `absCalibrationJson` 字串。

### 2D 校正

2D 座標可以使用 `0–1` 正規化座標，或直接使用來源影片的像素座標。此校正會同時影響落點分析與 overlay 顯示。

```ts
import { analyzeVideoOffline, type ABSCalibration } from './modules/expo-speedgun';

const absCalibration: ABSCalibration = {
  mode: '2d',
  zone: {
    left: 0.36,
    right: 0.64,
    top: 0.58,
    bottom: 0.84,
  },
  depth_offset: { x: 0.07, y: -0.11 },
};

const result = await analyzeVideoOffline(videoUri, {
  moundDistance: 18.44,
  batterHeightM: 1.8,
  absCalibration,
});
```

也可用 `top_left`、`top_right`、`bottom_right`、`bottom_left` 四個 `[x, y]` 點取代矩形邊界。

### 3D 校正

3D 模式使用相機內參、畸變係數與外參，把好球帶平面投影到 overlay。落點判定仍會使用分析流程解析出的 plate zone。

```ts
const absCalibration: ABSCalibration = {
  mode: '3d',
  zone: {
    center: [0, 0.9, 18.44],
    width: 0.4318,
    height: 0.477,
    depth: 0.01,
  },
  camera: {
    matrix: [
      [1580, 0, 960],
      [0, 1580, 540],
      [0, 0, 1],
    ],
    rvec: [0, 0, 0],
    tvec: [0, 0, 0],
    dist_coeffs: [0, 0, 0, 0],
  },
};
```

校正資料若包含非數值、`NaN`、無限值、退化矩形、非正數尺寸或錯誤矩陣大小，原生模組會回傳設定錯誤，不會帶著無效參數繼續分析。

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

### 4. 球速與距離校正

- 必須使用手動量測的投手板至本壘距離；不會從姿勢、自動 metadata 或 MLB 預設值推估。
- 可設定跨步補償，將量測的投手板距離換算成實際出手到本壘的有效飛行距離。
- 結果距離來源固定為 `manual`。
- 飛行時間使用原始影片 PTS 建立拍攝時間軸；插補影格只用於追蹤／overlay，不會作為正式時間或 TTC 證據。
- 出手點會先由姿勢提出候選，再由最早的真實球軌跡反推至手腕位置微調；接球端會綜合音訊與實際影格時間。

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

## 常用檢查

### TypeScript

```bash
cd mobile
npx tsc --noEmit
```

### Expo 設定

```bash
cd mobile
npx expo config --type public
```

輸出的 `platforms` 應只有 `ios`。

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

**Q：Build 顯示 `cannot execute tool 'metal' due to missing Metal Toolchain`？**

安裝與目前 Xcode 相符的 Metal Toolchain，再重新 build：

```bash
xcodebuild -downloadComponent MetalToolchain
```

---

## 技術

- React Native / Expo
- Swift Expo Module
- CoreML
- AVFoundation
- Metal
- react-native-svg
- YOLO / SORT

---

## 授權

本專案採用 MIT 授權，詳見 [LICENSE](LICENSE)。
