# 單一手機斜視拍攝的球速可行性研究

日期：2026-08-06
範圍：單一手機、捕手後方拍攝、相機相對投手—本壘軸略向左／右偏；仍可取得投手 pose 與接球聲。
目標：判斷是否能產出可信球速，並把必要校正、限制與驗證方法對應到 SpeedGun 現有模型。

## 結論

**可以，但「有 pose、有接球聲」不是充分條件。** 小幅左右偏斜不會直接改變物理飛行時間；而且本 repo 的正式距離來自使用者手動量測，不是把影像像素距離硬換成公尺，因此角度本身不必直接進入 `speed = distance / time`。要維持正確性，至少還要同時滿足：

1. 使用同一手機的內建相機與麥克風、保留原始音訊／影片 PTS；
2. 使用真實「出手至接球」有效距離，而不是只用投手板到本壘的固定距離；
3. 出手時刻要由 pose 候選再以真實球點精修，不能只靠約 30 Hz pose frame；
4. 接球聲時刻要扣除聲音從手套傳到手機的傳播時間，以及實測的裝置 A/V 固定偏移；
5. 偏斜時不能把球框放大（TTC / optical looming）當主時間來源；它假設球近似朝相機直線逼近，斜視會破壞線性模型；
6. 必須用雷達或多相機 ground truth 對角度分箱驗證，未通過的角度只顯示「估計值」或要求重拍。

若目標是 MLB Statcast 定義的 release velocity，單機的「有效距離 ÷ 飛行時間，再套阻力模型」仍是**模型推估**，不是直接量到逐點最大速度。MLB 將 velocity 定義為球從 release 到過本壘期間的最大速度，通常位於 release；Statcast 是追蹤整段飛行後取得該值（[MLB Velocity glossary](https://www.mlb.com/glossary/statcast/velocity)）。

## 1. 先區分兩種「斜」

### 1.1 手機位置左右平移，鏡頭仍瞄準投手

這會產生真正的視差角。若投手到相機沿場地軸距離為 `Z`，手機橫向偏移 `b`：

```math
\theta = \tan^{-1}(b/Z)
```

例：`Z = 20 m` 時，左右移 `1 m` 只有 `2.86°`，移 `2 m` 約 `5.71°`。這種小角度對純時間差幾乎沒有直接影響，但會影響 2D pose、球框尺寸與落點投影。

### 1.2 手機位置不變，只把鏡頭 yaw 左／右

物理視線到投手的方向未因手機旋轉而改變，但人物會落在畫面邊緣，增加裁切與鏡頭畸變風險。Apple 的相機校正資料明確把內參、外參與鏡頭畸變分開；要從像素回到場景幾何，需使用這些校正資訊（[Apple `AVCameraCalibrationData`](https://developer.apple.com/documentation/avfoundation/avcameracalibrationdata)）。

## 2. 正確的速度模型

### 2.1 平均飛行速度

```math
\bar v = \frac{L}{T}, \qquad
T = t_{catch}^{physical} - t_{release}^{physical}
```

其中 `L` 應是球從實際 release point 到 glove/contact point 的 3D 路徑長，不只是投手板到本壘的規則距離。MLB 規則的投手板到本壘後尖是 60 ft 6 in（[Official Baseball Rules, Rule 2.04](https://img.mlbstatic.com/mlb-images/image/upload/mlb/hhvryxqioipb87os1puw.pdf)），但實際 release extension 每球會變。

若只知道場地軸向有效距離 `Lz`、橫向位移 `Δx`、高差 `Δy`，直線近似為：

```math
L_{3D} \approx \sqrt{L_z^2 + \Delta x^2 + \Delta y^2}
```

以 repo 預設概念 `Lz = 18.44 - 1.70 = 16.74 m` 為例，即使 `Δx = 0.5 m`、`Δy = 1.0 m`，3D 直線只比軸向距離長約 `0.22%`。通常更大的距離誤差來自固定 stride correction 與實際 release extension 不一致，而不是小幅左右球路。

### 2.2 Repo 目前實際做法

目前正式分析強制使用手動投手板距離（[`ExpoSpeedgunModule.swift`](../../mobile/modules/expo-speedgun/ios/ExpoSpeedgunModule.swift)），有效距離為：

```math
L_{eff} = L_{manual} - L_{stride}
```

實作位於 [`BallSpeedCalculator.swift`](../../mobile/modules/expo-speedgun/ios/BallSpeedCalculator.swift)：

```math
v_{avg} = \frac{L_{eff}}{T}
```

並用固定阻力係數 `k` 反推出 release speed：

```math
v_0 = \frac{e^{kL_{eff}} - 1}{kT}
```

因此只要每球 `T` 真有變，速度理論上也會變；若實測每球幾乎相同，優先檢查的不是動畫，而是 `T` 是否被 fallback、clamp 或共同的 pre-detect 值壓成相近數字。

目前 flight time 的主路徑是：

```math
T_{endpoint} = (t_{last} - t_{first}) +
\max(t_{first} - t_{release},\; t_{ballSize/fixed})
```

這代表 pose gap 若小於 ball-size／fixed fallback，pose 時刻不會改變最終 `T`；多球可能因此趨近同一 pre-detect 補償。應在實測資料逐球比較 `release_time_s`、`first_ball_time_s`、`catch_time_s`、`pre_detect_sec`、`flight_time_source`、`physics_clamped`，不要只看最後 km/h。

## 3. 左右斜視對距離／透視的影響

針孔相機的完整投影是：

```math
s\begin{bmatrix}u\\v\\1\end{bmatrix}
= K [R|t]
\begin{bmatrix}X\\Y\\Z\\1\end{bmatrix}
```

`K` 是相機內參，`R,t` 是相機相對場地的外參。OpenCV 官方 calibration / `solvePnP` 文件要求已知 3D 場地點、對應 2D 像素、內參與畸變係數，才能估相機 pose 與做正確投影（[OpenCV camera calibration](https://docs.opencv.org/4.5.2/d9/d0c/group__calib3d.html)、[OpenCV solvePnP](https://docs.opencv.org/4.11.0/d5/d1f/calib3d_solvePnP.html)）。Zhang 的原始校正方法也以多個方向的平面標定板求內參與徑向畸變，再做非線性精修（[Zhang 2000, DOI 10.1109/34.888718](https://doi.org/10.1109/34.888718)）。

### 3.1 若用肩寬推距離

投手胸口與相機存在 yaw `θ` 時，肩寬的理想投影近似縮成 `W cos θ`。若仍用正面公式 `Z = fW/w_px`，距離會被高估約：

```math
\frac{Z_{est}}{Z_{true}} - 1 \approx \sec\theta - 1
```

| 視差角 | 距離高估（理想近似） |
|---:|---:|
| 5° | 0.38% |
| 10° | 1.54% |
| 15° | 3.53% |
| 20° | 6.42% |
| 30° | 15.47% |

Repo 正式球速已要求手動距離，所以不應讓這項 pose 尺度估計取代正式距離。單視圖不是完全不能量測，但必須有場地平面、消失線／已知尺度等額外幾何約束；原始 single-view metrology 研究就是在這些條件下取得仿射量測，而不是從一個人體寬度直接得到通用 3D 距離（[Criminisi, Reid & Zisserman, Single View Metrology](https://ora.ox.ac.uk/objects/uuid%3Afba56263-29d9-45ee-9fb2-93631037a127)）。

### 3.2 若用球框大小推 TTC 或 release 前漏拍時間

理想正面逼近時，球面積 `A` 與相機距離 `r` 的關係為 `A ∝ 1/r²`，所以：

```math
y(t) = \frac{1}{\sqrt{A(t)}} \propto r(t)
```

只有球近似沿相機光軸、以常速接近相機時，`r(t)` 才近似線性。相機橫向偏離球路 `b` 時：

```math
r(t) = \sqrt{(z_0-v_z t)^2+b^2}
```

此時 `1/√A` 不再是直線，也不會在真實手套接球時降到零。Repo 的 TTC 零交點模型（[`BallSpeedCalculator.swift`](../../mobile/modules/expo-speedgun/ios/BallSpeedCalculator.swift)）與 ball-size ranging（[`SpeedgunPipeline.swift`](../../mobile/modules/expo-speedgun/ios/SpeedgunPipeline.swift)）都會受 `b` 影響。**偏斜拍攝時應讓明確的 release/audio endpoint 優先，TTC 只當一致性檢查。**

## 4. Pose 出手時間：可用，但必須驗證事件而非只驗證關節存在

BlazePose 是單人、單目 33 點模型；原始論文指出 pose 面臨遮擋與多自由度挑戰，且模型主驗證資料是一般姿勢與 fitness/yoga，不是高速棒球出手（[Bazarevsky et al., BlazePose](https://arxiv.org/abs/2006.10204)）。其 3D 後續研究也明確說明：相同 2D `X,Y` 可對應多個不同深度 `Z`，單目 3D 存在投影歧義（[Grishchenko et al., BlazePose GHUM Holistic](https://arxiv.org/abs/2206.11678)）。

Repo 目前的做法比直接取 wrist frame 更好：

- pose 約每秒取樣 30 次；
- release template 要求 wrist/elbow/shoulder/hip 等點通過 2D 幾何門檻；
- release 候選必須在第一個真實球點之前、信心至少 0.5；
- 再用前 3–5 個非插補球點的 2D 速度線，回投影到最接近的投球手腕，且精修值須在 pose 候選 ±85 ms 內。

小幅斜視在理想針孔模型下，球離手位置仍應投影到手腕附近，所以此精修仍可能成立；真正風險是 throwing arm 自遮擋、球與手合併、人物落在畸變較大的畫面邊緣，以及 2D elbow/chest 門檻隨 view 改變。

「pose 有結果」不等於「release event 正確」。一篇以單相機 markerless 系統對 3D marker-based 系統的棒球投球驗證，`ball visible` 時間指標 RMSE 為 **21.75 ms**；這足以讓約 0.42 s 的飛行時間產生約 5% 的速度誤差，因此必須針對本 App、相機角度與出手事件另做驗證（[Dobos et al., 2022](https://doi.org/10.1080/14763141.2022.2137425)）。

## 5. 接球聲與 A/V 時間同步

### 5.1 同一手機的優勢

Apple 說明 AVAsset 內各 audio/video track 的 timeline 都以 parent asset 表示，`CMSampleBufferGetPresentationTimeStamp` 可取得原始 presentation timestamp（[AVFoundation Time and Media Representations](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/AVFoundationPG/Articles/06_MediaRepresentations.html)）。錄製階段的 capture outputs 也使用 session synchronization clock 的 timebase（[Apple `synchronizationClock`](https://developer.apple.com/documentation/avfoundation/avcapturesession/synchronizationclock)）。

所以單一原始影片內，用 PTS 對齊 pose frame 與 audio sample 是正確方向；VFR 不應改用 `frameIndex / nominalFPS`。

但共同 PTS 只解決「媒體時間軸」，不會消除：

- 聲音從手套傳到麥克風的物理延遲；
- 相機與麥克風訊號鏈可能存在的固定 A/V offset；
- 把高取樣率音訊先分桶到影片 frame 後造成的量化。

### 5.2 聲音傳播修正

NASA 的聲學資料給出 20°C 時聲速約 `343.37 m/s`（[NASA Atmospheric Sound Propagation](https://ntrs.nasa.gov/api/citations/19720017735/downloads/19720017735.pdf)）。若手套到手機麥克風距離為 `r_mic`：

```math
t_{sound} = \frac{r_{mic}}{c(T_{air})}
```

實際接球時間應近似：

```math
t_{catch}^{physical}
= t_{audio}^{PTS} - t_{sound} - \Delta t_{AV}
```

以真實飛行 `T = 0.42 s`、20°C 為例，若完全不扣聲音延遲：

| 手套到手機 | 聲音延遲 | 球速低估約 |
|---:|---:|---:|
| 1 m | 2.91 ms | 0.69% |
| 2 m | 5.82 ms | 1.37% |
| 3 m | 8.74 ms | 2.04% |
| 5 m | 14.56 ms | 3.35% |

左右偏移會改變 `r_mic`，所以這是斜視拍攝最明確、可校正的角度相關 timing error。

### 5.3 影格量化誤差

對 `T = 0.42 s`，一整個 frame 的時間誤差相當於：

| 真實 capture FPS | 1 frame | 相對時間誤差 |
|---:|---:|---:|
| 30 | 33.33 ms | 7.94% |
| 60 | 16.67 ms | 3.97% |
| 120 | 8.33 ms | 1.98% |
| 240 | 4.17 ms | 0.99% |

光流補幀可以幫助球追蹤與動畫平順，但不會新增真正的相機時間證據。若要穩定到數 km/h，應以原生 120/240 fps、原始 PTS 與 audio sample-level transient timestamp 為基礎；不能把 30 fps 補成 120 fps 就宣稱具有 120 fps 的出手時間精度。

### 5.4 若未來使用外接／第二台裝置

第二台手機或獨立錄音器不共享第一台手機的 capture clock，除了固定 offset，還會有 clock-rate drift。至少要以兩個以上同時可見／可聽的 calibration impulse（片頭與片尾）估：

```math
t_{audio} = a\,t_{video}+b
```

其中 `b` 校正起始 offset，`a` 校正 drift；只在片頭拍一下手只能估 `b`。智慧型手機多相機的原始同步研究之所以另外估計 clock 與 frame phase，正是因為各裝置時間戳不能天然視為同一物理時間（[Ansari et al., Sub-millisecond Video Synchronization of Multiple Android Smartphones](https://arxiv.org/abs/2107.00987)）。現階段最小且可靠的產品邊界仍應限定同一手機的原始 audio/video asset。

## 6. 誤差預算

對 `v = L/T`，一階近似為：

```math
\frac{\delta v}{v}
\approx \frac{\delta L}{L} - \frac{\delta T}{T}
```

保守上界：

```math
\left|\frac{\delta v}{v}\right|
\lesssim \frac{|\delta L|}{L} + \frac{|\delta T|}{T}
```

假設 `L = 16.74 m`、`T = 0.42 s`（平均約 143.5 km/h）：

- 有效距離錯 `0.20 m`：約 `1.19%`；
- 出手／接球合計錯 `10 ms`：約 `2.38%`；
- 手機距手套 2 m 卻未扣聲延：再約 `1.37%`；
- 合計已可達約 `4.9%`，即約 `7 km/h`。

因此「稍微斜但 pose/audio 都抓到」只能支持**可計算**，不能直接支持**正確**。

## 7. 建議的產品條件

### 可先支援（仍需實驗通過）

1. 單一手機、內建麥克風；不接受 Bluetooth／外接錄音或二次剪輯影片作正式速度。
2. 手機位於本壘後方，完整投手身體、投球手腕與捕手手套都在畫面；手機固定、不變焦。
3. 使用者輸入投手板—本壘實測距離，另輸入或估計手機—手套距離。
4. 真實 capture FPS 至少 120；pose 可約 30 Hz 產生候選，但 release 必須成功標記為 `pose_refined` 或有直接 ball-hand separation 證據。
5. audio catch 必須通過 transient、視覺 endpoint 與合理飛行時間三重 gate。
6. 斜視時 endpoint time 優先；TTC 不得單獨決定正式球速。
7. `flight_time_source == point_count`、`pre_detect_source == fixed`、`physics_clamped == true` 或 release/catch 不可信時，不顯示正式球速。

### 暫定角度門檻

沒有本產品自己的 angle-ground-truth dataset 前，不應宣稱任意角度都準。建議首版把 `|θ| ≤ 10°` 當**待驗證支援區**，`10–15°` 顯示低信心，`>15°` 要求重拍。這不是文獻保證值，而是由肩寬投影誤差（10° 約 1.5%、15° 約 3.5%）與單目 pose 風險推得的工程起點；最終門檻必須由下一節實驗決定。

## 8. 必做實驗設計

### 8.1 Ground truth 與布置

- 使用經校驗的 Doppler radar 或同步高速度多相機系統，取得每球 release velocity；
- 固定投手板、plate、glove、手機三維位置並實測到公分；
- 手機使用同一機型、鏡頭、解析度與原生 FPS；關閉數位變焦；
- 在手套平面放可同時產生「可見閉合 + 清楚聲響」的 clapper，先量每個 session 的 `Δt_AV + r_mic/c`；
- 每個角度記錄空氣溫度，用聲速公式修正；
- 保留原檔，不經社群軟體轉檔或剪輯。

### 8.2 分離位置偏移與鏡頭 yaw

兩套矩陣分開測：

1. **位置偏移**：相機放在 `θ = 0°, ±5°, ±10°, ±15°, ±20°` 對應位置，每次都瞄準投手；
2. **原地 yaw**：相機位置固定，只把投手放到畫面中心、1/3 線、靠近邊緣，測鏡頭畸變／裁切影響。

每格至少 20 球，涵蓋慢／中／快三個速度帶與左右投手；順序隨機化，避免疲勞與球速漂移和角度混淆。

### 8.3 每球必存欄位

- `release_time_s`, `first_ball_time_s`, `catch_time_s`, `flight_time_s`；
- `release_frame_source`, `flight_time_source`, `pre_detect_sec/source`, `ttc_status`；
- `physics_clamped`, pose confidence、實測球點比例、audio transient ratio；
- 手動距離、stride correction、手機—手套距離、溫度、相機角度；
- App speed 與 ground-truth speed。

### 8.4 統計與驗收

依角度分箱計算 bias、MAE、RMSE、95th-percentile absolute error、失敗率，並做 Bland–Altman limits of agreement；單相機 pitching validation 原始研究也使用 Bland–Altman 比較系統差異（[Dobos et al.](https://doi.org/10.1080/14763141.2022.2137425)）。

建議的產品驗收起點（屬產品目標，不是 MLB 標準）：

- 每個支援角度 bin：`|bias| ≤ 2 km/h`；
- `MAE ≤ 3 km/h`；
- 95% absolute error `≤ 5 km/h`；
- 無結果可以，但錯誤地輸出正式速度的比例 `< 1%`；
- 角度增加時不能出現單調 bias；若出現，應先校正 angle/audio propagation，而不是擴大 clamp。

## 9. 對現有架構的優先建議（不含本次程式修改）

1. **先診斷每球同速**：逐球輸出上述 timing provenance，確認是 endpoint、pre-detect、TTC 還是 physics clamp 讓 `T` 趨同。
2. **保留手動距離**：這正是讓小幅斜視不直接污染分子的關鍵；不要退回 pose 肩寬當正式距離。
3. **audio 改存連續時間**：保留 transient 的 sample-level PTS，不要只回傳最近 video frame；再扣 `r_mic/c + Δt_AV`。
4. **斜視停用 TTC 主導權**：從場地 calibration 得到 `θ`／ball-path-to-camera offset 後，偏斜只以 endpoint time 出正式值。
5. **校正相機**：若要同時改善落點、3D 軌跡與 angle gate，使用本壘板／投手板／壘線等已知 3D↔2D 點配 `K, distCoeffs, solvePnP`，不要增加另一組經驗 perspective factor。
6. **release 要回傳不確定度**：pose frame、精修時刻與第一球點的差應轉成 timing confidence；available 不等於 accurate。

最小可行路線是：**手動有效距離 + 同機 PTS + pose-refined release + sample-level audio catch（含聲延修正）+ ±角度 ground-truth gate**。這條路能支援小幅左右偏斜；若要在更大角度仍輸出 Statcast 級 3D release velocity，單機訊號不足，應升級為場地標定後的 3D ball tracking，或多相機／雷達融合。
