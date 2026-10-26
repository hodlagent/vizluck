//! Address book for the Settings tab.
//!
//! The book is deliberately just three string lists — one per chain — stored
//! as `addresses.json` in the app's data directory.  Validation and
//! case-insensitive comparison live in the UI / scanner; this module only
//! owns the file so the JSON stays hand-editable.
//!
//! Custom Tauri commands do not need a capability entry: capabilities gate
//! core/plugin commands, not commands registered by the app itself.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;

/// The three chains the Random tab can collide against.
///
/// `#[serde(default)]` means a hand-written JSON file may omit a chain, and a
/// missing file simply loads the empty default.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AddressBook {
    pub bitcoin: Vec<String>,
    pub ethereum: Vec<String>,
    pub solana: Vec<String>,
}

impl AddressBook {
    pub fn is_empty(&self) -> bool {
        self.bitcoin.is_empty() && self.ethereum.is_empty() && self.solana.is_empty()
    }
}

/// What `load_addresses` returns: the book plus the file it came from, so the
/// Settings tab can show the real path without a second round-trip.
#[derive(Serialize)]
pub struct AddressStore {
    pub path: String,
    pub book: AddressBook,
}

/// Resolve (and create) `<app_data_dir>/addresses.json`.
///
/// `app.path().app_data_dir()` is `$HOME/Library/Application Support/
/// com.jerin.vizluck` on macOS, `%APPDATA%\com.jerin.vizluck` on Windows and
/// `~/.local/share/com.jerin.vizluck` on Linux — the standard, user-writable
/// location for an app's own data.
fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir.join("addresses.json"))
}

/// Read a book from a specific file.  Split from `load_addresses` so the
/// persistence itself is unit-testable without an `AppHandle`.
fn read_book(path: &Path) -> Result<AddressBook, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("parse {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AddressBook::default()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// Write a book to a specific file, pretty-printed and newline-terminated so
/// it stays pleasant to edit by hand.
///
/// An existing file is copied to `addresses.json.bak` first.  `load_addresses`
/// intentionally still marks the (empty) book usable when the file is corrupt
/// or unreadable, so without this a single Save would silently destroy every
/// previously configured target.
fn write_book(path: &Path, book: &AddressBook) -> Result<(), String> {
    if path.exists() {
        let backup = path.with_extension("json.bak");
        std::fs::copy(path, &backup)
            .map_err(|e| format!("backup {}: {e}", backup.display()))?;
    }

    let mut text = serde_json::to_string_pretty(book)
        .map_err(|e| format!("serialize address book: {e}"))?;
    text.push('\n');
    std::fs::write(path, text).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Load the saved address book.  A missing file is not an error — it is the
/// first-run state, which loads as three empty lists.
///
/// Both file commands are `async` (thread-pool) so disk I/O never blocks the
/// window's main thread.
#[tauri::command(async)]
pub fn load_addresses(app: tauri::AppHandle) -> Result<AddressStore, String> {
    let path = store_path(&app)?;
    let book = read_book(&path)?;
    Ok(AddressStore {
        path: path.to_string_lossy().into_owned(),
        book,
    })
}

/// Write the address book to `addresses.json` and return the path written.
#[tauri::command(async)]
pub fn save_addresses(app: tauri::AppHandle, book: AddressBook) -> Result<String, String> {
    let path = store_path(&app)?;
    write_book(&path, &book)?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_chain_fields_default_to_empty() {
        let book: AddressBook = serde_json::from_str(r#"{"bitcoin":["1abc"]}"#).unwrap();
        assert_eq!(book.bitcoin, vec!["1abc".to_string()]);
        assert!(book.ethereum.is_empty());
        assert!(book.solana.is_empty());
    }

    #[test]
    fn empty_book_is_detected() {
        assert!(AddressBook::default().is_empty());
        let book = AddressBook {
            ethereum: vec!["0xabc".into()],
            ..AddressBook::default()
        };
        assert!(!book.is_empty());
    }

    #[test]
    fn book_roundtrips_through_json() {
        let path = std::env::temp_dir().join(format!(
            "vizluck-addresses-roundtrip-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);

        // First run: no file means the empty book, not an error.
        assert!(read_book(&path).unwrap().is_empty());

        let book = AddressBook {
            bitcoin: vec!["1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH".into()],
            ethereum: vec!["0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf".into()],
            solana: vec!["FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z".into()],
        };
        write_book(&path, &book).unwrap();

        let loaded = read_book(&path).unwrap();
        assert_eq!(loaded.bitcoin, book.bitcoin);
        assert_eq!(loaded.ethereum, book.ethereum);
        assert_eq!(loaded.solana, book.solana);

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.ends_with('\n'), "file is newline-terminated");
        assert!(text.contains("\"bitcoin\""), "keys are the stable chain names");

        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn overwriting_keeps_the_previous_file_as_a_backup() {
        let path = std::env::temp_dir().join(format!(
            "vizluck-addresses-backup-{}.json",
            std::process::id()
        ));
        let backup = path.with_extension("json.bak");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&backup);

        let first = AddressBook {
            bitcoin: vec!["1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH".into()],
            ..AddressBook::default()
        };
        write_book(&path, &first).unwrap();
        assert!(!backup.exists(), "nothing to back up on the first write");

        // Simulates a Save after a failed load: the UI's book is empty, but the
        // file on disk still holds the user's targets.
        write_book(&path, &AddressBook::default()).unwrap();
        assert!(backup.exists(), "the previous file was not backed up");
        let saved = read_book(&backup).unwrap();
        assert_eq!(saved.bitcoin, first.bitcoin);
        assert!(read_book(&path).unwrap().is_empty());

        std::fs::remove_file(&path).unwrap();
        std::fs::remove_file(&backup).unwrap();
    }

    #[test]
    fn corrupt_json_is_reported_rather_than_silently_emptied() {
        let path = std::env::temp_dir().join(format!(
            "vizluck-addresses-corrupt-{}.json",
            std::process::id()
        ));
        std::fs::write(&path, "{ not json").unwrap();
        let err = read_book(&path).unwrap_err();
        assert!(err.contains("parse"), "unexpected error: {err}");
        std::fs::remove_file(&path).unwrap();
    }
}
