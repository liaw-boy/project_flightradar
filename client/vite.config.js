import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';

export default defineConfig({
    plugins: [
        react()
    ],
    server: {
        host: '0.0.0.0',
        port: 3005,
        allowedHosts: ['flyradar.spkuan.cc'],
        proxy: {
            '/api': {
                target: 'http://localhost:3001',
                changeOrigin: true,
            },
            // [v5.0.0] WebSocket proxy — 讓 FlightDataWorker 的 WS 連線穿透到後端
            '/ws': {
                target: 'ws://localhost:3001',
                ws: true,
            },
        },
    },
    build: {
        outDir: '../public-react',
        emptyOutDir: true,
        chunkSizeWarningLimit: 3000,
        rollupOptions: {
            output: {
                manualChunks: {
                    vendor: ['react', 'react-dom']
                }
            }
        }
    },
});
