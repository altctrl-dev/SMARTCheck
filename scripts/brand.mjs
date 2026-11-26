// Switches the build to an organization's branding.
//
//   npm run brand -- <name>        uses brands/<name>/brand.json and brands/<name>/logo.svg
//
// Copies the brand into src/brand/ (shown in the app and on reports) and sets the product name,
// window title, publisher and app identifier in src-tauri/tauri.conf.json, so each organization
// gets its own separately named installer that can sit alongside the others.
// To build that installer in one go, use `npm run build:brand -- <name>`.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const brandsDir = join(root, "brands");
export const confPath = join(root, "src-tauri", "tauri.conf.json");

// Notepad and PowerShell may save a byte-order mark, which JSON.parse rejects.
export const readText = (p) => readFileSync(p, "utf8").replace(/^﻿/, "");
export const readConf = () => JSON.parse(readText(confPath));
export const writeConf = (conf) => writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

export function listBrands() {
  return readdirSync(brandsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Applies brands/<name>; returns the brand and the resulting product name. Throws on problems. */
export function applyBrand(name) {
  const dir = join(brandsDir, name);
  const jsonPath = join(dir, "brand.json");
  const logoPath = join(dir, "logo.svg");
  if (!existsSync(jsonPath)) throw new Error(`Missing ${jsonPath}`);
  if (!existsSync(logoPath)) throw new Error(`Missing ${logoPath}`);

  const brand = JSON.parse(readText(jsonPath));
  const hex = /^#[0-9a-f]{6}$/i;
  const problems = [];
  if (!brand.appName?.trim()) problems.push("appName is empty");
  for (const k of ["light", "lightInk", "dark", "darkInk"]) {
    if (!hex.test(brand.accent?.[k] ?? "")) problems.push(`accent.${k} must be a colour like #1c5cab`);
  }
  if (problems.length) throw new Error(`brands/${name}/brand.json: ${problems.join("; ")}`);

  writeFileSync(join(root, "src", "brand", "brand.json"), JSON.stringify(brand, null, 2) + "\n");
  writeFileSync(join(root, "src", "brand", "logo.svg"), readText(logoPath));

  const conf = readConf();
  const company = (brand.companyName ?? "").trim();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  conf.productName = company ? `${company} ${brand.appName}` : brand.appName;
  conf.identifier = name === "default" ? "com.smartcheck.app" : `com.smartcheck.${slug}`;
  conf.app.windows[0].title = company ? `${company} · ${brand.appName}` : brand.appName;
  conf.bundle.publisher = company || "SMARTCheck";
  writeConf(conf);
  return { brand, productName: conf.productName, identifier: conf.identifier };
}

// ---- Command line
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = process.argv[2];
  if (!name) {
    console.error(`\n  Usage: npm run brand -- <name>\n  Available brands: ${listBrands().join(", ")}\n`);
    process.exit(1);
  }
  try {
    const { productName, identifier } = applyBrand(name);
    console.log(`\n  Brand "${name}" applied.\n  Product name: ${productName}\n  Identifier:   ${identifier}\n`);
  } catch (e) {
    console.error(`\n  ${e.message}\n`);
    process.exit(1);
  }
}
