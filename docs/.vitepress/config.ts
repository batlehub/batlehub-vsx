import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

// GitHub Pages serves the site under /<repo>/; the pages workflow sets it, local dev stays at the root.
const base = process.env.DOCS_BASE ?? "/";

export default withMermaid(
  defineConfig({
    title: "batlehub-vsx",
    description:
      "The BatleHub VS Code extensions: sign in, keep the credential fresh, browse and install where the editor's gallery cannot be repointed.",
    lang: "en-US",
    lastUpdated: true,
    cleanUrls: true,
    base,
    // The RFC template is a form with <placeholders> Vue would parse; it is copied by task rfc:new, not published.
    srcExclude: ["internal/**"],
    // The BatleHub theme (theme/): no sans, so the default theme's Inter is
    // swapped for an empty stylesheet rather than shipped unused.
    vite: {
      plugins: [
        {
          name: "batlehub:no-inter",
          enforce: "pre" as const,
          resolveId(source: string, importer?: string) {
            if (source.endsWith("styles/fonts.css") && importer?.includes("theme-default")) {
              return fileURLToPath(new URL("./theme/no-inter.css", import.meta.url));
            }
            return null;
          },
        },
      ],
    },
    head: [
      ["link", { rel: "icon", type: "image/svg+xml", href: base + "logo.svg" }],
      ["link", { rel: "preload", as: "font", type: "font/woff2", crossorigin: "", href: base + "fonts/silkscreen-700.woff2" }],
      ["link", { rel: "preload", as: "font", type: "font/woff2", crossorigin: "", href: base + "fonts/jetbrainsmono-latin.woff2" }],
      // tokens.css authors light under :root[data-theme="light"]; mirror VitePress's `.dark` class onto it.
      [
        "script",
        {},
        `(()=>{const e=document.documentElement,s=()=>e.setAttribute("data-theme",e.classList.contains("dark")?"dark":"light");s();new MutationObserver(s).observe(e,{attributes:true,attributeFilter:["class"]})})()`,
      ],
      ["meta", { name: "theme-color", content: "#dc2626" }],
    ],
    // The default highlighter palettes miss AA on the theme's grounds; the high-contrast pair clears both.
    markdown: {
      theme: { light: "github-light-high-contrast", dark: "github-dark-high-contrast" },
    },
    themeConfig: {
      logo: { light: "/logo-ink.svg", dark: "/logo-cream.svg" },
      nav: [
        { text: "Guide", link: "/guide/install" },
        { text: "Contributing", link: "/contributing/testing" },
        {
          text: "BatleHub",
          link: "https://batleforc.git.batleforc.fr/batlehub",
        },
      ],
      sidebar: [
        {
          text: "Guide",
          items: [
            { text: "Install", link: "/guide/install" },
            { text: "Broker mode", link: "/guide/broker" },
            { text: "Marketplace mode", link: "/guide/marketplace" },
            { text: "Settings and commands", link: "/guide/settings" },
            { text: "The BatleHub theme", link: "/guide/theme" },
            { text: "BatleHub Seasons", link: "/guide/seasons" },
          ],
        },
        {
          text: "Eclipse Che",
          items: [
            { text: "Overview, the Che pack", link: "/guide/che/" },
            { text: "Clipboard", link: "/guide/che/clipboard" },
            { text: "Notifications", link: "/guide/che/notify" },
            { text: "Remote SSH", link: "/guide/che/remote-ssh" },
          ],
        },
        {
          text: "Java",
          items: [
            { text: "Overview", link: "/guide/java/" },
            { text: "JDKs", link: "/guide/java/jdk" },
            { text: "The container's resources", link: "/guide/java/resources" },
            { text: "Maven, Gradle, the registry link", link: "/guide/java/build" },
            { text: "Run, menus, the panel", link: "/guide/java/run" },
            { text: "Settings and commands", link: "/guide/java/settings" },
            { text: "Clean removal", link: "/guide/java/removal" },
            { text: "Completion, and the chain", link: "/guide/java/editing" },
            { text: "Generate: builders, with methods", link: "/guide/java/generate" },
            { text: "The team's project configuration", link: "/guide/java/project-config" },
            { text: "The team's inspection profile", link: "/guide/java/inspections" },
            { text: "Spell checking", link: "/guide/java/spelling" },
            { text: "Agents (MCP)", link: "/guide/java/agents" },
            { text: "The command line", link: "/guide/java/engine" },
            { text: "Coming from IntelliJ", link: "/guide/java/intellij" },
            { text: "Groovy, Gradle DSL, Jenkinsfile", link: "/guide/java/groovy" },
            { text: "Kotlin", link: "/guide/java/kotlin" },
            { text: "Quarkus", link: "/guide/java/quarkus" },
            { text: "Spring Boot", link: "/guide/java/spring" },
          ],
        },
        {
          text: "Contributing",
          items: [
            { text: "Layout and tasks", link: "/contributing/layout" },
            { text: "Testing", link: "/contributing/testing" },
            { text: "Releasing", link: "/contributing/releasing" },
            { text: "Team diaries", link: "/diary/" },
          ],
        },
        // BEGIN rfc-sidebar — generated by `task rfc:index` from each RFC's header table — do not edit by hand
        {
          text: "In the works",
          items: [
            {
              text: "0004 — Run-config sources",
              link: "/rfc/0004-run-config-sources",
            },
            {
              text: "0007 — IntelliJ import",
              link: "/rfc/0007-intellij-import-full",
            },
            {
              text: "0008 — Kotlin",
              link: "/rfc/0008-kotlin-satellite",
            },
            {
              text: "0009 — Scala",
              link: "/rfc/0009-scala-satellite",
            },
            {
              text: "0012 — Chain completion",
              link: "/rfc/0012-chain-completion",
            },
            {
              text: "0013 — Spell checking",
              link: "/rfc/0013-spell-checking",
            },
            {
              text: "0016 — Inspections growth",
              link: "/rfc/0016-inspections-growth",
            },
          ],
        },
        {
          text: "Parked",
          items: [
            {
              text: "0017 — Server kinds",
              link: "/rfc/0017-server-kinds",
            },
            {
              text: "0018 — Rust syntactic tier",
              link: "/rfc/0018-rust-syntactic-tier",
            },
          ],
        },
        {
          text: "Settled",
          items: [
            {
              text: "0001 — Java extensions",
              link: "/rfc/0001-java-env",
            },
            {
              text: "0002 — Headless engine",
              link: "/rfc/0002-headless-engine-mcp",
            },
            {
              text: "0003 — Orchestrated runs",
              link: "/rfc/0003-server-run-step-kinds",
            },
            {
              text: "0005 — Inspection profiles",
              link: "/rfc/0005-shared-inspection-profiles",
            },
            {
              text: "0006 — Project config",
              link: "/rfc/0006-shared-project-config",
            },
            {
              text: "0010 — Spring Boot",
              link: "/rfc/0010-spring-boot-satellite",
            },
            {
              text: "0011 — Quarkus",
              link: "/rfc/0011-quarkus-satellite",
            },
            {
              text: "0014 — BatleHub theme",
              link: "/rfc/0014-batlehub-theme",
            },
            {
              text: "0015 — Generate shortcuts",
              link: "/rfc/0015-generate-shortcuts",
            },
            {
              text: "0019 — Seasons",
              link: "/rfc/0019-batlehub-seasons",
            },
          ],
        },
        // END rfc-sidebar
      ],
      socialLinks: [
        { icon: "github", link: "https://github.com/batleforc/batlehub-vsx" },
      ],
      search: { provider: "local" },
      outline: [2, 3],
    },
  }),
);
