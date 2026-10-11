import DefaultTheme from "vitepress/theme";
// The BatleHub docs theme, copied from the BatleHub repository's
// `docs/.vitepress/theme` (batlehub.dev). Declare, map, use — in that order:
// `tokens.css` decides every colour and step, `vp-bridge.css` maps them onto
// VitePress's `--vp-*` contract, `custom.css` spends them.
import "./tokens.css";
import "./vp-bridge.css";
import "./custom.css";
import type { Theme } from "vitepress";

// A scrolling code block has to be reachable by keyboard (WCAG 2.1.1); the
// default theme gives `pre` no tabindex and CSS cannot add one.
function makeCodeBlocksFocusable() {
  for (const pre of document.querySelectorAll<HTMLElement>(".vp-doc pre")) {
    if (!pre.hasAttribute("tabindex")) pre.setAttribute("tabindex", "0");
  }
}

export default {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    if (typeof window !== "undefined") {
      const run = () => requestAnimationFrame(makeCodeBlocksFocusable);
      router.onAfterRouteChange = run;
      run();
    }
  },
} satisfies Theme;
