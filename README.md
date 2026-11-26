# SMARTCheck

A Windows desktop app that checks internal and USB drives (hard drives, SATA SSDs, NVMe SSDs):
health score and status, plain-English findings, temperature history, USB link speed and the full
S.M.A.R.T. data, on one screen. Built with Tauri 2 (Rust core, React + TypeScript UI).

## How it works

- `src-tauri/src/windows_info.rs` lists disks, drive letters and the USB port each drive is on
  (Hi-Speed `HSnn` = USB 2.0, SuperSpeed `SSnn` = USB 3).
- `src-tauri/src/smartctl.rs` runs the bundled `smartctl.exe` (smartmontools) with `--json`,
  read-only and with a timeout, and parses the result.
- `src-tauri/src/health.rs` turns the raw data into a score, a status and findings, including
  "worse since the last check".
- `src-tauri/src/history.rs` keeps each drive's history (by serial number) in the app's data
  folder (`%APPDATA%\com.smartcheck.app\history`): a line per check when something changed or
  every 6 hours, the last full report (so unplugged drives still show), and speed test results.
- Self-tests (short/extended) run inside the drive via smartctl, after re-confirming the serial.
- `src-tauri/src/bench.rs` + `speedtest.rs` measure speed with unbuffered I/O (the same method as
  DiskSpd and CrystalDiskMark), on a 1 GB test file that is written with real data first and
  always deleted. Safety checks before starting (right drive, 3 GB free, no problem sectors, no
  self-test running) and a watchdog that stops at the first storage reset or disk error Windows
  logs (UASPStor/storport event 129, disk events 7/11/153).
- `src/` is the UI. Opened in a browser instead of the app, it shows preview data from
  `src/mock/` (real readings from 25 Nov 2026; self-tests are simulated).

Checked against Microsoft DiskSpd on a hard drive, sequential results match within ±1.5%.
DiskSpd itself is not bundled: its downloadable program is licensed for use on your own device
only, not for redistribution.

Reading S.M.A.R.T. data needs administrator rights: release builds ask once at launch; debug builds
run as the current user and offer "Restart as administrator".

## Development

```
npm install
npm run dev            # UI preview in the browser at http://localhost:1420 (preview data)
npm run tauri dev      # the desktop app (needs Rust + MSVC build tools)
cd src-tauri && cargo test
```

Browser preview only: `?drive=<serial>&details=findings|score|attributes|tests|history|drive`,
`&speed=open|run` and `&selftest=short|long` open a specific state.

Diagnostics (run from `src-tauri`):

```
cargo run --example scan_dump                       # full scan as JSON, nothing saved (run as admin)
cargo run --release --example bench_compare -- <folder> [prepare|<test id>]   # speed tests only
```

Regenerate the preview data from the real engine and the test fixtures:

```
cd src-tauri
set UPDATE_MOCK=1 && cargo test write_preview_data
```

**Smart App Control:** on PCs with Windows Smart App Control turned on, locally compiled programs
(including Rust build scripts and the app itself) are blocked unless signed by a trusted publisher.
Build on a machine without it, or build and sign in CI.

## Reports

**Export report** saves a branded A4 report as PDF or HTML: health, findings and next steps,
indicators, temperature, self-tests, the latest speed test and history, with optional "Prepared
by", "Customer / asset" and notes. PDFs are made by Microsoft Edge's built-in print-to-PDF
(headless, with a throwaway profile). **Copy summary** puts a plain-text summary on the clipboard
for tickets. The report is built in `src/report.ts`; `?drive=<serial>&report=show` renders it in
the browser preview.

## Branding (one installer per organization)

Each organization has a folder in `brands/` with `brand.json` (company name, app name, accent
colours, support contact, report footer) and `logo.svg`, plus an optional `icon.png` (1024 px;
otherwise the app icon is rendered from the logo).

```
npm run build:brand -- example   # installers for brands/example, in installers/example/
```

That applies the brand, makes the icons, builds the MSI and setup.exe (named after the
organization, with its own identifier so several can be installed side by side) and switches
back to the default brand. `npm run brand -- <name>` only switches the brand, e.g. for
`npm run tauri dev`.

The brand colour applies to buttons, links and highlights. Health colours (green, amber, red)
never change.

### Code signing

SMARTCheck is signed with a self-signed certificate: free, and fine for an internal tool, because
it's trusted only on PCs where it has been installed. Once per build PC:

```
powershell -ExecutionPolicy Bypass -File scripts\signing\new-cert.ps1 -Publisher "Your Company"
```

That makes a code-signing certificate (5 years, RSA 3072) in Current User > Personal; the
publisher name is what Windows shows as "Verified publisher" (default "SMARTCheck (internal)").
To change it later, run it again with `-Force` and the new name, then rebuild; PCs that trusted
the old certificate need the new one installed. It can only sign programs, not act as a
certificate authority or secure websites.
`build:brand` finds it and signs the app, the setup.exe and the MSI, timestamped so they stay valid
after it expires. It also puts `SMARTCheck-signing.cer` (the public part) and
`Install certificate.cmd` next to the installers.

**On each technician PC, once:** run `Install certificate.cmd` (it asks for administrator rights).
It adds the certificate to Trusted Root and Trusted Publishers, so the admin prompt shows the
publisher name as verified and any tampering with the files shows up.
The undo commands are at the top of the file.

Limits: Windows SmartScreen can still warn about files downloaded from the internet (copy them by
USB stick or network share instead), and PCs with Smart App Control on block programs that aren't
signed by a publicly trusted certificate. To sign with a commercial certificate or Azure Trusted
Signing instead, set one of these before `build:brand`:

```
set SMARTCHECK_SIGN_THUMBPRINT=<certificate thumbprint>    # certificate in the Windows store
set SMARTCHECK_SIGN_COMMAND=<command with %1>              # or a full signing command
set SMARTCHECK_TIMESTAMP_URL=http://timestamp.digicert.com # optional; "none" skips timestamping
```

The private key never leaves the certificate store. Back it up (or move signing to another PC)
with certmgr.msc > Personal > Certificates > "SMARTCheck code signing" > All Tasks > Export, with the
private key and a password. Signing settings are removed from `tauri.conf.json` after every build.

## Licences

`src-tauri/resources/smartmontools/` contains the unmodified `smartctl.exe` from smartmontools
(GPL-2.0), its licence (`COPYING.txt`) and where to get its source (`SOURCE.txt`). SMARTCheck runs
it as a separate program. Signed builds add SMARTCheck's code signature to the installed copy; the
program itself is unchanged.
