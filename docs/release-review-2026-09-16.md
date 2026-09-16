# 上架前程式品質審查 — 2026-09-16

本輪完成全專案檔案盤點與靜態搜尋，深入檢查 App 入口、設定與歷史保存、分析橋接、錄影、影片解碼與疊圖輸出、結果與回放流程，以及上架設定。研究用 Python 不進入 App 執行路徑；本輪未重新驗證其演算法。這不是逐行正確性或測速精度的保證。

## 已修正

| 優先度 | 問題與影響 | 修正與證據 |
| --- | --- | --- |
| P1 | 錄影後立刻關閉時，React 狀態尚未更新，關閉判斷漏掉正在進行的錄影；晚到結果仍可能被送進分析。 | 在錄影入口同步鎖定、關閉時立即丟棄結果，隱藏與卸載時清理。新增生命週期測試，修正前失敗、修正後通過。 |
| P1 | 解碼失敗被當成正常 EOF，分析可能使用不完整影格；iOS 解碼器也可能在零影格時回報完成。 | 只有真正完成且至少讀到一個影格才接受 EOF。以 AVFoundation 產生正常 MP4，再破壞其編碼資料驗證錯誤傳遞。 |
| P1 | 疊圖忽略讀取、編碼與 append 的失敗，零影格影片仍可能回報成功；pipeline 只看檔案存在就回傳 URI。 | 檢查讀寫結果，失敗時取消資源並移除輸出；pipeline 只回傳成功輸出的 URI。iOS 模擬器測試確認正常影片可重新解碼、損壞輸入被拒絕且不留半成品。相同測試對舊版 renderer 會失敗。 |
| P2 | HDR 暫存檔只在成功返回前移除；秒級 ID 可能碰撞。 | 改用 `defer` 清理、轉檔失敗清理與 UUID 檔名／分析 ID。 |
| P1（送審資料） | 隱私政策與審查說明聲稱不要求相機／麥克風，與引導拍攝功能不符；支援連結仍指向舊專案。 | 更新政策、Review Notes 與 App 內連結；說明拍攝權限及暫存影片保留方式。文件仍需發佈到公開 URL 才會對外生效。 |

## 驗證

在 `mobile` 目錄執行：

```bash
npm run check:release
# 另開啟一台 iOS 18.5 以上模擬器後：
npm run check:video:ios
```

- TypeScript、架構／回放檢查、16 項功能測試、Swift 球速檢查通過。
- macOS 原生解碼測試與 iOS 18.5 模擬器解碼／疊圖測試通過；測試自行建立與清除影片，不需另裝測試框架或 FFmpeg。
- Expo Doctor 18/18 通過，iOS JavaScript bundle 匯出成功。
- iPhoneOS Release 原生建置通過（`CODE_SIGNING_ALLOWED=NO`）。首次建置遇到舊 Codegen 產生檔缺失，執行 `npx pod-install` 重新產生後成功；沒有變更版本控制中的原生依賴。

## 送審前仍須完成

- 使用正式簽署做 Archive、Validate App 與 TestFlight；未簽署 Release 編譯不能代替上述步驟。
- 實機檢查首次及拒絕相簿／相機／麥克風權限、12 秒錄影、快速關閉／重新開啟、背景切換、低儲存空間、HDR／慢動作影片、分享、歷史清除及 iPad 版面。
- 歷史數據存於 AsyncStorage，影片仍使用暫存目錄；系統清理後無法保證歷史影片可重播。介面已有載入失敗提示，本輪未改成永久保存影片；需要長期保留時必須先分享儲存。
- 現有 `useOfflineAnalysis.cancel()` 只抑制進度通知，沒有取消原生工作，且介面目前沒有提供取消按鈕。若要加入取消功能，需完整串接 Swift 工作取消及清理，不能直接暴露現有方法。
- 以實際投球影片與可信測速基準驗證精度；本輪合成影片只驗證媒體讀寫，不驗證模型辨識率或球速準確度。
- 發佈更新後的隱私政策，確認公開支援／政策連結可用，填完 App Store Connect 資料、SDK 隱私資訊及 iPhone／iPad 截圖。

權限與隱私描述核對依據：[Apple App Review](https://developer.apple.com/app-store/review/)、[User Privacy and Data Use](https://developer.apple.com/app-store/user-privacy-and-data-use/)。Apple 要求清楚說明權限用途；本輪文件更新依照實際程式功能撰寫，未代填 App Store Connect 聲明。
