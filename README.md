# SpeedGun

SpeedGun 是一款全程在 iPhone 裝置端執行的棒球投球分析 App。它使用 Swift、Core ML、AVFoundation 與 Metal 分析影片，再由 Expo React Native 呈現球速、球種、落點、位移與進壘軌跡；影片不需上傳伺服器。

## 核心功能

- **投球分析**：YOLO 棒球偵測、Pose 出手點判斷、SORT 追蹤、漏偵補點與軌跡平滑。
- **球速與球種**：依原始影片時間戳、出手／接球時點、投打距離與 TTC 檢核計算球速，並辨識主要球種。
- **落點與位移**：提供 MLB ABS 好球帶、好壞球判定、水平／垂直位移、IVB 與 Break Chart。
- **互動進壘回放**：以 MLB ABS 風格呈現球路；支援播放、暫停、慢速、時間軸、自由旋轉、縮放與上一球比較。
- **分析結果**：顯示偵測覆蓋率、實測／補點比例、分析品質及疊加軌跡影片。
- **本機資料**：保存投球紀錄與設定，不需要帳號、後端服務或網路連線。

## 架構

| 層級 | 位置 | 責任 |
|---|---|---|
| App UI | `mobile/src/screens`、`mobile/src/components` | 分析操作、結果、互動回放與歷史紀錄 |
| App 狀態 | `mobile/src/hooks`、`mobile/src/context` | 分析工作、播放、相機操作、設定與本機資料 |
| 資料轉接 | `mobile/src/adapters/nativeAnalysis.ts` | 將原生結果正規化為 `PitchResult` |
| Native Bridge | `mobile/modules/expo-speedgun/src` | React Native 與 iOS 分析核心的型別化介面 |
| iOS 分析核心 | `mobile/modules/expo-speedgun/ios` | 影片解碼、模型推論、追蹤、球速、球種、落點與 overlay |
| 模型與研究 | `research` | YOLO、球種分類與電腦視覺研究工具；不進入 App 執行路徑 |

### 分析流程

```text
投球影片
  → 影片解碼與時間戳
  → 棒球偵測 + 姿勢估測
  → 追蹤、補點與軌跡擬合
  → 出手／接球時點與球速檢核
  → 落點、位移與球種
  → PitchResult
  → 結果頁、互動進壘回放與歷史紀錄
```

### 架構邊界

- Swift 是球速、落點、位移與球種的唯一計算來源。
- TypeScript 只負責資料轉接與顯示，不重新計算原生分析結果。
- 動畫補點與平滑只影響畫面，不會改變球速或原始分析數據。
- 2D 進壘動畫與互動 3D 回放共用 `PitchReplayModel`，確保同一球只有一份軌跡。
- 分析、影片與使用者資料皆保留在裝置端。

### 專案結構

```text
speedgun-mobile/
├── mobile/
│   ├── src/                         # React Native UI、狀態與資料轉接
│   └── modules/expo-speedgun/
│       ├── src/                     # TypeScript bridge
│       ├── ios/                     # Swift／Metal 分析核心
│       └── Resources/               # Core ML 與姿勢模型
├── research/
│   ├── vision/                      # Python 電腦視覺參考實作
│   ├── pitch_classifier/            # 球種分類研究
│   └── yolo/                        # YOLO 訓練腳本與模型
├── scripts/                         # 開發、診斷與資料處理工具
└── docs/                            # 技術文件
```
