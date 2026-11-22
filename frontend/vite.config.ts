import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// `npm run dev` serves the interface with hot reload and forwards everything
// else to a running Tabellar server. The built app gets its access token from
// the server; in development it is read from the Keychain here instead.
const SERVER = "http://127.0.0.1:4848";

function devToken(): Plugin {
  return {
    name: "tabellar-dev-token",
    apply: "serve",
    transformIndexHtml(html) {
      const r = spawnSync("security", ["find-generic-password", "-s", "tabellar", "-a", "access-token", "-w"], { encoding: "utf8" });
      const token = r.status === 0 ? Buffer.from(r.stdout.trim(), "hex").toString("utf8") : "";
      return html.replace("<head>", `<head><script>window.__TABELLAR_TOKEN__=${JSON.stringify(token)}</script>`);
    },
  };
}

const proxy: ProxyOptions = {
  target: SERVER,
  changeOrigin: true,
  // The server only accepts requests that come from its own origin.
  configure: (p) => p.on("proxyReq", (req) => req.setHeader("origin", SERVER)),
};

export default defineConfig({
  plugins: [devToken()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    fs: { allow: [".."] },
    proxy: { "/api": proxy, "/db": proxy, "/events": proxy, "/session": proxy, "/oauth": proxy },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
