fn main() {
    // The GUI's native commands, declared so that main.rs can grant them to the Runtime's page (a remote origin to
    // Tauri, which refuses such pages every app command that no capability allows).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["open_booth_login", "capture_booth_session"]),
    ))
    .expect("failed to run tauri-build");
}
