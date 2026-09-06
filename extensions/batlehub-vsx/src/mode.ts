// Mode detection, RFC 0011 §4.2: `vsxRegistryAuthSupport: true` in the
// editor's `product.json`, or `VSX_REGISTRY_AUTH_SUPPORT=1` in the
// environment, means the editor's own gallery reaches the registry with a
// credential it reads from the contract file — broker mode. A gallery the
// local proxy serves (RFC 0011 §4.4) reaches it the same way, so that is
// broker too. Anything else is a stock build whose gallery URL cannot be
// repointed: the marketplace view is the surface.
import * as fs from "node:fs";
import * as path from "node:path";
import { Mode } from "./config";

export type EffectiveMode = "broker" | "marketplace";

export interface ProductInfo {
  vsxRegistryAuthSupport: boolean;
  galleryServiceUrl: string | null;
}

export function readProduct(appRoot: string | undefined): ProductInfo {
  const none: ProductInfo = { vsxRegistryAuthSupport: false, galleryServiceUrl: null };
  if (!appRoot) return none;
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(appRoot, "product.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const gallery = doc.extensionsGallery as Record<string, unknown> | undefined;
    return {
      vsxRegistryAuthSupport: doc.vsxRegistryAuthSupport === true,
      galleryServiceUrl: typeof gallery?.serviceUrl === "string" ? gallery.serviceUrl : null,
    };
  } catch {
    return none;
  }
}

export interface ModeDecision {
  mode: EffectiveMode;
  reason: string;
}

export function decideMode(
  setting: Mode,
  product: ProductInfo,
  env: NodeJS.ProcessEnv,
  registry: string,
): ModeDecision {
  if (setting === "broker") return { mode: "broker", reason: "batlehub.mode is broker" };
  if (setting === "marketplace")
    return { mode: "marketplace", reason: "batlehub.mode is marketplace" };
  if (env.VSX_REGISTRY_AUTH_SUPPORT === "1")
    return { mode: "broker", reason: "VSX_REGISTRY_AUTH_SUPPORT=1" };
  if (product.vsxRegistryAuthSupport)
    return { mode: "broker", reason: "product.json advertises vsxRegistryAuthSupport" };
  const g = product.galleryServiceUrl;
  if (g) {
    if (registry && g.startsWith(registry.replace(/\/+$/, "") + "/"))
      return { mode: "broker", reason: `the editor's gallery is this registry (${g})` };
    if (
      /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/[^/]+\/[^/]+\/vscode\/gallery/.test(g)
    )
      return { mode: "broker", reason: `the editor's gallery is a local BatleHub proxy (${g})` };
  }
  return {
    mode: "marketplace",
    reason: g
      ? `the editor's gallery is ${g} and cannot be repointed`
      : "the editor advertises no gallery",
  };
}
