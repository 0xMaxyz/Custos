// Theme bootstrap + one-time migration. daisyUI theme names are `custos-light`/
// `custos-dark`; the persisted choice lives under `custos-theme`. Before the
// Sentinel -> Custos rename the key/values were `sentinel-theme` /
// `sentinel-{light,dark}`, so we read the legacy key once and remap its value.

export const THEME_KEY = "custos-theme";
export const THEME_LIGHT = "custos-light";
export const THEME_DARK = "custos-dark";

/** Legacy pre-rename storage key; migrated to {@link THEME_KEY} on first read. */
const LEGACY_THEME_KEY = "sentinel-theme";

/**
 * Resolve the initial theme name. Pure given its inputs (so it's testable and
 * shared by the pre-React bootstrap in `main.tsx` and the `App` state init):
 * the stored choice, else a one-time migration of the legacy key (value remapped
 * `sentinel-*` -> `custos-*`), else the OS color-scheme preference.
 */
export function resolveInitialTheme(
  getItem: (key: string) => string | null,
  prefersDark: boolean,
): string {
  const stored = getItem(THEME_KEY);
  if (stored) return stored;

  const legacy = getItem(LEGACY_THEME_KEY);
  if (legacy) return legacy.replace("sentinel-", "custos-");

  return prefersDark ? THEME_DARK : THEME_LIGHT;
}
