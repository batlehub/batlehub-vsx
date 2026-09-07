// The slice of the `vscode` module the tested modules touch. The pure
// modules import none of it; this exists so modules like broker.ts and the
// installer can be imported by a test without an editor.
import { EventEmitter as NodeEmitter } from "node:events";

export class EventEmitter<T> {
  private readonly inner = new NodeEmitter();
  event = (listener: (e: T) => unknown) => {
    this.inner.on("e", listener);
    return { dispose: () => this.inner.off("e", listener) };
  };
  fire(e: T): void {
    this.inner.emit("e", e);
  }
  dispose(): void {
    this.inner.removeAllListeners();
  }
}

export class Disposable {
  constructor(private readonly fn?: () => void) {}
  dispose(): void {
    this.fn?.();
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
export enum ProgressLocation {
  Notification = 15,
}
export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}
export class ThemeColor {
  constructor(readonly id: string) {}
}
export class MarkdownString {
  constructor(readonly value: string) {}
}
export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: unknown;
  contextValue?: string;
  iconPath?: unknown;
  command?: unknown;
  constructor(
    public label: string,
    public collapsibleState?: TreeItemCollapsibleState,
  ) {}
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
    readonly fsPath: string,
  ) {}
  static file(p: string): Uri {
    return new Uri("file", p, p);
  }
  static parse(s: string): Uri {
    const u = new URL(s);
    return new Uri(u.protocol.replace(/:$/, ""), u.pathname, u.pathname);
  }
  static from(c: { scheme: string; path?: string }): Uri {
    return new Uri(c.scheme, c.path ?? "", c.path ?? "");
  }
  toString(): string {
    return `${this.scheme}:${this.path}`;
  }
}

export const executed: { command: string; args: unknown[] }[] = [];
export const contexts = new Map<string, unknown>();

export const commands = {
  executeCommand: async (command: string, ...args: unknown[]) => {
    executed.push({ command, args });
    if (command === "setContext") contexts.set(String(args[0]), args[1]);
    return undefined;
  },
  registerCommand: (_c: string, _f: unknown) => new Disposable(),
};

export const configuration: Record<string, unknown> = {};
export const workspace = {
  getConfiguration: (_section?: string) => ({
    get: <T>(k: string) => configuration[k] as T | undefined,
  }),
  onDidChangeConfiguration: () => new Disposable(),
  registerTextDocumentContentProvider: () => new Disposable(),
  openTextDocument: async () => ({}),
};

export const statusItems: Record<string, unknown>[] = [];
export const messages: string[] = [];
export const window = {
  createOutputChannel: (_name: string) => ({
    appendLine: (_l: string) => {},
    show: () => {},
    dispose: () => {},
  }),
  createStatusBarItem: (_id: string, _a: number, _p: number) => {
    const it: Record<string, unknown> = { show: () => {}, hide: () => {}, dispose: () => {} };
    statusItems.push(it);
    return it;
  },
  createTreeView: () => ({ dispose: () => {}, title: "" }),
  showInformationMessage: async (m: string) => {
    messages.push(m);
    return undefined;
  },
  showWarningMessage: async (m: string) => {
    messages.push(m);
    return undefined;
  },
  showErrorMessage: async (m: string) => {
    messages.push(m);
    return undefined;
  },
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  setStatusBarMessage: () => new Disposable(),
  withProgress: async <T>(_o: unknown, f: (p: { report: () => void }) => Promise<T>) =>
    f({ report: () => {} }),
  showTextDocument: async () => {},
};

export const env = {
  appRoot: "",
  openExternal: async (_u: Uri) => true,
  clipboard: { writeText: async (_t: string) => {} },
};

export const extensions = {
  all: [] as { id: string; packageJSON: { version: string } }[],
  getExtension: (id: string) => extensions.all.find((e) => e.id.toLowerCase() === id.toLowerCase()),
  onDidChange: () => new Disposable(),
};

export const authentication = {
  registerAuthenticationProvider: () => new Disposable(),
};
