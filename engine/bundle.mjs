// RFC 0002 phase 6: the engine as the two files batlehub-cli embeds — one
// ES module with packages/java-rules inlined, and the JDT bundle beside it,
// where `bundleJar()` looks first. `task engine:bundle`.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

const here = import.meta.dirname;
const out = path.join(here, "dist");
const jar = path.resolve(here, "..", "extensions", "java-core", "jdt", "batlehub-jdt-core.jar");
if (!existsSync(jar)) {
  console.error(`no ${jar}: run task jdt:build first`);
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
await esbuild.build({
  entryPoints: [path.join(here, "cli.ts")],
  outfile: path.join(out, "batlehub-java.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // jsonc-parser's `main` is a UMD build whose dynamic requires an ES module cannot run.
  mainFields: ["module", "main"],
  legalComments: "none",
  logLevel: "warning",
});
copyFileSync(jar, path.join(out, "batlehub-jdt-core.jar"));
