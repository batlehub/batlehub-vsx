// Two bundles: the extension (CommonJS, `vscode` external) and the Java
// panel's webview script (browser, IIFE). Everything else ships inside the
// bundles so the package has no runtime dependencies.
import * as esbuild from "esbuild";
import { rmSync } from "node:fs";

// esbuild never deletes: a renamed entry leaves its old bundle behind, and
// the VSIX would ship it.
rmSync("dist", { recursive: true, force: true });

const watch = process.argv.includes("--watch");
const common = {
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: "info",
  metafile: !!process.env.ESBUILD_METAFILE,
};
const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    target: "node20",
    format: "cjs",
    external: ["vscode"],
    // ESM builds first: jsonc-parser's `main` is a UMD whose wrapper finds the
    // extension host's AMD `define` and throws at load — the ESM build has no wrapper.
    mainFields: ["module", "main"],
  }),
  esbuild.context({
    ...common,
    entryPoints: ["media/panel/main.ts"],
    outdir: "dist/webview",
    // Keep `panel/main.js` under dist/webview whatever the entry count: with
    // one entry esbuild would flatten it to dist/webview/main.js and the
    // panel's HTML would load a stale file.
    outbase: "media",
    platform: "browser",
    target: "es2022",
    format: "iife",
  }),
]);
if (watch) await Promise.all(contexts.map((c) => c.watch()));
else {
  const results = [];
  for (const c of contexts) {
    results.push(await c.rebuild());
    await c.dispose();
  }
  if (process.env.ESBUILD_METAFILE) {
    const { writeFileSync } = await import("node:fs");
    const inputs = Object.assign(
      {},
      ...results.map((r) => r.metafile?.inputs ?? {}),
    );
    writeFileSync("dist/meta.json", JSON.stringify({ inputs }));
  }
}
