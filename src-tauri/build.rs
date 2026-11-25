fn main() {
    // Reading S.M.A.R.T. data needs administrator rights, so release builds ask for them
    // once at launch. Debug builds run as the current user so `tauri dev` keeps working;
    // the app offers "Restart as administrator" when it isn't elevated.
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let level = if profile == "release" { "requireAdministrator" } else { "asInvoker" };
    let manifest = include_str!("windows-app-manifest.xml").replace("{{LEVEL}}", level);

    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new().app_manifest(manifest));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
