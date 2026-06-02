import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { Providers } from "./providers.js";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element not found");

// Initial theme for the RainbowKit provider; App owns live theme switching.
const initialTheme =
  localStorage.getItem("custos-theme") ||
  (matchMedia("(prefers-color-scheme: dark)").matches ? "custos-dark" : "custos-light");

createRoot(rootEl).render(
  <StrictMode>
    <Providers theme={initialTheme}>
      <App />
    </Providers>
  </StrictMode>,
);
