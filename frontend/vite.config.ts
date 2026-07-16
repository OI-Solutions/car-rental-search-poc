import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Loads VITE_API_BASE_URL from the project-root .env (envDir).
export default defineConfig({
  plugins: [react()],
  envDir: "..",
  // host:true binds on both IPv4 (127.0.0.1) and IPv6 (::1) so localhost resolves
  // either way in the browser. Local dev only.
  server: { port: 5173, host: true },
});
