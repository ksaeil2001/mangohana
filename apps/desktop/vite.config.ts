import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  base: "./",
  optimizeDeps: {
    entries: ["index.html"],
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime"
    ]
  },
  server: {
    strictPort: true,
    // Allows the temporary Manus preview proxy during local UI verification.
    allowedHosts: [".manus.computer"],
    watch: {
      ignored: [
        "**/artifacts/**",
        "**/.worktrees/**",
        "**/release/**",
        "**/dist-electron/**",
        "**/dist-renderer/**",
        "**/resources/**",
        "**/review-captures*/**"
      ]
    },
    warmup: {
      clientFiles: [
        "./index.html",
        "./src/renderer/App.tsx"
      ]
    }
  },
  test: {
    exclude: [...configDefaults.exclude, "**/.worktrees/**", "**/artifacts/**"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    maxWorkers: 2
  },
  build: {
    outDir: "dist-renderer",
    emptyOutDir: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
        manualChunks(id) {
          if (
            id.includes("node_modules/react/")
            || id.includes("node_modules/react-dom/")
          ) {
            return "react-runtime";
          }
          return undefined;
        }
      }
    }
  }
});
