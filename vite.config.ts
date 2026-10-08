import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Developer mode only. The real dashboard is server/serve.ts on port 7777
 * (`npm start`); this dev server runs next to it on 5173 with live reload and
 * forwards every data request to it, so there is still only ONE place the
 * data and its cache live.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    open: false,
    proxy: { '/api': 'http://localhost:7777' },
  },
});
