// What this extension installed from which registry, at which version — in
// the editor's global state, so "check for updates" is a diff between this
// and what the registry lists, and an update is offered only for what came
// from here (RFC 0011 §6.5: the install ledger).
import * as vscode from "vscode";

export interface LedgerEntry {
  version: string;
  registry: string;
  installedAt: string;
}

export type LedgerMap = Record<string, LedgerEntry>;

const KEY = "batlehub.ledger";

export class Ledger {
  constructor(private readonly state: vscode.Memento) {}

  all(): LedgerMap {
    return { ...this.state.get<LedgerMap>(KEY) };
  }

  get(id: string): LedgerEntry | undefined {
    return this.all()[id.toLowerCase()];
  }

  async set(id: string, entry: LedgerEntry): Promise<void> {
    const all = this.all();
    all[id.toLowerCase()] = entry;
    await this.state.update(KEY, all);
  }

  async delete(id: string): Promise<void> {
    const all = this.all();
    delete all[id.toLowerCase()];
    await this.state.update(KEY, all);
  }
}
