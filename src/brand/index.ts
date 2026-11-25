// Organization branding, baked in at build time. `npm run brand -- <name>` copies
// brands/<name>/ over this folder; each organization gets its own installer.
import brandJson from "./brand.json";
import logoUrl from "./logo.svg";

export interface Brand {
  companyName: string;
  appName: string;
  accent: { light: string; lightInk: string; dark: string; darkInk: string };
  support: { phone: string; email: string; website: string };
  reportFooter: string;
}

export const brand: Brand = brandJson;
export const logo: string = logoUrl;

/** "Acme IT Services · SMARTCheck", or just "SMARTCheck" when unbranded. */
export const displayName = brand.companyName ? `${brand.companyName} · ${brand.appName}` : brand.appName;

/** Sets the brand colour; status colours (green/amber/red) are never re-branded. */
export function applyBrand(): void {
  const css = `
    :root { --accent: ${brand.accent.light}; --accent-ink: ${brand.accent.lightInk}; }
    @media (prefers-color-scheme: dark) {
      :root { --accent: ${brand.accent.dark}; --accent-ink: ${brand.accent.darkInk}; }
    }`;
  const style = document.createElement("style");
  style.dataset.brand = "";
  style.textContent = css;
  document.head.appendChild(style);
  document.title = displayName;
}
