// The settings, read once per use so a change takes effect without a
// reload, and the two derived values every module keys on: the registry's
// origin (the contract file's key) and the contract file's path.
import * as vscode from "vscode";
import { defaultContractPath, originOf } from "./contract";

export type Mode = "auto" | "broker" | "marketplace";

export interface Settings {
  /** `https://hub.example.dev/proxy/vsx`, or "" when unset. */
  registry: string;
  origin: string | null;
  mode: Mode;
  cliPath: string;
  contractPath: string;
  verifySignatures: boolean;
  pageSize: number;
}

export function readSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const c = vscode.workspace.getConfiguration("batlehub");
  const registry = (c.get<string>("registry") ?? "").trim().replace(/\/+$/, "");
  let origin: string | null = null;
  if (registry) {
    try {
      origin = originOf(registry);
    } catch {
      origin = null;
    }
  }
  const contract = (c.get<string>("contractFile") ?? "").trim();
  const mode = c.get<Mode>("mode") ?? "auto";
  return {
    registry,
    origin,
    mode: mode === "broker" || mode === "marketplace" ? mode : "auto",
    cliPath: (c.get<string>("cliPath") ?? "batlehub-cli").trim() || "batlehub-cli",
    contractPath: contract || defaultContractPath(env),
    verifySignatures: c.get<boolean>("verifySignatures") ?? true,
    pageSize: Math.max(1, Math.min(200, c.get<number>("pageSize") ?? 50)),
  };
}
