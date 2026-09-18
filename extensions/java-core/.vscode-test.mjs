// Layer 2 of RFC 0001 §10: the real extension host, no browser. Runs in CI
// (`task ext:host`); the Che tools container has no display for it.
import { defineConfig } from "@vscode/test-cli";
import path from "node:path";

export default defineConfig({
  files: "test-host/out/**/*.test.js",
  version: "stable",
  workspaceFolder: path.resolve("../../tests/heavy/fixtures/maven-multi"),
  extensionDevelopmentPath: ".",
  installExtensions: ["redhat.java@1.56.0"],
  mocha: { ui: "tdd", timeout: 120000 },
  launchArgs: ["--disable-workspace-trust"],
});
