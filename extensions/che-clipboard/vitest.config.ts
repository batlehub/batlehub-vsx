import { defineConfig } from "vitest/config";

// Nothing under src/ but extension.ts imports `vscode`, and extension.ts is
// not under test: what is tested runs against a real socket and real shells.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: { provider: "v8", include: ["src/**/*.ts"], reporter: ["text", "html"] },
  },
});
