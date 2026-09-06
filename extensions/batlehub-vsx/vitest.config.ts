import { defineConfig } from "vitest/config";
import path from "node:path";

// `vscode` is a module the editor injects at runtime. The modules under test
// that touch it get the stub in test/vscode-mock.ts; the pure ones
// (contract, vsix, api, credentials) import nothing from it on purpose.
export default defineConfig({
  resolve: { alias: { vscode: path.resolve(__dirname, "test/vscode-mock.ts") } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: { provider: "v8", include: ["src/**/*.ts"], reporter: ["text", "html"] },
  },
});
