import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 後端 port 優先讀環境變數（dev_start.sh 會 export BACKEND_PORT），
// 未設定則 fallback 8000（與 backend/main.py 預設一致）。
const backendPort = process.env.BACKEND_PORT || '8000'
const backendOrigin = `http://localhost:${backendPort}`

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/analyze':  backendOrigin,
      '/overlays': backendOrigin,
      '/original': backendOrigin,
      '/download': backendOrigin,
      '/history':  backendOrigin,
      '/health':   backendOrigin,
      // SSE 長連線需要 changeOrigin + 關閉回應緩衝
      '/logs':     { target: backendOrigin, changeOrigin: true, timeout: 0 },
      '/jobs':     { target: backendOrigin, changeOrigin: true },
    },
  },
})
