import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    // Security-rules tests need the Firestore + Storage emulators; they run
    // through `npm run test:rules` (vitest.rules.config.ts), not `npm test`.
    exclude: [...configDefaults.exclude, "tests/rules/**"],
  },
  server: { port: 5173, host: "127.0.0.1" },
});
