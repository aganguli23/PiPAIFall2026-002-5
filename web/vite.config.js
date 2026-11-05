import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// App is served under /lotwise/ (nginx on the e2-micro). Dev server proxies the API to uvicorn on :8810.
export default defineConfig({
  base: "/lotwise/",
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      "/lotwise/api": { target: "http://127.0.0.1:8810", rewrite: (p) => p.replace(/^\/lotwise/, "") },
      "/lotwise/ws": { target: "ws://127.0.0.1:8810", ws: true, rewrite: (p) => p.replace(/^\/lotwise/, "") },
    },
  },
});
