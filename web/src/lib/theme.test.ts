import { describe, it, expect } from "vitest";
import { resolveInitialTheme, THEME_DARK, THEME_LIGHT } from "./theme";

const store = (m: Record<string, string>) => (k: string) => m[k] ?? null;

describe("resolveInitialTheme", () => {
  it("prefers the current custos-theme value", () => {
    expect(resolveInitialTheme(store({ "custos-theme": "custos-dark" }), false)).toBe("custos-dark");
    expect(resolveInitialTheme(store({ "custos-theme": "custos-light" }), true)).toBe("custos-light");
  });

  it("migrates the legacy sentinel-theme value (key + value remapped)", () => {
    expect(resolveInitialTheme(store({ "sentinel-theme": "sentinel-dark" }), false)).toBe(THEME_DARK);
    expect(resolveInitialTheme(store({ "sentinel-theme": "sentinel-light" }), true)).toBe(THEME_LIGHT);
  });

  it("prefers the new key over the legacy one when both exist", () => {
    const both = store({ "custos-theme": "custos-light", "sentinel-theme": "sentinel-dark" });
    expect(resolveInitialTheme(both, true)).toBe("custos-light");
  });

  it("falls back to the OS color-scheme preference when nothing is stored", () => {
    expect(resolveInitialTheme(store({}), true)).toBe(THEME_DARK);
    expect(resolveInitialTheme(store({}), false)).toBe(THEME_LIGHT);
  });
});
