import { defineConfig } from "vitest/config";
import path from "node:path";

// `vscode` is a module the editor injects at runtime. The rule modules
// (jdk, detect, run/configs, build/maven/settings, written, redact, mode,
// contract) import nothing from it; the glue that does gets test/vscode-mock.ts.
export default defineConfig({
  resolve: { alias: { vscode: path.resolve(__dirname, "test/vscode-mock.ts") } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: { provider: "v8", include: ["src/**/*.ts"], reporter: ["text", "html"] },
  },
});
