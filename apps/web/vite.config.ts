import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// في التطوير: خادم Vite يمرّر /api إلى خدمة الـAPI على المنفذ 4000.
// لا يستدعي المتصفح أي عنوان مطلق؛ كل الطلبات نسبية إلى أصل الواجهة.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:4000',
        changeOrigin: false,
      },
    },
  },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
});
