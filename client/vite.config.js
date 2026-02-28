import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';

export default defineConfig({
    plugins: [
        react(),
        legacy({
            targets: ['ios >= 12', 'chrome >= 60', 'safari >= 12'],
            additionalLegacyPolyfills: ['regenerator-runtime/runtime']
        })
    ],
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true,
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
