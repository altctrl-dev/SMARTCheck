//! Saves a report the UI has built: as HTML, or as PDF through Microsoft Edge's built-in
//! "print to PDF" (Edge is part of every Windows 10 and 11 PC). Edge runs headless with its own
//! throwaway profile, so it never touches the user's browser windows or data.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

fn find_edge() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for var in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(var) {
            candidates.push(PathBuf::from(base).join(r"Microsoft\Edge\Application\msedge.exe"));
        }
    }
    candidates.into_iter().find(|p| p.exists())
}

/// `C:\Temp\a b.html` -> `file:///C:/Temp/a%20b.html`
fn file_url(path: &Path) -> String {
    let mut url = String::from("file:///");
    for c in path.to_string_lossy().replace('\\', "/").chars() {
        match c {
            ' ' => url.push_str("%20"),
            '#' => url.push_str("%23"),
            '%' => url.push_str("%25"),
            '?' => url.push_str("%3F"),
            c => url.push(c),
        }
    }
    url
}

pub async fn save_report(html: &str, path: &Path, format: &str) -> Result<(), String> {
    match format {
        "html" => std::fs::write(path, html).map_err(|e| format!("Couldn’t save the report: {e}")),
        "pdf" => save_pdf(html, path).await,
        _ => Err("Unknown report format.".into()),
    }
}

async fn save_pdf(html: &str, path: &Path) -> Result<(), String> {
    let edge = find_edge().ok_or("Microsoft Edge wasn’t found, so a PDF can’t be made. Save the report as HTML instead.")?;
    let stamp = format!("{}-{}", std::process::id(), crate::scan::now_ms());
    let work = std::env::temp_dir().join(format!("smartcheck-pdf-{stamp}"));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let source = work.join("report.html");
    std::fs::write(&source, html).map_err(|e| e.to_string())?;
    // Write to a temporary file first, then move it into place, so a failed export never
    // leaves a half-written PDF where the user asked for it.
    let tmp_pdf = work.join("report.pdf");

    let mut cmd = tokio::process::Command::new(&edge);
    cmd.args([
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-pdf-header-footer",
        // SMARTCheck runs as administrator. Without this, Edge relaunches itself as a normal user
        // and exits at once, so the PDF appears only later, after we've stopped waiting.
        "--do-not-de-elevate",
        &format!("--user-data-dir={}", work.join("profile").display()),
        &format!("--print-to-pdf={}", tmp_pdf.display()),
        &file_url(&source),
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let result = async {
        let mut child = cmd.spawn().map_err(|e| format!("Couldn’t start Microsoft Edge: {e}"))?;
        tokio::time::timeout(Duration::from_secs(60), child.wait())
            .await
            .map_err(|_| "Making the PDF took too long.".to_string())?
            .map_err(|e| e.to_string())?;
        // Safety net in case Edge still hands the work to another process: wait (up to 15 s)
        // for a non-empty PDF whose size has stopped changing.
        let mut last = 0u64;
        let mut ready = false;
        for _ in 0..60 {
            let size = std::fs::metadata(&tmp_pdf).map(|m| m.len()).unwrap_or(0);
            if size > 0 && size == last {
                ready = true;
                break;
            }
            last = size;
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        if !ready {
            return Err("Microsoft Edge didn’t produce a PDF. Save the report as HTML instead.".to_string());
        }
        std::fs::copy(&tmp_pdf, path).map_err(|e| format!("Couldn’t save the PDF: {e}"))?;
        Ok(())
    }
    .await;
    let _ = std::fs::remove_dir_all(&work);
    result
}

/// Opens File Explorer with the file selected.
pub fn show_in_folder(path: &Path) -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_file_urls() {
        assert_eq!(file_url(Path::new(r"C:\Temp\a b#1.html")), "file:///C:/Temp/a%20b%231.html");
    }

    #[tokio::test]
    async fn saves_html_and_pdf() {
        let dir = std::env::temp_dir().join(format!("smartcheck-export-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let html = "<!doctype html><meta charset=utf-8><h1>Report ✓ 25–38 °C</h1>";
        let h = dir.join("r.html");
        save_report(html, &h, "html").await.unwrap();
        assert_eq!(std::fs::read_to_string(&h).unwrap(), html);
        if find_edge().is_some() {
            let p = dir.join("r.pdf");
            save_report(html, &p, "pdf").await.unwrap();
            let bytes = std::fs::read(&p).unwrap();
            assert!(bytes.starts_with(b"%PDF"), "not a PDF");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
