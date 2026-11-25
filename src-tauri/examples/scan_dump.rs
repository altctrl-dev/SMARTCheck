//! Diagnostic: runs one full scan without the UI and prints the result as JSON.
//! Run from `src-tauri` as administrator:  cargo run --example scan_dump > scan.json

#[tokio::main]
async fn main() {
    // No history store: a diagnostic scan doesn't save anything.
    let result = smartcheck_lib::scan::scan_all(std::env::current_dir().ok(), None).await;
    println!("{}", serde_json::to_string_pretty(&result).expect("serialize scan result"));
}
