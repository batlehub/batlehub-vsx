// The registry link (RFC 0001 §4.2 "Registry link", §7, decision 38):
// `batlehub-vsx` exports `token()` and `url()`; the core never opens the
// contract file. `registry.enabled: "ask"` prompts once per Maven/Gradle
// workspace; `true` writes the mirror (and the token) where the build tool
// reads it; `false` removes only the core's own blocks.
import * as vscode from "vscode";
import type { RegistryLink } from "../api-types";
import type { BuildToolProvider } from "../build/types";
import { readSettings, writeWorkspace } from "../config";
import type { Core } from "../extension";
import { log } from "../log";

/** What `batlehub-vsx` exports from its `activate` (phase 5, its only change). */
export interface VsxExports {
  token(): Promise<string | null>;
  url(): Promise<string | null>;
}

async function vsx(): Promise<VsxExports | undefined> {
  const ext = vscode.extensions.getExtension<VsxExports>(
    "batlehub.batlehub-vsx",
  );
  if (!ext) return undefined;
  try {
    const api = ext.isActive ? ext.exports : await ext.activate();
    return api && typeof api.token === "function" ? api : undefined;
  } catch {
    return undefined;
  }
}

export class Link implements RegistryLink {
  constructor(
    private readonly core: Core,
    private readonly providers: () => BuildToolProvider[],
  ) {}

  enabled(): "ask" | "true" | "false" {
    return readSettings().registryEnabled;
  }

  async token(): Promise<string | null> {
    if (this.enabled() === "false") return null;
    return (await (await vsx())?.token()) ?? null;
  }

  /** The configured URL, else the registry `batlehub-vsx` is signed into (its VS Code registry's origin + `/proxy/maven` is not assumed: the URL is what the user or batlehub-vsx gives). */
  async url(): Promise<string | null> {
    const s = readSettings();
    if (s.registryUrl) return s.registryUrl;
    if (s.registryEnabled === "false") return null;
    return (await (await vsx())?.url()) ?? null;
  }

  /** The Maven endpoint of the registry: `<hub>/proxy/<maven registry>`; the user gives the whole URL, or batlehub-vsx's origin gains `/proxy/maven`. */
  async mavenUrl(): Promise<string | null> {
    const u = await this.url();
    if (!u) return null;
    return /\/proxy\/[^/]+\/?$/.test(u)
      ? u.replace(/\/$/, "")
      : `${new URL(u).origin}/proxy/maven`;
  }

  /** Once per workspace, after a Maven/Gradle build was detected. */
  async propose(): Promise<void> {
    if (this.enabled() !== "ask") return;
    if (!this.core.snapshot()?.folders.some((f) => f.tool)) return;
    const yes = vscode.l10n.t("Route through BatleHub");
    const never = vscode.l10n.t("Never");
    const r = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "Java: route Maven and Gradle through your BatleHub registry? The mirror is written into ~/.m2/settings.xml and ~/.gradle/init.d in a block BatleHub Java owns and can remove.",
      ),
      yes,
      never,
    );
    if (r === never) await writeWorkspace("registry.enabled", "false");
    if (r === yes) {
      await writeWorkspace("registry.enabled", "true");
      await this.apply();
    }
  }

  /** Apply the current state: enabled → blocks written (warning without a signed-in batlehub-vsx); disabled → removed. */
  async apply(): Promise<void> {
    const enabled = this.enabled() === "true";
    if (!this.core.trusted()) return;
    const url = enabled ? await this.mavenUrl() : null;
    if (enabled && !url) {
      log.warn(
        "registry.enabled is true but neither registry.url nor batlehub-vsx names a registry: the build runs against the default remotes",
      );
      this.core.statusBar.update({
        warnings: [
          ...this.core.statusBar.facts.warnings.filter(
            (w) => !w.startsWith("registry"),
          ),
          vscode.l10n.t(
            "registry link on, but batlehub-vsx is absent or signed out — no token written",
          ),
        ],
      });
      return;
    }
    const token = enabled ? await this.token() : null;
    if (enabled && !token)
      log.warn(
        "registry link: no token from batlehub-vsx (absent or signed out); the mirror is written without credentials",
      );
    for (const p of this.providers()) {
      if (!p.configureRegistry) continue;
      try {
        await p.configureRegistry({ url: url ?? "", token }, enabled && !!url);
      } catch (e) {
        log.error(`registry link (${p.id}): ${(e as Error).message}`);
        void vscode.window.showErrorMessage(
          vscode.l10n.t(
            "Java: could not write the registry link for {0}: {1}",
            p.id,
            (e as Error).message,
          ),
        );
      }
    }
    log.info(
      `registry link ${enabled ? `enabled → ${url}${token ? " (token from batlehub-vsx)" : " (no token)"}` : "disabled: blocks removed"}`,
    );
  }
}
