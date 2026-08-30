// Side panel unit tests only. The bridge's service-worker suite under tests/
// runs on node:test (npm test) and must not be collected here: vitest cannot
// interpret its node:test harness and reports it as an empty suite.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
  },
});
