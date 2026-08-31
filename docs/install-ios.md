# 在 iPhone 安裝 PitchMotion

> [!IMPORTANT]
> PitchMotion 目前只支援 iOS。安裝需要 Mac 與 Xcode；Windows、Linux、Android 與 Expo Go 皆不支援此 App 的原生分析模組。

PitchMotion 現階段透過 GitHub 提供原始碼。每位使用者需要用自己的 Apple Account 在 Xcode 完成簽署，再安裝到自己的 iPhone。GitHub 上不提供通用 IPA，因為 iOS 實機 App 必須使用對應的憑證與 provisioning profile 簽署。

## 安裝前準備

| 需求 | 版本或說明 |
|---|---|
| Mac | 必須能執行下列版本的 Xcode |
| Xcode | `26.2` 以上，先開啟一次並完成元件安裝 |
| Node.js | `20.19` 以上；建議使用目前的 LTS 版本 |
| iPhone / iPad | iOS / iPadOS `15.1` 以上 |
| Apple Account | 免費帳號即可安裝到自己的裝置 |
| 連線 | 第一次下載套件與簽署時需要網路 |

版本需求依據 [Expo SDK 55](https://docs.expo.dev/versions/v55.0.0/)；Xcode 實機簽署流程可參考 [Apple 官方文件](https://developer.apple.com/documentation/Xcode/running-your-app-on-simulated-or-physical-devices)。

免費 Apple Account 會在 Xcode 顯示為 **Personal Team**。Apple 規定其 provisioning profile 於 7 天後失效，屆時需重新連接 Mac 建置安裝；詳細限制見 [Apple Developer account overview](https://developer.apple.com/help/account/basics/about-your-developer-account)。

## 1. 下載專案

選擇其中一種方式：

- 在 GitHub 專案頁點選 **Code → Download ZIP**，下載後解壓縮。
- 已安裝 Git 時，在終端機執行：

```bash
git clone https://github.com/wenglien/PitchMotion.git
```

## 2. 設定自己的 Bundle Identifier

用文字編輯器開啟 `mobile/app.json`，找到：

```json
"bundleIdentifier": "com.wenglien.speedgun.mobile"
```

將它換成自己專用且唯一的值，例如：

```json
"bundleIdentifier": "com.yourname.pitchmotion"
```

只使用英文字母、數字、連字號與句點，並把 `yourname` 換成自己的識別。這項修改只需要留在自己的電腦，不必提交回 GitHub。

## 3. 產生 iOS 專案

開啟終端機，進入解壓縮或 clone 後的專案：

```bash
cd PitchMotion/mobile
npm ci
npx expo prebuild --platform ios
npx pod-install
open ios/PitchMotion.xcworkspace
```

若下載的是 ZIP，資料夾可能叫 `PitchMotion-main`，請依實際位置調整第一行。第一次安裝依賴需要幾分鐘。

## 4. 在 Xcode 設定簽署

1. 在 Xcode 選單開啟 **Xcode → Settings → Accounts**，登入 Apple Account。
2. 回到專案，點選左側最上方的 **PitchMotion** 專案。
3. 選擇 **PitchMotion target → Signing & Capabilities**。
4. 勾選 **Automatically manage signing**。
5. 在 **Team** 選擇自己的帳號或 **Personal Team**。
6. 確認 **Bundle Identifier** 是上一節設定的唯一值，且頁面沒有紅色簽署錯誤。

Xcode 會自動建立 development provisioning profile，並在連接裝置後替你註冊裝置。

## 5. 連接 iPhone

1. 使用 USB 連接 iPhone 與 Mac；iPhone 出現提示時選擇**信任**。
2. iOS 16 以上請到 **設定 → 隱私權與安全性 → 開發者模式**，開啟後依指示重新啟動。
3. 回到 Xcode，在上方執行裝置選單選擇自己的 iPhone。

開發者模式只需對每台裝置設定一次；可參考 [Expo 的 iOS Developer Mode 指南](https://docs.expo.dev/guides/ios-developer-mode/)。

## 6. 安裝可獨立執行的版本

為了讓 PitchMotion 離開 Mac 後仍可開啟，請使用 Release configuration：

1. 在 Xcode 選擇 **Product → Scheme → Edit Scheme**。
2. 選擇左側 **Run**，將 **Build Configuration** 改為 **Release**。
3. 關閉設定視窗，確認上方選擇的是自己的 iPhone。
4. 點擊左上角 **Run ▶**，等待 Xcode 完成編譯與安裝。

安裝成功後，PitchMotion 會出現在 iPhone 主畫面，分析功能不需要連接 Mac 或網路。Expo 也支援使用 [`npx expo run:ios --device --configuration Release`](https://docs.expo.dev/more/expo-cli/) 執行相同類型的本機建置，但第一次仍建議從 Xcode 處理簽署問題。

## 更新 PitchMotion

使用 Git clone 的使用者：

```bash
git pull
cd mobile
npm ci
npx expo prebuild --clean --platform ios
npx pod-install
open ios/PitchMotion.xcworkspace
```

`--clean` 會重新產生 `mobile/ios`，因此回到 Xcode 後需要再次確認 Team 與簽署設定。使用 ZIP 的使用者可重新下載新版，並重做安裝步驟。

## 常見問題

### Xcode 顯示 Signing requires a development team

回到 **Signing & Capabilities** 選擇自己的 Team，並確認已在 Xcode 登入 Apple Account。

### Bundle Identifier 已被使用

把 `mobile/app.json` 的 `ios.bundleIdentifier` 改成另一個只屬於自己的值，再執行：

```bash
npx expo prebuild --clean --platform ios
npx pod-install
```

### 找不到 PitchMotion.xcworkspace

在 `mobile` 目錄執行 `npx pod-install`。請開啟 `.xcworkspace`，不要開啟 `.xcodeproj`。

### iPhone 無法執行或看不到開發者模式

先保持 iPhone 連接 Mac，在 Xcode 開啟 **Window → Devices and Simulators**；確認裝置已信任 Mac，再依 Xcode 提示啟用開發者模式。

### App 開啟後要求連接開發伺服器

這代表安裝的是 Debug build。請依第 6 節把 Run configuration 改為 **Release** 後重新安裝。

### 可以安裝 Android 版本嗎？

目前不行。專案設定與安裝支援只針對 iOS；Android 版本暫不開放。
