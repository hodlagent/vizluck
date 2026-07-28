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
pub mod btc;
pub mod gpu;
pub mod homepage;
pub mod puzzles;
pub mod progress;
pub mod workers;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            homepage::get_puzzles,
            homepage::random_and_derive,
            homepage::random_and_hash160,
            homepage::derive_full
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
