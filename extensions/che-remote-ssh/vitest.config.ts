import { defineConfig } from "vitest/config";
import path from "node:path";

// `vscode` is a module the editor injects at runtime. Only extension.ts
// imports it; the modules that hold the rules (discovery, oidc, kubeconfig,
// kubectl, sshconfig, che) import nothing from it, on purpose.
export default defineConfig({
  resolve: { alias: { vscode: path.resolve(__dirname, "test/vscode-mock.ts") } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: { provider: "v8", include: ["src/**/*.ts"], reporter: ["text", "html"] },
  },
});
