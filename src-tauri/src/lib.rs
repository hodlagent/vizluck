use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// BTC address derivation helpers + GPU-accelerated secp256k1 scanner.
// These modules are adapted from the `luckfind` crate (Bitcoin dormant-address
// lottery). `btc` exposes address derivation; `gpu` exposes the wgpu/WGSL
// scanner backend; `puzzles`/`progress`/`workers` are the shared scanning
// primitives the GPU worker needs.
pub mod addresses;
pub mod btc;
pub mod collision;
pub mod gpu;
pub mod homepage;
pub mod matches;
pub mod puzzles;
pub mod progress;
pub mod workers;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Hex, Game and Random all save hits through `matches`, which needs its
        // directory once.  Keeping this in setup means a missing/unwritable
        // directory disables saving with a log line instead of crashing the app;
        // the hit is still shown and reported in the UI.
        .setup(|app| {
            match app.path().app_data_dir() {
                Ok(dir) => {
                    if let Err(e) = matches::init(dir.join("matches")) {
                        eprintln!("vizluck: match saving disabled: {e}");
                    }
                }
                Err(e) => eprintln!("vizluck: cannot resolve app data dir: {e}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            homepage::get_puzzles,
            homepage::random_and_derive,
            homepage::hex_scan_custom,
            homepage::hex_scan_group,
            homepage::derive_full,
            homepage::derive_group,
            addresses::load_addresses,
            addresses::save_addresses,
            collision::random_scan
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
