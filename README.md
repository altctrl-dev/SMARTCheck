# SMARTCheck

A Windows desktop app that checks internal and USB drives (hard drives, SATA SSDs, NVMe SSDs):
health score and status, plain-English findings, temperature history, USB link speed and the full
S.M.A.R.T. data, on one screen. Built with Tauri 2 (Rust core, React + TypeScript UI).

## How it works

- `src-tauri/src/windows_info.rs` lists disks, drive letters and the USB port each drive is on
  (Hi-Speed `HSnn` = USB 2.0, SuperSpeed `SSnn` = USB 3).
- `src-tauri/src/smartctl.rs` runs the bundled `smartctl.exe` (smartmontools) with `--json`,
  read-only and with a timeout, and parses the result.
- `src-tauri/src/health.rs` turns the raw data into a score, a status and findings.
- `src/` is the UI. Opened in a browser instead of the app, it shows preview data from
  `src/mock/scan.json`.

Reading S.M.A.R.T. data needs administrator rights: release builds ask once at launch; debug builds
run as the current user and offer "Restart as administrator".

## Development

```
npm install
npm run dev            # UI preview in the browser at http://localhost:1420 (preview data)
npm run tauri dev      # the desktop app (needs Rust + MSVC build tools)
cd src-tauri && cargo test
```

Browser preview only: `?drive=<serial>&details=findings|score|attributes|tests|drive` opens a
specific state.

Regenerate the preview data from the real engine and the test fixtures:

```
cd src-tauri
set UPDATE_MOCK=1 && cargo test write_preview_data
```

**Smart App Control:** on PCs with Windows Smart App Control turned on, locally compiled programs
(including Rust build scripts and the app itself) are blocked unless signed by a trusted publisher.
Build on a machine without it, or build and sign in CI.

## Branding (one installer per organization)

Each organization has a folder in `brands/` with `brand.json` (company name, app name, accent
colours, support contact, report footer) and `logo.svg`, plus an optional `icon.png` (1024 px).

```
npm run brand -- example         # switch the build to brands/example
npx tauri icon brands/example/icon.png   # if the brand has its own app icon
npm run tauri build              # installer named after the organization
npm run brand -- default         # back to plain SMARTCheck
```

The brand colour applies to buttons, links and highlights. Health colours (green, amber, red)
never change.

## Licences

`src-tauri/resources/smartmontools/` contains the unmodified `smartctl.exe` from smartmontools
(GPL-2.0), its licence (`COPYING.txt`) and where to get its source (`SOURCE.txt`). SMARTCheck runs
it as a separate program.
