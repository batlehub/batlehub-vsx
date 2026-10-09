import path from "node:path";
import { defineConfig } from "vitest/config";

// calendar.ts and overlay.ts import nothing from `vscode` and are tested as
// plain Node (docs/contributing/testing.md). settings.ts is the one module
// that touches the editor's configuration, so the alias exists for it.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: { provider: "v8", include: ["src/**/*.ts"], reporter: ["text", "html"] },
  },
  resolve: { alias: { vscode: path.resolve(__dirname, "test/vscode-mock.ts") } },
});
