import { defineConfig } from "vitest/config";

// disk.ts holds the rule and imports nothing from `vscode`; extension.ts is
// the glue to the editor and is not under test.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: { provider: "v8", include: ["src/**/*.ts"], reporter: ["text", "html"] },
  },
});
