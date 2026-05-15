import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy /api/* and /ws/* to the backend during development so the frontend
// can use relative paths if desired, and so CORS headers are never an issue.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
