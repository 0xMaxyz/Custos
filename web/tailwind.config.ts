import type { Config } from "tailwindcss";
import daisyui from "daisyui";

// Themes mirror UI.md §2.2 (purple accent, light + dark).
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [daisyui],
  daisyui: {
    themes: [
      {
        "custos-light": {
          primary: "#7c3aed",
          "primary-content": "#ffffff",
          secondary: "#64748b",
          accent: "#7c3aed",
          neutral: "#1e293b",
          "base-100": "#ffffff",
          "base-200": "#f8fafc",
          "base-300": "#e2e8f0",
          "base-content": "#0f172a",
          info: "#2563eb",
          success: "#16a34a",
          warning: "#d97706",
          error: "#dc2626",
          "--rounded-box": "0.75rem",
          "--rounded-btn": "0.5rem",
        },
        "custos-dark": {
          primary: "#8b5cf6",
          "primary-content": "#0b0710",
          secondary: "#94a3b8",
          accent: "#8b5cf6",
          neutral: "#0f172a",
          "base-100": "#0b1020",
          "base-200": "#111827",
          "base-300": "#1f2937",
          "base-content": "#e5e7eb",
          info: "#3b82f6",
          success: "#22c55e",
          warning: "#f59e0b",
          error: "#ef4444",
          "--rounded-box": "0.75rem",
          "--rounded-btn": "0.5rem",
        },
      },
    ],
    darkTheme: "custos-dark",
  },
};

export default config;
