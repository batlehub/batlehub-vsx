// The slice of the `vscode` module the tested modules touch. calendar.ts and
// overlay.ts import none of it; this exists so settings.ts and extension.ts
// can be imported by a test without an editor.
//
// The configuration store is two flat maps of dotted keys, because the thing
// under test is precisely the difference between a global value, a workspace
// value and no value at all (RFC 0019 §5.2).

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

type Store = Record<string, unknown>;

export const state = {
  global: {} as Store,
  workspace: {} as Store,
  /** Every update(), in order, so a test can assert the order and the target. */
  updates: [] as { key: string; value: unknown; target: ConfigurationTarget | undefined }[],
  warnings: [] as string[],
  infos: [] as string[],
  logs: [] as string[],
  commands: {} as Record<string, (...args: unknown[]) => unknown>,
  configListeners: [] as ((e: { affectsConfiguration: (s: string) => boolean }) => unknown)[],
  /** What the next modal showWarningMessage returns. */
  answer: undefined as string | undefined,
  statusBar: {
    text: "",
    tooltip: undefined as unknown,
    visible: false,
    command: undefined as unknown,
    name: undefined as unknown,
  },
};

export const reset = (): void => {
  state.global = {};
  state.workspace = {};
  state.updates = [];
  state.warnings = [];
  state.infos = [];
  state.logs = [];
  state.commands = {};
  state.configListeners = [];
  state.answer = undefined;
  state.statusBar = {
    text: "",
    tooltip: undefined,
    visible: false,
    command: undefined,
    name: undefined,
  };
};

const full = (section: string | undefined, key: string) => (section ? `${section}.${key}` : key);

export const workspace = {
  getConfiguration(section?: string) {
    return {
      get<T>(key: string, fallback?: T): T | undefined {
        const k = full(section, key);
        if (k in state.workspace) return state.workspace[k] as T;
        if (k in state.global) return state.global[k] as T;
        return fallback;
      },
      inspect<T>(key: string) {
        const k = full(section, key);
        return {
          key: k,
          globalValue: k in state.global ? (state.global[k] as T) : undefined,
          workspaceValue: k in state.workspace ? (state.workspace[k] as T) : undefined,
        };
      },
      async update(key: string, value: unknown, target?: ConfigurationTarget): Promise<void> {
        const k = full(section, key);
        state.updates.push({ key: k, value, target });
        const store = target === ConfigurationTarget.Workspace ? state.workspace : state.global;
        if (value === undefined) delete store[k];
        else store[k] = value;
      },
    };
  },
  onDidChangeConfiguration(
    listener: (e: { affectsConfiguration: (s: string) => boolean }) => unknown,
  ) {
    state.configListeners.push(listener);
    return new Disposable();
  },
};

/** Fire the configuration event for one key, the way the editor would. */
export const fireConfigChange = async (key: string): Promise<void> => {
  for (const listener of state.configListeners)
    await listener({ affectsConfiguration: (s: string) => s === key });
};

export class Disposable {
  constructor(private readonly fn?: () => void) {}
  dispose(): void {
    this.fn?.();
  }
}

export const window = {
  createOutputChannel(_name: string) {
    return {
      appendLine: (line: string) => state.logs.push(line),
      dispose: () => undefined,
    };
  },
  createStatusBarItem(_id: string, _alignment?: StatusBarAlignment, _priority?: number) {
    return {
      get text() {
        return state.statusBar.text;
      },
      set text(v: string) {
        state.statusBar.text = v;
      },
      get tooltip() {
        return state.statusBar.tooltip;
      },
      set tooltip(v: unknown) {
        state.statusBar.tooltip = v;
      },
      get command() {
        return state.statusBar.command;
      },
      set command(v: unknown) {
        state.statusBar.command = v;
      },
      get name() {
        return state.statusBar.name;
      },
      set name(v: unknown) {
        state.statusBar.name = v;
      },
      show: () => {
        state.statusBar.visible = true;
      },
      hide: () => {
        state.statusBar.visible = false;
      },
      dispose: () => undefined,
    };
  },
  async showWarningMessage(message: string, ...rest: unknown[]): Promise<string | undefined> {
    state.warnings.push(message);
    return rest.length ? state.answer : undefined;
  },
  async showInformationMessage(message: string): Promise<string | undefined> {
    state.infos.push(message);
    return undefined;
  },
};

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
    state.commands[id] = handler;
    return new Disposable();
  },
};

// The identity bundle: `en` is the source language, so t() is a formatter.
export const l10n = {
  t(message: string, ...args: unknown[]): string {
    return args.reduce<string>((s, a, i) => s.replaceAll(`{${i}}`, String(a)), message);
  },
};

export type ExtensionContext = { subscriptions: { dispose(): void }[] };
