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
// Signing (Windows): uses the first of these that's available
//   SMARTCHECK_SIGN_THUMBPRINT  thumbprint of a code-signing certificate in the Windows certificate store
//   SMARTCHECK_SIGN_COMMAND     a full signing command with %1 for the file (e.g. Azure Trusted Signing)
//   the self-signed "SMARTCheck code signing" certificate made by scripts/signing/new-cert.ps1
//   SMARTCHECK_TIMESTAMP_URL    timestamp server (default http://timestamp.digicert.com, "none" to skip)
// With a certificate, installers/<name>/ also gets its public part (SMARTCheck-signing.cer) and
// "Install certificate.cmd", which technicians run once per PC to trust it.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const powershell = (script) =>
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();

const CERT_NAME = "SMARTCheck code signing";

/** The newest valid certificate made by scripts/signing/new-cert.ps1, if there is one. */
function findOwnCertificate() {
  if (process.platform !== "win32") return null;
  const out = powershell(
    `Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert | ` +
      `Where-Object { $_.FriendlyName -eq '${CERT_NAME}' -and $_.NotAfter -gt (Get-Date) -and $_.HasPrivateKey } | ` +
      `Sort-Object NotAfter -Descending | Select-Object -First 1 | ForEach-Object { $_.Thumbprint + '|' + $_.GetNameInfo('SimpleName', $false) }`,
  );
  if (!out) return null;
  const [thumbprint, publisher] = out.split("|");
  return { thumbprint, publisher };
}

const SIGN_KEYS = ["certificateThumbprint", "digestAlgorithm", "timestampUrl", "tsp", "signCommand"];

/** Returns the certificate used ({ thumbprint, publisher }), "command", or null (unsigned). */
function configureSigning() {
  const conf = readConf();
  const windows = (conf.bundle.windows ??= {});
  const command = process.env.SMARTCHECK_SIGN_COMMAND?.trim();
  const envThumb = process.env.SMARTCHECK_SIGN_THUMBPRINT?.trim();
  let cert = null;
  if (envThumb) cert = { thumbprint: envThumb.replace(/\s/g, "").toUpperCase(), publisher: "" };
  else if (!command) cert = findOwnCertificate();

  let result = null;
  if (cert) {
    const ts = process.env.SMARTCHECK_TIMESTAMP_URL?.trim() || "http://timestamp.digicert.com";
    Object.assign(windows, { certificateThumbprint: cert.thumbprint, digestAlgorithm: "sha256" });
    // A timestamp keeps signatures valid after the certificate expires.
    if (ts.toLowerCase() !== "none") Object.assign(windows, { timestampUrl: ts, tsp: true });
    console.log(`  Signing with the certificate ${cert.publisher ? `"${cert.publisher}" ` : ""}(${cert.thumbprint})`);
    result = cert;
  } else if (command) {
    windows.signCommand = command;
    console.log("  Signing with SMARTCHECK_SIGN_COMMAND");
    result = "command";
  } else {
    console.warn(
      "\n  WARNING: building UNSIGNED installers. Make a certificate with scripts/signing/new-cert.ps1 to sign them.\n",
    );
  }
  writeConf(conf);
  return result;
}

/** Signing settings never stay in tauri.conf.json, so they can't be committed by accident. */
function clearSigning() {
  const conf = readConf();
  if (conf.bundle.windows) {
    for (const k of SIGN_KEYS) delete conf.bundle.windows[k];
    if (Object.keys(conf.bundle.windows).length === 0) delete conf.bundle.windows;
  }
  writeConf(conf);
}

/** Puts the public certificate and "Install certificate.cmd" next to the installers. */
function addTrustFiles(out, cert) {
  const cer = join(out, "SMARTCheck-signing.cer");
  powershell(`Export-Certificate -Cert 'Cert:\\CurrentUser\\My\\${cert.thumbprint}' -FilePath '${cer.replace(/'/g, "''")}' -Type CERT | Out-Null`);
  const publisher = cert.publisher || powershell(`(Get-Item 'Cert:\\CurrentUser\\My\\${cert.thumbprint}').GetNameInfo('SimpleName', $false)`);
  const forCmd = (s) => s.replace(/[&|<>^]/g, "^$&").replace(/%/g, "%%");
  const script = readFileSync(join(root, "scripts", "signing", "install-certificate.cmd"), "utf8")
    .replaceAll("__PUBLISHER__", forCmd(publisher))
    .replaceAll("__THUMBPRINT__", cert.thumbprint)
    .replace(/\r?\n/g, "\r\n");
  writeFileSync(join(out, "Install certificate.cmd"), script);
}

/** Prints each installer's signature status. */
function reportSignatures(out, files) {
  for (const f of files) {
    const status = powershell(
      `$s = Get-AuthenticodeSignature -LiteralPath '${join(out, f).replace(/'/g, "''")}'; ` +
        `if ($s.SignerCertificate) { $s.Status.ToString() + '|' + $s.SignerCertificate.GetNameInfo('SimpleName', $false) + '|' + [bool]$s.TimeStamperCertificate } else { 'NotSigned' }`,
    );
    const [state, signer, stamped] = status.split("|");
    const note =
      state === "Valid" ? "trusted on this PC"
      : state === "UnknownError" ? "not trusted on this PC yet (run Install certificate.cmd)"
      : state;
    console.log(`    ${f}\n      ${signer ? `signed by "${signer}"${stamped === "True" ? ", timestamped" : ""}; ${note}` : "NOT signed"}`);
  }
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

// Signing also signs the bundled smartctl.exe, in place. The installed copy carries the signature;
// the copy in the repository stays exactly as smartmontools released it.
const resourcesDir = join(root, "src-tauri", "resources");
const resourcesBackup = join(root, "src-tauri", "target", "resources-backup");

function backupResources() {
  rmSync(resourcesBackup, { recursive: true, force: true });
  cpSync(resourcesDir, resourcesBackup, { recursive: true });
}

function restoreResources() {
  if (!existsSync(resourcesBackup)) return;
  rmSync(resourcesDir, { recursive: true, force: true });
  cpSync(resourcesBackup, resourcesDir, { recursive: true });
  rmSync(resourcesBackup, { recursive: true, force: true });
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
  const signing = configureSigning();
  if (signing) backupResources();
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
  console.log(`\n  Done${signing ? "" : " (unsigned)"}: installers/${name}/`);
  if (signing && process.platform === "win32") reportSignatures(out, copied);
  else for (const f of copied) console.log(`    ${f}`);
  if (signing && signing !== "command") {
    try {
      addTrustFiles(out, signing);
      console.log("    SMARTCheck-signing.cer + Install certificate.cmd (technicians run it once per PC)");
    } catch (e) {
      console.warn(`    Couldn't export the public certificate (${e.message.split("\n")[0]}); add it to installers/${name}/ yourself.`);
    }
  }
} catch (e) {
  console.error(`\n  Build failed: ${e.message}`);
  exitCode = 1;
} finally {
  clearSigning();
  restoreResources();
  if (name !== "default") restoreDefault();
}
process.exit(exitCode);
