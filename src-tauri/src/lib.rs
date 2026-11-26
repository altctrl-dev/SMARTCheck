pub mod bench;
pub mod elevation;
pub mod export;
pub mod health;
pub mod history;
pub mod model;
pub mod scan;
pub mod smartctl;
pub mod speedtest;
pub mod windows_info;

use std::path::PathBuf;

use tauri::Manager;

fn smartctl_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    smartctl::locate(app.path().resource_dir().ok()).ok_or_else(|| "The bundled smartctl program is missing.".to_string())
}

fn store(app: &tauri::AppHandle) -> Result<history::Store, String> {
    app.path().app_data_dir().map(history::Store::new).map_err(|e| format!("No folder for drive history: {e}"))
}

/// Lists every disk, reads its health, compares with history and saves the check. Read-only on the drives.
#[tauri::command]
async fn scan_drives(app: tauri::AppHandle) -> Result<model::ScanResult, String> {
    let resource_dir = app.path().resource_dir().ok();
    let store = store(&app).ok();
    Ok(scan::scan_all(resource_dir, store.as_ref()).await)
}

#[tauri::command]
fn get_history(app: tauri::AppHandle, key: String) -> Result<history::DriveHistory, String> {
    Ok(store(&app)?.history(&key))
}

/// Starts a short or extended self-test inside the drive, after confirming its serial number.
#[tauri::command]
async fn start_self_test(app: tauri::AppHandle, key: String, device_name: String, device_type: String, kind: String) -> Result<(), String> {
    let ctl = smartctl_path(&app)?;
    smartctl::verify_identity(&ctl, &device_name, &device_type, &key).await?;
    smartctl::start_self_test(&ctl, &device_name, &device_type, &kind).await
}

#[tauri::command]
async fn self_test_status(app: tauri::AppHandle, device_name: String, device_type: String) -> Result<smartctl::SelfTestStatus, String> {
    let ctl = smartctl_path(&app)?;
    smartctl::self_test_status(&ctl, &device_name, &device_type).await
}

#[tauri::command]
async fn abort_self_test(app: tauri::AppHandle, key: String, device_name: String, device_type: String) -> Result<(), String> {
    let ctl = smartctl_path(&app)?;
    smartctl::verify_identity(&ctl, &device_name, &device_type, &key).await?;
    smartctl::abort_self_test(&ctl, &device_name, &device_type).await
}

/// Runs the speed test; progress arrives as "speed-progress" events.
#[tauri::command]
async fn start_speed_test(app: tauri::AppHandle, request: speedtest::SpeedRequest) -> Result<history::SpeedRun, String> {
    use tauri::Emitter;
    let ctl = smartctl_path(&app)?;
    let store = store(&app)?;
    let window = app.clone();
    let tx: speedtest::Emit = std::sync::Arc::new(move |p| {
        let _ = window.emit("speed-progress", p);
    });
    speedtest::run(tx, ctl, store, request).await
}

#[tauri::command]
fn cancel_speed_test() {
    speedtest::cancel();
}

/// Saves a report built by the UI to `path`, as "html" or "pdf".
#[tauri::command]
async fn export_report(html: String, path: String, format: String) -> Result<(), String> {
    export::save_report(&html, std::path::Path::new(&path), &format).await
}

#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    export::show_in_folder(std::path::Path::new(&path))
}

/// Starts an elevated copy of the app (Windows asks for permission), then closes this one.
#[tauri::command]
fn restart_as_admin(app: tauri::AppHandle) -> Result<(), String> {
    elevation::relaunch_elevated()?;
    app.exit(0);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_drives,
            export_report,
            show_in_folder,
            get_history,
            start_self_test,
            self_test_status,
            abort_self_test,
            start_speed_test,
            cancel_speed_test,
            restart_as_admin
        ])
        .run(tauri::generate_context!())
        .expect("error while running SMARTCheck");
}
