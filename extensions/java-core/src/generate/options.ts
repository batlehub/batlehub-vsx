// The options of the builder and withers delegates (RFC 0015 §4.1, §6.2):
// pure, so the quick input, the smoke and an agent build the same JSON.

export interface ShortcutSettings {
  methodPrefix: "with" | "set" | "";
  placement: "inner" | "file";
  lombok: "offer" | "always" | "never";
  withersStyle: "copy" | "mutate";
  /** Surround with try/catch: the thrown checked types when bindings say, or always `Exception`. */
  catchType: "precise" | "Exception";
}

export const SHORTCUT_DEFAULTS: ShortcutSettings = {
  methodPrefix: "with",
  placement: "inner",
  lombok: "offer",
  withersStyle: "copy",
  catchType: "precise",
};

/**
 * Lombok's path (§4.1, decision 5): asked only when Lombok is on the module's
 * classpath and the setting offers it; `always` takes it without asking;
 * never introduced where the project does not use it.
 */
export function lombokChoice(
  setting: ShortcutSettings["lombok"],
  onClasspath: boolean,
): "ask" | "annotation" | "code" {
  if (!onClasspath || setting === "never") return "code";
  return setting === "always" ? "annotation" : "ask";
}

/** A `lombok-*.jar` on the resolved classpath (§4.2): a jar name, never loaded. */
export const hasLombok = (classpath: string[]) =>
  classpath.some((p) => /(^|[\\/])lombok[-\d.]*\.jar$/.test(p));

/** The JSON the delegate takes; `fields` undefined means every field. */
export function shortcutOptions(
  kind: "builder" | "withers",
  a: {
    fields?: string[];
    methodPrefix: string;
    placement?: "inner" | "file";
    style?: "copy" | "mutate";
    lombok: boolean;
  },
): Record<string, unknown> {
  return {
    ...(a.fields ? { fields: a.fields } : {}),
    methodPrefix: a.methodPrefix,
    lombok: a.lombok,
    ...(kind === "builder"
      ? { placement: a.placement ?? "inner" }
      : { style: a.style ?? "copy" }),
  };
}
