// Builds an organization's installers in one go.
//
//   npm run build:brand -- <name>
//
// 1. Applies brands/<name> (name, logo, colours, contact; see scripts/brand.mjs)
// 2. Makes the app icon from brands/<name>/icon.png, or renders it from logo.svg if there's none
// 3. Signs the installers if a certificate is configured (see "Signing" below), otherwise warns
// 4. Builds the MSI and setup.exe and copies them to installers/<name>/
// 5. Always switches back to the default brand afterwards, so the working copy stays clean
//
// Signing (optional, Windows):
//   SMARTCHECK_SIGN_THUMBPRINT  thumbprint of a code-signing certificate in the Windows certificate store
//   SMARTCHECK_TIMESTAMP_URL    timestamp server (default http://timestamp.digicert.com)
//   SMARTCHECK_SIGN_COMMAND     or a full signing command with %1 for the file (e.g. Azure Trusted Signing)
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { applyBrand, brandsDir, listBrands, readConf, readText, root, writeConf } from "./brand.mjs";

const name = process.argv[2];
if (!name || !listBrands().includes(name)) {
  console.error(`\n  Usage: npm run build:brand -- <name>\n  Available brands: ${listBrands().join(", ")}\n`);
  process.exit(1);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
// On Windows npx is a .cmd file, which needs the shell; quote any argument with spaces.
const run = (cmd, args) =>
  execFileSync(cmd, args.map((a) => (/\s/.test(a) ? `"${a}"` : a)), { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

function findEdge() {
  const bases = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  return bases.map((b) => join(b, "Microsoft", "Edge", "Application", "msedge.exe")).find((p) => existsSync(p));
}

/** Renders logo.svg to a 1024 px transparent PNG with headless Microsoft Edge. */
function renderIcon(svgPath, pngPath) {
  const edge = findEdge();
  if (!edge) throw new Error(`No icon.png in ${join(brandsDir, name)}, and Microsoft Edge (used to render logo.svg) wasn't found.`);
  const svg = readText(svgPath).replace(/<svg\b/, '<svg width="1024" height="1024"');
  const tmp = join(root, "src-tauri", "target", "brand-icon");
  mkdirSync(tmp, { recursive: true });
  const html = join(tmp, "icon.html");
  writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
  execFileSync(edge, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--default-background-color=00000000",
    "--window-size=1024,1024", `--user-data-dir=${join(tmp, "profile")}`, `--screenshot=${pngPath}`, pathToFileURL(html).href,
  ], { stdio: "ignore" });
  rmSync(tmp, { recursive: true, force: true });
}

function makeIcons(brandName) {
  const dir = join(brandsDir, brandName);
  let png = join(dir, "icon.png");
  if (!existsSync(png)) {
    png = join(root, "src-tauri", "target", `icon-${brandName}.png`);
    console.log(`  No brands/${brandName}/icon.png: rendering the app icon from logo.svg`);
    renderIcon(join(dir, "logo.svg"), png);
  }
  run(npx, ["tauri", "icon", png]);
  for (const extra of ["android", "ios"]) rmSync(join(root, "src-tauri", "icons", extra), { recursive: true, force: true });
}

function configureSigning() {
  const conf = readConf();
  const thumbprint = process.env.SMARTCHECK_SIGN_THUMBPRINT?.trim();
  const command = process.env.SMARTCHECK_SIGN_COMMAND?.trim();
  if (thumbprint) {
    conf.bundle.windows = {
      certificateThumbprint: thumbprint,
      digestAlgorithm: "sha256",
      timestampUrl: process.env.SMARTCHECK_TIMESTAMP_URL?.trim() || "http://timestamp.digicert.com",
    };
    console.log("  Signing with the certificate", thumbprint);
  } else if (command) {
    conf.bundle.windows = { signCommand: command };
    console.log("  Signing with SMARTCHECK_SIGN_COMMAND");
  } else {
    console.warn("\n  WARNING: building UNSIGNED installers. PCs with Smart App Control on will block them.\n");
  }
  writeConf(conf);
  return Boolean(thumbprint || command);
}

/** Signing settings never stay in tauri.conf.json, so they can't be committed by accident. */
function clearSigning() {
  const conf = readConf();
  delete conf.bundle.windows;
  writeConf(conf);
}

// The app icons are saved before a branded build and put back afterwards (regenerating them
// would produce byte-different files and leave the working copy dirty).
const iconsDir = join(root, "src-tauri", "icons");
const iconsBackup = join(root, "src-tauri", "target", "icons-backup");

function backupIcons() {
  rmSync(iconsBackup, { recursive: true, force: true });
  cpSync(iconsDir, iconsBackup, { recursive: true });
}

function restoreIcons() {
  if (!existsSync(iconsBackup)) return;
  rmSync(iconsDir, { recursive: true, force: true });
  cpSync(iconsBackup, iconsDir, { recursive: true });
  rmSync(iconsBackup, { recursive: true, force: true });
}

function restoreDefault() {
  console.log("\n  Restoring the default brand…");
  applyBrand("default");
  restoreIcons();
}

let exitCode = 0;
try {
  const { productName } = applyBrand(name);
  console.log(`\n  Building installers for "${productName}"\n`);
  // The committed icons are the default brand's; other brands get theirs for this build only.
  if (name !== "default") {
    backupIcons();
    makeIcons(name);
  }
  const signed = configureSigning();
  run(npx, ["tauri", "build"]);

  const out = join(root, "installers", name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const bundle = join(root, "src-tauri", "target", "release", "bundle");
  const copied = [];
  for (const kind of ["msi", "nsis"]) {
    const dir = join(bundle, kind);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.startsWith(productName) && /\.(msi|exe)$/i.test(f))) {
      copyFileSync(join(dir, f), join(out, f));
      copied.push(f);
    }
  }
  console.log(`\n  Done${signed ? "" : " (unsigned)"}: installers/${name}/`);
  for (const f of copied) console.log(`    ${f}`);
} catch (e) {
  console.error(`\n  Build failed: ${e.message}`);
  exitCode = 1;
} finally {
  clearSigning();
  if (name !== "default") restoreDefault();
}
process.exit(exitCode);
