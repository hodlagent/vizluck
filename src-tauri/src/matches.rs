//! One place that writes a found match to disk.
//!
//! All three scanning tabs — Hex, Game and Random — stop the moment a key hits
//! a target, build a [`MatchRecord`] and call [`save`].  This module owns the
//! directory, the timestamped filename and the text layout, so a match file
//! looks the same no matter which tab produced it.
//!
//! Files live in `<app_data_dir>/matches/`, next to `addresses.json`.  The old
//! location — the directory holding the executable — is inside a signed `.app`
//! bundle in production, where writes can fail, and may be replaced on update.
//!
//! `lib.rs` calls [`init`] once from the Tauri setup hook.  The directory is a
//! `OnceLock` rather than an argument because the Hex/Game commands run in tight
//! loops and carry no `AppHandle`.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

/// Where saved matches go.  `None` until `init` runs (e.g. in unit tests that
/// never start a Tauri app).
static DIR: OnceLock<PathBuf> = OnceLock::new();

/// Serialises filename choice + write.  The UI stops on a hit, but Hex's group
/// pass can have several derive calls in flight, and two hits in the same
/// second must not overwrite each other.
static SAVE_LOCK: Mutex<()> = Mutex::new(());

/// Point match saving at `dir`, creating it.  Calling this again with the same
/// path is a no-op; a different path is an error rather than a silent switch.
pub fn init(dir: PathBuf) -> Result<(), String> {
    create_private_dir(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    match DIR.set(dir) {
        Ok(()) => Ok(()),
        Err(dir) => {
            if DIR.get() == Some(&dir) {
                Ok(())
            } else {
                Err("match directory already initialised to a different path".to_string())
            }
        }
    }
}

/// A match ready to be written.
///
/// The tabs differ only in the fields they add; title, source, the private key
/// and the layout are shared.
pub struct MatchRecord {
    /// Heading, e.g. `PUZZLE MATCH FOUND`.
    pub title: String,
    /// Which tab produced it, e.g. `random`.
    pub source: String,
    /// Full 32-byte key, 64-char hex.
    pub private_key_hex: String,
    /// Extra `label → value` lines, in display order.
    pub details: Vec<(String, String)>,
}

/// Write `record` to a fresh timestamped file and return its absolute path.
pub fn save(record: &MatchRecord) -> Result<String, String> {
    let dir = DIR
        .get()
        .ok_or_else(|| "match saving is not initialised".to_string())?;
    save_to(dir, record)
}

/// The testable core of [`save`]: explicit directory, no global state.
fn save_to(dir: &Path, record: &MatchRecord) -> Result<String, String> {
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    create_private_dir(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let stamp = timestamp_label(SystemTime::now());
    let text = render(record, &stamp);
    let mut path = unique_path(dir, &stamp);

    // `create_new` leaves a tiny window for an external process to take the
    // name we picked; retrying with the next suffix costs nothing and never
    // overwrites someone else's file.
    for _ in 0..16 {
        match write_private(&path, &text) {
            Ok(()) => return Ok(path.to_string_lossy().into_owned()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                path = unique_path(dir, &stamp);
            }
            Err(e) => return Err(format!("write {}: {e}", path.display())),
        }
    }
    Err(format!(
        "could not find a free filename in {}",
        dir.display()
    ))
}

/// Create a directory only the owner can enter.  Match files contain private
/// keys; the default 0755 would expose them to other local users.
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        // `mode` only applies to directories created now; tighten one left by
        // an older build (or created by hand) too.
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

/// Create a file owner-read/write only, refusing to overwrite an existing one.
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(text.as_bytes())
}

/// `{stamp}.txt`, or `{stamp}-2.txt` … when that name is taken.
fn unique_path(dir: &Path, stamp: &str) -> PathBuf {
    let first = dir.join(format!("{stamp}.txt"));
    if !first.exists() {
        return first;
    }
    let mut n = 2u32;
    loop {
        let candidate = dir.join(format!("{stamp}-{n}.txt"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Plain text, aligned on the longest label.  Deliberately hand-readable: the
/// user may open this file days later without the app.
fn render(record: &MatchRecord, stamp: &str) -> String {
    const SEPARATOR: &str = "============================================";
    const RULE: &str = "--------------------------------------------";

    // Align values; never narrower than 16 so the header block looks tidy.
    let width = record
        .details
        .iter()
        .map(|(label, _)| label.chars().count())
        .chain(std::iter::once("Private Key".len()))
        .max()
        .unwrap_or(0)
        .max(16);

    let mut out = String::new();
    out.push_str(SEPARATOR);
    out.push('\n');
    out.push_str(&format!("vizluck — {}\n", record.title));
    out.push_str(SEPARATOR);
    out.push('\n');
    out.push_str(&format!(
        "{:<width$} : {stamp}\n",
        "Timestamp (UTC)",
        width = width
    ));
    out.push_str(&format!(
        "{:<width$} : {}\n",
        "Source",
        record.source,
        width = width
    ));
    out.push_str(RULE);
    out.push('\n');
    out.push_str(&format!(
        "{:<width$} : {}\n",
        "Private Key",
        record.private_key_hex,
        width = width
    ));
    for (label, value) in &record.details {
        out.push_str(&format!("{:<width$} : {}\n", label, value, width = width));
    }
    out.push_str(SEPARATOR);
    out.push('\n');
    out
}

/// Format a UNIX-epoch timestamp as a filesystem-safe, human-readable string:
/// `YYYYMMDD_HHMMSS`.  Falls back to raw seconds if anything is off.
fn timestamp_label(now: SystemTime) -> String {
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Break a UNIX timestamp into UTC date-time fields without pulling in chrono.
    let days = secs / 86400;
    let rem = secs % 86400;
    let h = rem / 3600;
    let m = (rem % 3600) / 60;
    let s = rem % 60;
    let (year, month, day) = days_to_ymd(days as i64);
    format!("{:04}{:02}{:02}_{:02}{:02}{:02}", year, month, day, h, m, s)
}

/// Convert days since the UNIX epoch (1970-01-01) into a `(year, month, day)`
/// tuple.  Standard Gregorian civil-date algorithm (Hinnant).
fn days_to_ymd(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i32 + era as i32 * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vizluck-matches-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn writes_a_readable_match_file() {
        let dir = temp_dir("record");
        let record = MatchRecord {
            title: "ADDRESS MATCH FOUND".to_string(),
            source: "random".to_string(),
            private_key_hex: "ab".repeat(32),
            details: vec![
                ("Chain".to_string(), "ethereum".to_string()),
                ("Configured".to_string(), "0xabc".to_string()),
            ],
        };

        let path = save_to(&dir, &record).unwrap();
        assert!(Path::new(&path).starts_with(&dir), "saved inside the given dir");

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("============================================\n"));
        assert!(text.contains("vizluck — ADDRESS MATCH FOUND"));
        assert!(text.contains("Source"));
        assert!(text.contains("random"));
        assert!(text.contains(&record.private_key_hex));
        assert!(text.contains("Chain"));
        assert!(text.contains("0xabc"));
        assert!(text.ends_with("============================================\n"));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn match_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("perms");
        let record = MatchRecord {
            title: "PUZZLE MATCH FOUND".to_string(),
            source: "hex (auto)".to_string(),
            private_key_hex: "cd".repeat(32),
            details: Vec::new(),
        };

        let path = save_to(&dir, &record).unwrap();
        let file_mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        let dir_mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(file_mode, 0o600, "private key file must not be group/world readable");
        assert_eq!(dir_mode, 0o700, "match directory must not be group/world accessible");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn same_second_matches_get_distinct_names() {
        let dir = temp_dir("collide");
        std::fs::create_dir_all(&dir).unwrap();
        let first = unique_path(&dir, "20260728_123456");
        std::fs::write(&first, "x").unwrap();

        let second = unique_path(&dir, "20260728_123456");
        assert_ne!(first, second);
        assert!(
            second.ends_with("20260728_123456-2.txt"),
            "unexpected: {}",
            second.display()
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn days_to_ymd_known_dates() {
        // 1970-01-01 = day 0
        assert_eq!(days_to_ymd(0), (1970, 1, 1));
        // 2000-01-01 = day 10957
        assert_eq!(days_to_ymd(10957), (2000, 1, 1));
        // 2026-07-28 = day 20662
        assert_eq!(days_to_ymd(20662), (2026, 7, 28));
        // 2024-02-29 (leap day)
        assert_eq!(days_to_ymd(19782), (2024, 2, 29));
    }

    #[test]
    fn timestamp_label_format() {
        // 2026-07-28 12:34:56 UTC = 1785242096 since epoch.
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1785242096);
        assert_eq!(timestamp_label(t), "20260728_123456");
    }
}
