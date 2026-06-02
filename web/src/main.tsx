import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { Providers } from "./providers.js";
import { resolveInitialTheme } from "./lib/theme.js";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element not found");

// Initial theme for the RainbowKit provider; App owns live theme switching.
const initialTheme = resolveInitialTheme(
  (k) => localStorage.getItem(k),
  matchMedia("(prefers-color-scheme: dark)").matches,
);

createRoot(rootEl).render(
  <StrictMode>
    <Providers theme={initialTheme}>
      <App />
    </Providers>
  </StrictMode>,
);
