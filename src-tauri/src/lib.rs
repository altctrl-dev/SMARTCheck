pub mod elevation;
pub mod health;
pub mod model;
pub mod scan;
pub mod smartctl;
pub mod windows_info;

use tauri::Manager;

/// Lists every disk and reads its health. Read-only.
#[tauri::command]
async fn scan_drives(app: tauri::AppHandle) -> Result<model::ScanResult, String> {
    let resource_dir = app.path().resource_dir().ok();
    Ok(scan::scan_all(resource_dir).await)
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
        .invoke_handler(tauri::generate_handler![scan_drives, restart_as_admin])
        .run(tauri::generate_context!())
        .expect("error while running SMARTCheck");
}
