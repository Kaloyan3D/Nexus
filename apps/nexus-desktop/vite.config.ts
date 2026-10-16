/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022", sourcemap: false },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    css: false,
    // jsdom + user-event typing is CPU-bound; under a loaded host (e.g. a
    // parallel cargo build) 5 s default flaked on modelRun/composer tests.
    testTimeout: 20000,
  },
});
