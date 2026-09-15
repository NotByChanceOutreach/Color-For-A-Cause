import { defineConfig } from "vitest/config";

// Emulator-backed security-rules tests (tests/rules/**).
// Run with `npm run test:rules`, which starts the Firestore and Storage
// emulators under the offline demo-cfac project and tears them down after.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/rules/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 120_000,
    // Denied writes are the expected outcome of most tests here; the Firestore
    // SDK logs each one as a stream warning. Keep the output readable.
    onConsoleLog: (log) => !/@firebase\/firestore:.*PERMISSION_DENIED/s.test(log),
  },
});
