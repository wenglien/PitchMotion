<p align="center">
  <img src="docs/assets/readme-header.svg" alt="SpeedGun — on-device pitch lab" width="920">
</p>

<p align="center">
  <strong>把每一球，變成看得懂的軌跡。</strong><br>
  <sub>iPhone 上的全裝置端棒球投球分析 App</sub>
</p>

<p align="center">
  <sub><a href="#核心功能">核心功能</a> · <a href="#架構">架構</a> · <a href="#分析流程">分析流程</a> · <a href="#架構邊界">架構邊界</a> · <a href="#專案結構">專案結構</a></sub>
</p>

<table>
  <tr>
    <td width="64%" valign="top">
      <sub>BUILT FOR THE MOUND</sub><br><br>
      <strong>從一段投球影片，讀懂速度、球路與進壘位置。</strong><br><br>
      SpeedGun 使用 Swift、Core ML、AVFoundation 與 Metal 分析影片，再由 Expo React Native 呈現每一球的完整結果。
    </td>
    <td width="36%" valign="top">
      <sub>PRIVACY BY DESIGN</sub><br><br>
      <strong>100% 裝置端分析</strong><br><br>
      影片不需上傳伺服器，也不需要帳號或網路連線。
    </td>
  </tr>
</table>

<a id="核心功能"></a>
<p align="center"><img src="docs/assets/readme-section-features.svg" alt="01 核心功能" width="920"></p>

<table>
  <tr>
    <td width="50%" valign="top">
      <sub>01 · DETECT</sub>
      <h3>投球分析</h3>
      YOLO 棒球偵測、Pose 出手點判斷、SORT 追蹤、漏偵補點與軌跡平滑。
    </td>
    <td width="50%" valign="top">
      <sub>02 · REPLAY</sub>
      <h3>互動進壘回放</h3>
      MLB ABS 風格球路，支援播放、暫停、慢速、時間軸、自由旋轉、縮放與上一球比較。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <sub>03 · MEASURE</sub>
      <h3>球速與球種</h3>
      依原始時間戳、出手／接球時點、投打距離與 TTC 檢核計算球速，並辨識主要球種。
    </td>
    <td width="50%" valign="top">
      <sub>04 · REVIEW</sub>
      <h3>分析結果</h3>
      顯示偵測覆蓋率、實測／補點比例、分析品質及疊加軌跡影片。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <sub>05 · LOCATE</sub>
      <h3>落點與位移</h3>
      提供 MLB ABS 好球帶、好壞球判定、水平／垂直位移、IVB 與 Break Chart。
    </td>
    <td width="50%" valign="top">
      <sub>06 · KEEP</sub>
      <h3>本機資料</h3>
      保存投球紀錄與設定，不需要帳號、後端服務或網路連線。
    </td>
  </tr>
</table>

<a id="架構"></a>
<p align="center"><img src="docs/assets/readme-section-architecture.svg" alt="02 架構" width="920"></p>

|  | 模組與責任 | 程式位置 |
|:---:|---|---|
| `01` | **介面層 · App UI**<br><sub>分析操作、結果、互動回放與歷史紀錄</sub> | `mobile/src/screens`<br>`mobile/src/components` |
| `02` | **狀態層 · App State**<br><sub>分析工作、播放、相機、設定與本機資料</sub> | `mobile/src/hooks`<br>`mobile/src/context` |
| `03` | **轉接層 · Data Adapter**<br><sub>將原生結果正規化為 PitchResult</sub> | `mobile/src/adapters/nativeAnalysis.ts` |
| `04` | **橋接層 · Native Bridge**<br><sub>React Native 與 iOS 核心的型別化介面</sub> | `mobile/modules/expo-speedgun/src` |
| `05` | **運算層 · iOS Core**<br><sub>影片解碼、模型推論、追蹤、球速、球種、落點與 overlay</sub> | `mobile/modules/expo-speedgun/ios` |
| `R&D` | **研究區 · Analysis Research**<br><sub>電腦視覺參考實作；不進入 App 執行路徑</sub> | `research` |

<a id="分析流程"></a>
<p align="center"><img src="docs/assets/readme-section-flow.svg" alt="03 分析流程" width="920"></p>

| 階段 | 處理內容 | 產出 |
|:---:|---|---|
| `01` | **讀取 · INGEST**<br><sub>影片解碼與原始時間戳</sub> | 逐幀影像 |
| `02` | **辨識 · DETECT**<br><sub>棒球偵測與姿勢估測</sub> | 球與人體座標 |
| `03` | **重建 · RECONSTRUCT**<br><sub>追蹤、漏偵補點與軌跡擬合</sub> | 連續球路 |
| `04` | **計算 · MEASURE**<br><sub>出手／接球時點與球速檢核</sub> | 可信球速 |
| `05` | **判讀 · CLASSIFY**<br><sub>落點、位移與球種辨識</sub> | 投球特徵 |
| `06` | **統一 · NORMALIZE**<br><sub>原生結果轉為共用資料模型</sub> | `PitchResult` |
| `07` | **呈現 · PRESENT**<br><sub>結果頁、互動進壘回放與歷史紀錄</sub> | 使用者體驗 |

<a id="架構邊界"></a>
<p align="center"><img src="docs/assets/readme-section-boundaries.svg" alt="04 架構邊界" width="920"></p>

> <sub>RULE 01 · SOURCE OF TRUTH</sub>
>
> ### 單一計算來源
>
> Swift 負責球速、落點、位移與球種；TypeScript 只做資料轉接與顯示。

> <sub>RULE 02 · DATA ≠ MOTION</sub>
>
> ### 數據與動畫分離
>
> 動畫補點和平滑只改變畫面；2D 與互動 3D 共用 `PitchReplayModel`，不改寫原始分析數據。

> <sub>RULE 03 · ON DEVICE</sub>
>
> ### 資料留在裝置端
>
> 分析、影片、投球紀錄與使用者設定皆保留在 iPhone。

<a id="專案結構"></a>
<p align="center"><img src="docs/assets/readme-section-structure.svg" alt="05 專案結構" width="920"></p>

<sub>REPOSITORY MAP · 3 WORKSPACES</sub>

```text
speedgun-mobile/                     # ROOT
├── mobile/
│   ├── src/                         # APP · UI、狀態與資料轉接
│   └── modules/expo-speedgun/
│       ├── src/                     # BRIDGE · TypeScript 介面
│       ├── ios/                     # CORE · Swift／Metal 分析核心
│       └── Resources/               # MODELS · App 使用的模型與參數
├── research/
│   ├── vision/                      # R&D · 電腦視覺參考實作
│   └── pitch_classifier/            # R&D · 規則式球種分類
├── scripts/                         # TOOLS · 開發、診斷與資料處理
└── docs/                            # DOCS · 技術文件
```
