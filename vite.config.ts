import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 9000 belongs to the marketplace install this wallet was extracted from, so the
  // standalone copy owns 9010. strictPort keeps it deterministic: fail loudly instead
  // of drifting to another port.
  server: {
    port: 9010,
    strictPort: true,
    host: "127.0.0.1",
    // .state holds verification dumps and API probe scripts; writing there must not
    // reload the page out from under whoever is using the wallet.
    watch: { ignored: ["**/.state/**"] },
  },
  preview: { port: 9011, strictPort: true, host: "127.0.0.1" },
});
