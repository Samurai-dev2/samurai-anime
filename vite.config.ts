import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },

  json: {
    stringify: true,
  },

  // ── Dev server proxy ──────────────────────────────────────────
  // During local dev, /api/* requests are forwarded to Vercel's
  // local dev server (run `vercel dev` in another terminal).
  // Without this, Vite serves api/ as static files (raw .ts source).
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },

  build: {
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: {
        manualChunks: {
          "fribb-mapper": ["./src/data/anime-seasons.json"],
        },
      },
    },
  },
});
