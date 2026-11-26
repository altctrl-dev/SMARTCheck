//! Diagnostic: makes a PDF through the same code the app uses (run it as administrator too,
//! since that's how the app runs).
//!
//!   pdf_check <output.pdf>

#[tokio::main]
async fn main() {
    let out = std::env::args().nth(1).expect("usage: pdf_check <output.pdf>");
    let html = "<!doctype html><meta charset=utf-8><h1>SMARTCheck PDF check ✓ 25–38 °C 😊</h1>";
    let started = std::time::Instant::now();
    match smartcheck_lib::export::save_report(html, std::path::Path::new(&out), "pdf").await {
        Ok(()) => println!(
            "ok after {:.1} s, {} bytes, elevated={}",
            started.elapsed().as_secs_f64(),
            std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0),
            smartcheck_lib::elevation::is_elevated()
        ),
        Err(e) => println!("FAILED after {:.1} s: {e} (elevated={})", started.elapsed().as_secs_f64(), smartcheck_lib::elevation::is_elevated()),
    }
}
