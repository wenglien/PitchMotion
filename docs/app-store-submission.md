# PitchMotion App Store 上架資料

> 目前未透過 App Store 發佈。現階段使用者請依 [iPhone 安裝指南](install-ios.md)，從 GitHub 下載原始碼並使用自己的 Apple Account 簽署安裝；本文件保留供未來重新送審使用。

## App 基本資料

- App 名稱：PitchMotion
- Bundle ID：`com.wenglien.speedgun.mobile`
- 版本：`1.0.0`
- 主要語言：繁體中文
- 建議主分類：運動
- 建議副分類：健康與健身
- Subtitle（30 字內）：`離線棒球球速與球路分析`
- SKU 建議：`pitchmotion-ios-001`
- Support URL：`https://github.com/wenglien/Baseball-Trajectory-Analysis/issues`
- Privacy Policy URL：`https://github.com/wenglien/Baseball-Trajectory-Analysis/blob/main/docs/privacy-policy.md`

## 宣傳文字

在 iPhone 上離線分析投球影片，查看球速、球種、好球帶落點、位移與 3D 球路。

## App 描述

PitchMotion 是專為棒球投手、教練與球迷設計的裝置端投球分析工具。

選取一段投球影片，即可在 iPhone 上分析球速、球種、好球帶落點、水平與垂直位移，並以進壘回放和 3D 軌跡檢視完整球路。分析使用 Core ML、球體偵測、姿勢估測與物理模型，全程在裝置上完成，影片與結果不需上傳伺服器。

主要功能：

- 離線球速與球種分析
- MLB ABS 風格好球帶與進壘回放
- 可旋轉的 3D 投球軌跡
- 水平位移與 Induced Vertical Break
- 本機投球歷史與單次練習統計
- 分析結果影片分享

球速結果會受到拍攝角度、影格率、光線、遮擋及距離校正影響，適合作為訓練參考，不取代經認證的測速設備。

## 關鍵字（100 bytes 內）

`棒球,球速,投手,投球,軌跡,好球帶,球種,訓練,baseball,pitching`

## App Review Notes

PitchMotion does not require an account or network connection. To test: open the Analyze tab, choose a local baseball pitch video, enter batter height, configure the measured mound-to-plate distance in Settings, then start analysis. Processing may take several minutes because Core ML and MediaPipe run entirely on device. Photo-library access is used only to select a video. Audio from the selected video is processed locally to estimate catch timing; the app does not request microphone access.

## App Store Connect 待填

- [ ] 建立 App record，確認 Bundle ID 與本專案一致
- [ ] 完成新版年齡分級問卷
- [ ] App Privacy 選擇「不收集資料」並再次核對第三方 SDK
- [ ] 填寫 Support URL、Privacy Policy URL、著作權與聯絡資料
- [ ] 上傳 iPhone 截圖；若保留 iPad 支援，另提供 iPad 截圖
- [ ] 提供審查用的實際投球測試影片或在 Review Notes 說明取得方式
- [ ] Archive 後用 Xcode Organizer 執行 Validate App，再上傳 TestFlight
- [ ] TestFlight 實機測試照片權限、離線分析、歷史刪除、分享與重新播放
