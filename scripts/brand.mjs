// Switches the build to an organization's branding.
//
//   npm run brand -- <name>        uses brands/<name>/brand.json and brands/<name>/logo.svg
//
// Copies the brand into src/brand/ (shown in the app) and sets the product name, window title,
// publisher and app identifier in src-tauri/tauri.conf.json, so each organization gets its own
// separately named installer that can sit alongside the others.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const brandsDir = join(root, "brands");
const name = process.argv[2];

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

if (!name) {
  const available = readdirSync(brandsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  fail(`Usage: npm run brand -- <name>\n  Available brands: ${available.join(", ")}`);
}

const dir = join(brandsDir, name);
const jsonPath = join(dir, "brand.json");
const logoPath = join(dir, "logo.svg");
if (!existsSync(jsonPath)) fail(`Missing ${jsonPath}`);
if (!existsSync(logoPath)) fail(`Missing ${logoPath}`);

// Notepad and PowerShell may save a byte-order mark, which JSON.parse rejects.
const readText = (p) => readFileSync(p, "utf8").replace(/^﻿/, "");
const brand = JSON.parse(readText(jsonPath));
const hex = /^#[0-9a-f]{6}$/i;
const problems = [];
if (!brand.appName?.trim()) problems.push("appName is empty");
for (const k of ["light", "lightInk", "dark", "darkInk"]) {
  if (!hex.test(brand.accent?.[k] ?? "")) problems.push(`accent.${k} must be a colour like #1c5cab`);
}
if (problems.length) fail(`brands/${name}/brand.json: ${problems.join("; ")}`);

writeFileSync(join(root, "src", "brand", "brand.json"), JSON.stringify(brand, null, 2) + "\n");
writeFileSync(join(root, "src", "brand", "logo.svg"), readText(logoPath));

const confPath = join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(readText(confPath));
const company = (brand.companyName ?? "").trim();
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
conf.productName = company ? `${company} ${brand.appName}` : brand.appName;
conf.identifier = name === "default" ? "com.smartcheck.app" : `com.smartcheck.${slug}`;
conf.app.windows[0].title = company ? `${company} · ${brand.appName}` : brand.appName;
conf.bundle.publisher = company || "SMARTCheck";
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

console.log(`\n  Brand "${name}" applied.`);
console.log(`  Product name: ${conf.productName}`);
console.log(`  Identifier:   ${conf.identifier}`);
if (existsSync(join(dir, "icon.png"))) {
  console.log(`  App icon:     run  npx tauri icon brands/${name}/icon.png  before building`);
}
console.log("");
