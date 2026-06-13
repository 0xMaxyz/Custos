import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  test: {
    setupFiles: ["./src/test/setup.ts"],
    // Neutralize any local web/.env values (a developer's live-deployment config) so
    // tests stay deterministic — they exercise the fixture-fallback paths, which assume
    // these are unset. CI has no web/.env; this keeps local runs matching it.
    env: {
      VITE_VAULT_ADDRESS: "",
      VITE_AGENT_API_URL: "",
      VITE_AGENT_ID: "",
      VITE_DEMO_MODE: "",
    },
  },
});
