import { defineConfig } from "vitepress";

export default defineConfig({
  title: "batlehub-vsx",
  description: "The BatleHub VS Code extensions: sign in, keep the credential fresh, browse and install where the editor's gallery cannot be repointed.",
  lang: "en-US",
  lastUpdated: true,
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/install" },
      { text: "Contributing", link: "/contributing/testing" },
      { text: "BatleHub", link: "https://batleforc.git.batleforc.fr/batlehub" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Install", link: "/guide/install" },
          { text: "Broker mode", link: "/guide/broker" },
          { text: "Marketplace mode", link: "/guide/marketplace" },
          { text: "Settings and commands", link: "/guide/settings" },
        ],
      },
      {
        text: "Contributing",
        items: [
          { text: "Layout and tasks", link: "/contributing/layout" },
          { text: "Testing", link: "/contributing/testing" },
          { text: "Releasing", link: "/contributing/releasing" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/batleforc/batlehub-vsx" }],
    search: { provider: "local" },
    outline: [2, 3],
  },
});
