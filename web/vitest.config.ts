import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // shared は package.json に main/exports を持たないので、ソースを直接指す(tsconfig の paths と対応)
    alias: { "@oss-review-lab/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
  },
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"] },
});
