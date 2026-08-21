//! Homepage backend: puzzle listing, range-constrained random key generation,
//! BIP32 master key derivation, and address derivation.
//!
//! Exposes two Tauri commands used by the homepage UI:
//!   - `get_puzzles`        → the dropdown dataset
//!   - `random_and_derive`  → sample a random key in a range + derive everything

use rand::TryRng;
use serde::Serialize;

// ── Response types ───────────────────────────────────────────────────────────

/// One embedded puzzle, shaped for the dropdown.
#[derive(Serialize)]
pub struct PuzzleInfo {
    pub puzzle_number: u32,
    pub hex_bytes_len: u8,
    /// Inclusive start, low bytes, no `0x` prefix (matches the dataset display).
    pub start_hex: String,
    /// Inclusive end, low bytes, no `0x` prefix.
    pub end_hex: String,
    /// 40-char hex target hash160 (compressed-pubkey hash).
    pub hash160: String,
    /// Inclusive lower bound of the top byte (the first grid cell).  Equals
    /// `start`'s byte at `top_byte_idx`.
    pub start_top: u8,
    /// Exclusive upper bound of the top byte.  A value of 0 encodes the overflow
    /// case where the range ends at 0xFF…FF, so the real inclusive upper bound is
    /// then 0xFF.  See `PuzzleRange::end_top`.
    pub end_top: u8,
}

/// Everything the frontend needs to render for one sampled key.
#[derive(Serialize)]
pub struct KeyInfo {
    /// Full 32-byte private key, 64-char hex.
    pub private_key_hex: String,
    /// BIP32 master extended private key (xprv / tprv).
    pub xprv: String,
    /// BIP32 master extended public key (xpub / tpub).
    pub xpub: String,
    /// Compressed public key, 66-char hex.
    pub compressed_public_key: String,
    /// Uncompressed public key, 130-char hex (starts with `04`).
    pub uncompressed_public_key: String,
    /// Legacy P2PKH address derived from the compressed pubkey.
    pub compressed_legacy_address: String,
    /// Legacy P2PKH address derived from the uncompressed pubkey.
    pub uncompressed_legacy_address: String,
    /// 40-char hex hash160 of the compressed pubkey (for puzzle comparison).
    pub compressed_hash160: String,
    /// 40-char hex hash160 of the uncompressed pubkey (for puzzle comparison).
    pub uncompressed_hash160: String,
    /// `None` = custom range (no emoji); `Some(matched)` = puzzle comparison result.
    pub address_match: Option<bool>,
    /// When a match is found, the absolute path of the file the result was saved
    /// to (e.g. `/path/to/{timestamp}.txt`).  `None` when no match was saved.
    pub save_path: Option<String>,
}

// ── Range specification ──────────────────────────────────────────────────────

/// Where to sample the random key from.  Serde internal-tagged: the frontend
/// sends `{ "type": "puzzle", "puzzle_number": 71 }` or
/// `{ "type": "custom", "start_hex": "…", "end_hex": "…" }`.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RangeSpec {
    Puzzle { puzzle_number: u32 },
    Custom { start_hex: String, end_hex: String },
}

// ── 32-byte big-endian arithmetic ────────────────────────────────────────────
//
// All values are 256-bit integers stored as big-endian `[u8; 32]`.

/// Big-endian `<` (re-exported from puzzles.rs).
fn be_lt(a: &[u8; 32], b: &[u8; 32]) -> bool {
    crate::puzzles::be_lt(a, b)
}

/// Big-endian `a - b`, assuming `a >= b`.
fn be_sub(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let diff = a[i] as i16 - b[i] as i16 - borrow;
        if diff < 0 {
            out[i] = (diff + 256) as u8;
            borrow = 1;
        } else {
            out[i] = diff as u8;
            borrow = 0;
        }
    }
    out
}

/// Big-endian `a + b`.  Caller guarantees the sum is < 2^256 (carry discarded).
fn be_add(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut carry = 0u16;
    for i in (0..32).rev() {
        let sum = a[i] as u16 + b[i] as u16 + carry;
        out[i] = sum as u8;
        carry = sum >> 8;
    }
    out
}

/// Big-endian increment (`a + 1`).  Returns `None` on overflow (0xFF…FF + 1).
fn be_try_increment(a: &[u8; 32]) -> Option<[u8; 32]> {
    let mut out = *a;
    let mut carry = 1u16;
    for i in (0..32).rev() {
        if carry == 0 {
            break;
        }
        let sum = out[i] as u16 + carry;
        out[i] = sum as u8;
        carry = sum >> 8;
    }
    if carry == 0 { Some(out) } else { None }
}

/// Position of the highest set bit plus one (i.e. `ceil(log2(a+1))`), or 0 if
/// `a == 0`.  Used to size the rejection sampler.
fn be_bit_length(a: &[u8; 32]) -> usize {
    for (i, &b) in a.iter().enumerate() {
        if b != 0 {
            return (32 - i - 1) * 8 + (8 - b.leading_zeros() as usize);
        }
    }
    0
}

// ── Random sampling ──────────────────────────────────────────────────────────

/// Uniform random integer in `[0, r_max)` via k-bit rejection sampling, where
/// `k = bit_length(r_max)`.  Acceptance rate is >= 50% because
/// `r_max >= 2^(k-1)`.
fn random_below(r_max: &[u8; 32]) -> [u8; 32] {
    let k = be_bit_length(r_max); // 1..=256
    let zero_bits = 256 - k;
    let zero_full_bytes = zero_bits / 8;
    let zero_rem = zero_bits % 8;

    let mut r = [0u8; 32];
    loop {
        rand::rngs::SysRng
            .try_fill_bytes(&mut r)
            .expect("OS entropy source always available");
        // Zero the top `zero_bits` bits so `r < 2^k`.
        for i in 0..zero_full_bytes {
            r[i] = 0;
        }
        if zero_rem > 0 {
            r[zero_full_bytes] &= 0xffu8 >> zero_rem;
        }
        if be_lt(&r, r_max) {
            return r;
        }
    }
}

/// Uniform random key in `[lo, hi_excl)` where `lo < hi_excl`.  `hi_excl` is the
/// exclusive upper bound.
fn random_key_in_range(lo: &[u8; 32], hi_excl: &[u8; 32]) -> Result<[u8; 32], String> {
    if !be_lt(lo, hi_excl) {
        return Err("empty range: lo >= hi".to_string());
    }
    let r = be_sub(hi_excl, lo); // R = hi - lo, R > 0
    let sample = random_below(&r); // uniform [0, R)
    Ok(be_add(lo, &sample))
}

/// Uniform random key in `[lo, 2^256)` — used when the inclusive end is
/// 0xFF…FF and the exclusive bound would overflow.
fn random_key_from(lo: &[u8; 32]) -> [u8; 32] {
    let mut r = [0u8; 32];
    loop {
        rand::rngs::SysRng
            .try_fill_bytes(&mut r)
            .expect("OS entropy source always available");
        if !be_lt(&r, lo) {
            // r >= lo
            return r;
        }
    }
}

// ── BIP32 master key derivation ──────────────────────────────────────────────
//
// I = HMAC-SHA512(key = b"Bitcoin seed", data = private_key_bytes)
//   left  32 bytes -> master private key
//   right 32 bytes -> chain code
//
// Reference: scripts/bip32_master_key-2.py, scripts/private_key_to_bip32.py.

fn master_key_from_seed(seed: &[u8]) -> ([u8; 32], [u8; 32]) {
    use hmac::Mac;
    type HmacSha512 = hmac::Hmac<sha2::Sha512>;

    let mut mac = HmacSha512::new_from_slice(b"Bitcoin seed")
        .expect("HMAC key b\"Bitcoin seed\" is a valid length");
    mac.update(seed);
    let result = mac.finalize().into_bytes();

    let mut key = [0u8; 32];
    let mut chain = [0u8; 32];
    key.copy_from_slice(&result[..32]);
    chain.copy_from_slice(&result[32..]);
    (key, chain)
}

/// Serialize a BIP32 extended private key (xprv, mainnet).
fn serialize_xprv(chain_code: &[u8; 32], privkey: &[u8; 32]) -> String {
    let version = [0x04, 0x88, 0xAD, 0xE4]; // mainnet xprv
    let mut payload = Vec::with_capacity(78);
    payload.extend_from_slice(&version);
    payload.push(0); // depth
    payload.extend_from_slice(&[0; 4]); // parent fingerprint
    payload.extend_from_slice(&[0; 4]); // child number
    payload.extend_from_slice(chain_code);
    payload.push(0); // leading 0x00 for private key
    payload.extend_from_slice(privkey);
    crate::btc::base58check(&payload)
}

/// Serialize a BIP32 extended public key (xpub, mainnet).
fn serialize_xpub(chain_code: &[u8; 32], compressed_pubkey: &[u8; 33]) -> String {
    let version = [0x04, 0x88, 0xB2, 0x1E]; // mainnet xpub
    let mut payload = Vec::with_capacity(78);
    payload.extend_from_slice(&version);
    payload.push(0); // depth
    payload.extend_from_slice(&[0; 4]); // parent fingerprint
    payload.extend_from_slice(&[0; 4]); // child number
    payload.extend_from_slice(chain_code);
    payload.extend_from_slice(compressed_pubkey); // 33 bytes, no leading 0x00
    crate::btc::base58check(&payload)
}

// ── Lightweight result for auto mode ──────────────────────────────────────────

/// Everything auto mode needs per tick: the key (for the grid), its hash160 (for
/// the puzzle comparison), and — on the rare match — where it was saved.
#[derive(Serialize)]
pub struct AutoKeyInfo {
    /// Full 32-byte private key, 64-char hex (drives the grid).
    pub private_key_hex: String,
    /// 40-char hex hash160 of the compressed pubkey (for puzzle comparison).
    pub compressed_hash160: String,
    /// 40-char hex hash160 of the uncompressed pubkey (for puzzle comparison).
    pub uncompressed_hash160: String,
    /// `None` = custom range; `Some(matched)` = puzzle comparison result.
    pub address_match: Option<bool>,
    /// Absolute path saved to on a match, `None` otherwise.
    pub save_path: Option<String>,
}

// ── Core + full derivation ──────────────────────────────────────────────────

/// The unavoidable core: turn a private key into both its compressed and
/// uncompressed pubkey hash160 values.  Scalar multiplication is required to
/// compute a hash160, so this is the one cost every check must pay.
/// Returns `((compressed_h160, uncompressed_h160), public_key)` — the
/// `PublicKey` lets the full path reuse the already-computed point.
fn compute_both_hash160(
    key: &[u8; 32],
) -> Result<(([u8; 20], [u8; 20]), secp256k1::PublicKey), String> {
    use secp256k1::{PublicKey, Secp256k1, SecretKey};
    let secp = Secp256k1::new();
    let sk = SecretKey::from_byte_array(*key).map_err(|e| format!("invalid scalar: {e}"))?;
    let pk = PublicKey::from_secret_key(&secp, &sk);
    let h160_compressed = crate::btc::hash160(&pk.serialize());
    let h160_uncompressed = crate::btc::hash160(&pk.serialize_uncompressed());
    Ok(((h160_compressed, h160_uncompressed), pk))
}

/// Derive every display field from a 32-byte private key.  Returns `Err` if the
/// key is not a valid secp256k1 scalar, or if the BIP32 master key isn't a valid
/// scalar (≈2^-128) — the caller regenerates in that case.
///
/// Both compressed and uncompressed pubkey hash160 values are checked against
/// the puzzle target — a match on either format counts as a hit.
fn derive_key_info(
    key: &[u8; 32],
    expected_hash160: Option<[u8; 20]>,
) -> Result<KeyInfo, String> {
    use secp256k1::SecretKey;

    let ((h160_compressed, h160_uncompressed), pk) = compute_both_hash160(key)?;

    let compressed = pk.serialize(); // 33 bytes
    let uncompressed = pk.serialize_uncompressed(); // 65 bytes
    let compressed_hex = hex::encode(compressed);
    let uncompressed_hex = hex::encode(uncompressed);
    let private_key_hex = hex::encode(key);
    let compressed_hash160_hex = hex::encode(h160_compressed);
    let uncompressed_hash160_hex = hex::encode(h160_uncompressed);

    let compressed_legacy_address = crate::btc::p2pkh(&compressed);
    let uncompressed_legacy_address = crate::btc::p2pkh(&uncompressed);

    // BIP32 master key.  The HMAC left half must also be a valid scalar; if not,
    // signal the caller to regenerate (probability ≈ 2^-128).
    let (master_key, chain_code) = master_key_from_seed(key);
    SecretKey::from_byte_array(master_key)
        .map_err(|_| "BIP32 master key is not a valid scalar".to_string())?;
    let xprv = serialize_xprv(&chain_code, &master_key);
    let xpub = serialize_xpub(&chain_code, &compressed);

    let address_match =
        expected_hash160.map(|target| h160_compressed == target || h160_uncompressed == target);

    Ok(KeyInfo {
        private_key_hex,
        xprv,
        xpub,
        compressed_public_key: compressed_hex,
        uncompressed_public_key: uncompressed_hex,
        compressed_legacy_address,
        uncompressed_legacy_address,
        compressed_hash160: compressed_hash160_hex,
        uncompressed_hash160: uncompressed_hash160_hex,
        address_match,
        save_path: None,
    })
}

// ── Match persistence ─────────────────────────────────────────────────────────
//
// When a generated key hits a puzzle's target hash160, we persist the full result
// to `{timestamp}.txt` next to the executable so it survives even if the app
// closes.  Writing goes through the standard library (`std::fs`), not the Tauri
// fs plugin, so no capability changes are required.

/// Format a UNIX-epoch timestamp as a filesystem-safe, human-readable string:
/// `YYYYMMDD_HHMMSS`.  Falls back to raw seconds if anything is off.
fn timestamp_label(now: std::time::SystemTime) -> String {
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
    (y, m as u32, d as u32)
}

/// Write a matched key's full details to `{timestamp}.txt` in the directory that
/// holds the running executable.  Returns the absolute path written to.
fn save_match(info: &KeyInfo, puzzle_number: u32, network: &str) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = exe.parent().ok_or_else(|| "exe has no parent dir".to_string())?;
    let label = timestamp_label(std::time::SystemTime::now());
    let path = dir.join(format!("{label}.txt"));

    let match_line = match info.address_match {
        Some(true) => "YES ✅",
        Some(false) => "no",
        None => "n/a",
    };
    let content = format!(
        "============================================\n\
         vizluck — PUZZLE MATCH FOUND\n\
         ============================================\n\
         Timestamp (UTC) : {ts}\n\
         Puzzle          : #{puzzle}\n\
         Network         : {net}\n\
         Match           : {match_line}\n\
         --------------------------------------------\n\
         Private Key     : {pk}\n\
         xprv            : {xprv}\n\
         xpub            : {xpub}\n\
         Public Key (compressed)   : {pk_comp}\n\
         Public Key (uncompressed) : {pk_uncomp}\n\
         Legacy Address (compressed)   : {addr_comp}\n\
         Legacy Address (uncompressed) : {addr_uncomp}\n\
         hash160 (compressed)   : {h160_comp}\n\
         hash160 (uncompressed) : {h160_uncomp}\n\
         ============================================\n",
        ts = label,
        puzzle = puzzle_number,
        net = network,
        match_line = match_line,
        pk = info.private_key_hex,
        xprv = info.xprv,
        xpub = info.xpub,
        pk_comp = info.compressed_public_key,
        pk_uncomp = info.uncompressed_public_key,
        addr_comp = info.compressed_legacy_address,
        addr_uncomp = info.uncompressed_legacy_address,
        h160_comp = info.compressed_hash160,
        h160_uncomp = info.uncompressed_hash160,
    );

    std::fs::write(&path, content).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

// ── Hex parsing ──────────────────────────────────────────────────────────────

/// Parse a hex string (low bytes, optional `0x` prefix, odd-length padded with a
/// leading 0) into a 32-byte big-endian key.  High bytes are zeroed.
fn parse_lo_hex(s: &str) -> Result<[u8; 32], String> {
    let s = s.trim();
    let s = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    if s.is_empty() {
        return Err("empty hex string".to_string());
    }
    if s.len() > 64 {
        return Err("hex string too long (max 64 chars)".to_string());
    }
    if !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid hex character".to_string());
    }
    // Pad odd length with a leading 0.
    let s = if s.len() % 2 == 1 {
        format!("0{}", s)
    } else {
        s.to_string()
    };
    let bytes = hex::decode(&s).map_err(|e| format!("hex decode error: {}", e))?;
    if bytes.len() > 32 {
        return Err("hex value too large (max 32 bytes)".to_string());
    }
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    Ok(out)
}

/// Resolve a `RangeSpec` into `([lo, hi_excl), optional target hash160)`.
/// `hi_excl` is the exclusive upper bound.  When the inclusive end is 0xFF…FF,
/// `hi_excl` wraps to `[0; 32]` as an overflow marker (handled by the sampler).
fn resolve_range(spec: &RangeSpec) -> Result<([u8; 32], [u8; 32], Option<[u8; 20]>), String> {
    match spec {
        RangeSpec::Puzzle { puzzle_number } => {
            let ps = crate::puzzles::puzzle_set();
            let range = ps
                .ranges()
                .iter()
                .find(|r| r.puzzle_number == *puzzle_number)
                .ok_or_else(|| format!("puzzle {} not found", puzzle_number))?;
            // `range.end` is already exclusive.
            Ok((range.start, range.end, Some(range.hash160)))
        }
        RangeSpec::Custom { start_hex, end_hex } => {
            let lo = parse_lo_hex(start_hex)?;
            let end_inc = parse_lo_hex(end_hex)?;
            if be_lt(&end_inc, &lo) {
                return Err("start must be <= end".to_string());
            }
            // Exclusive upper bound = inclusive end + 1, unless it overflows.
            let hi_excl = match be_try_increment(&end_inc) {
                Some(hi) => hi,
                None => [0u8; 32], // end was 0xFF…FF → exclusive bound is 2^256
            };
            Ok((lo, hi_excl, None))
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Return the embedded puzzle table for the dropdown.
#[tauri::command]
pub fn get_puzzles() -> Vec<PuzzleInfo> {
    let ps = crate::puzzles::puzzle_set();
    let one = {
        let mut o = [0u8; 32];
        o[31] = 1;
        o
    };
    ps.ranges()
        .iter()
        .map(|r| {
            let hbl = r.hex_bytes_len as usize;
            // start: low hbl bytes of r.start, no 0x prefix.
            let start_hex = hex::encode(&r.start[32 - hbl..]);
            // end is stored exclusive; convert to inclusive for display.
            let end_incl = be_sub(&r.end, &one);
            let end_hex = hex::encode(&end_incl[32 - hbl..]);
            PuzzleInfo {
                puzzle_number: r.puzzle_number,
                hex_bytes_len: r.hex_bytes_len,
                start_hex,
                end_hex,
                hash160: hex::encode(r.hash160),
                start_top: r.start_top,
                end_top: r.end_top,
            }
        })
        .collect()
}

/// Sample a random key in the given range and derive all display fields.
#[tauri::command]
pub fn random_and_derive(
    spec: RangeSpec,
    _network: String,
) -> Result<KeyInfo, String> {
    let (lo, hi_excl, expected_hash160) = resolve_range(&spec)?;

    // Puzzle number for the save file (0 for custom ranges — never matched anyway).
    let puzzle_number = match &spec {
        RangeSpec::Puzzle { puzzle_number } => *puzzle_number,
        RangeSpec::Custom { .. } => 0,
    };

    // Sample + derive, retrying on astronomically-unlikely invalid scalars.
    // Puzzle ranges are < 2^160 so they never fail; custom ranges spanning near
    // 2^256 fail ~50% of the time on the input scalar and retry.
    let mut attempts = 0;
    loop {
        let key = if be_lt(&lo, &hi_excl) {
            random_key_in_range(&lo, &hi_excl)?
        } else {
            // lo == hi_excl is the overflow marker: range is [lo, 2^256).
            random_key_from(&lo)
        };
        match derive_key_info(&key, expected_hash160) {
            Ok(mut info) => {
                // On a puzzle hit, persist the full result next to the exe.
                if info.address_match == Some(true) {
                    match save_match(&info, puzzle_number, "mainnet") {
                        Ok(path) => info.save_path = Some(path),
                        Err(e) => info.save_path = Some(format!("ERROR: {e}")),
                    }
                }
                return Ok(info);
            }
            Err(_) => {
                attempts += 1;
                if attempts >= 1000 {
                    return Err(
                        "failed to generate a valid key after 1000 attempts (degenerate range?)"
                            .to_string(),
                    );
                }
            }
        }
    }
}

/// Lightweight auto-mode tick: sample a random key in the range and compute both
/// its compressed and uncompressed pubkey hash160 (plus the puzzle comparison).
/// Skips address encoding and BIP32 — everything the grid doesn't need.
/// On a match the result is saved and the path returned so the frontend can
/// pause + celebrate.
#[tauri::command]
pub fn random_and_hash160(
    spec: RangeSpec,
    network: String,
) -> Result<AutoKeyInfo, String> {
    // `network` is accepted for a uniform API but hash160 is network-independent;
    // it only matters once a match is saved (recorded in the file).
    let _ = network;

    let (lo, hi_excl, expected_hash160) = resolve_range(&spec)?;

    let puzzle_number = match &spec {
        RangeSpec::Puzzle { puzzle_number } => *puzzle_number,
        RangeSpec::Custom { .. } => 0,
    };

    let mut attempts = 0;
    loop {
        let key = if be_lt(&lo, &hi_excl) {
            random_key_in_range(&lo, &hi_excl)?
        } else {
            random_key_from(&lo)
        };
        let ((h160_comp, h160_uncomp), _pk) = match compute_both_hash160(&key) {
            Ok(r) => r,
            Err(_) => {
                attempts += 1;
                if attempts >= 1000 {
                    return Err("failed to generate a valid key after 1000 attempts".to_string());
                }
                continue;
            }
        };

        let address_match =
            expected_hash160.map(|target| h160_comp == target || h160_uncomp == target);
        let mut save_path = None;
        if address_match == Some(true) {
            // Build a minimal KeyInfo to reuse the save helper.
            let info = KeyInfo {
                private_key_hex: hex::encode(key),
                xprv: String::new(),
                xpub: String::new(),
                compressed_public_key: String::new(),
                uncompressed_public_key: String::new(),
                compressed_legacy_address: String::new(),
                uncompressed_legacy_address: String::new(),
                compressed_hash160: hex::encode(h160_comp),
                uncompressed_hash160: hex::encode(h160_uncomp),
                address_match,
                save_path: None,
            };
            save_path = match save_match(&info, puzzle_number, "mainnet") {
                Ok(path) => Some(path),
                Err(e) => Some(format!("ERROR: {e}")),
            };
        }
        return Ok(AutoKeyInfo {
            private_key_hex: hex::encode(key),
            compressed_hash160: hex::encode(h160_comp),
            uncompressed_hash160: hex::encode(h160_uncomp),
            address_match,
            save_path,
        });
    }
}

/// Full derivation of a *known* private key (64-char hex).  Used when auto mode
/// pauses: the last key the user saw on the grid gets its address / xprv / etc.
/// filled in so the bottom info cards can update.
///
/// `rename_all = "snake_case"` is required: Tauri v2 defaults to camelCase keys
/// on the wire, which would turn `private_key_hex` into `privateKeyHex` and fail
/// to deserialize.  This attribute tells Tauri the backend expects snake_case, so
/// the frontend's `{ private_key_hex, spec }` maps straight through.
#[tauri::command(rename_all = "snake_case")]
pub fn derive_full(
    private_key_hex: String,
    spec: RangeSpec,
) -> Result<KeyInfo, String> {
    let key = parse_lo_hex(&private_key_hex).map_err(|e| format!("bad private_key_hex: {e}"))?;
    let (_lo, _hi_excl, expected_hash160) = resolve_range(&spec)?;

    derive_key_info(&key, expected_hash160)
}

/// Derive full info for a batch of keys — one per puzzle in an active group.
/// Each key's compressed- and uncompressed-pubkey hash160 are checked against
/// the *whole* embedded puzzle set (a key inside a group's key space can only
/// ever belong to that group's puzzles, and each group's ranges are disjoint),
/// and a match is persisted next to the executable.  The response is
/// index-aligned with `private_keys`, so the caller already knows which result
/// maps to which puzzle.
///
/// This is the per-hex-iteration workhorse for the group-collision UI: every
/// grid / puzzle-block hover tick (and each Auto round) sends the group's keys
/// here in one IPC call.
#[tauri::command(rename_all = "snake_case")]
pub fn derive_group(private_keys: Vec<String>) -> Result<Vec<KeyInfo>, String> {
    let ps = crate::puzzles::puzzle_set();
    let mut out = Vec::with_capacity(private_keys.len());

    for key_hex in private_keys {
        let key = parse_lo_hex(&key_hex).map_err(|e| format!("bad private_key_hex: {e}"))?;
        // Full derivation computes both compressed and uncompressed hash160.
        let mut info = derive_key_info(&key, None)?;

        // Check both hash160s against the puzzle set.
        let h160_comp: [u8; 20] = {
            let bytes = hex::decode(&info.compressed_hash160)
                .map_err(|e| format!("hash160 hex: {e}"))?;
            bytes
                .try_into()
                .map_err(|_| "hash160 is not 20 bytes".to_string())?
        };
        let h160_uncomp: [u8; 20] = {
            let bytes = hex::decode(&info.uncompressed_hash160)
                .map_err(|e| format!("uncompressed hash160 hex: {e}"))?;
            bytes
                .try_into()
                .map_err(|_| "uncompressed hash160 is not 20 bytes".to_string())?
        };

        let puzzle_number = ps
            .puzzle_number_for_hash160(&h160_comp)
            .or_else(|| ps.puzzle_number_for_hash160(&h160_uncomp));

        match puzzle_number {
            Some(puzzle_number) => {
                info.address_match = Some(true);
                match save_match(&info, puzzle_number, "mainnet") {
                    Ok(path) => info.save_path = Some(path),
                    Err(e) => info.save_path = Some(format!("ERROR: {e}")),
                }
            }
            None => info.address_match = Some(false),
        }
        out.push(info);
    }
    Ok(out)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── big-endian arithmetic ────────────────────────────────────────────────

    #[test]
    fn be_add_sub_roundtrip() {
        let mut a = [0u8; 32];
        a[23] = 0x80; // 2^71
        let mut b = [0u8; 32];
        b[23] = 0x40; // 2^70
        let sum = be_add(&a, &b);
        let diff = be_sub(&sum, &b);
        assert_eq!(diff, a);
    }

    #[test]
    fn be_sub_basic() {
        let mut a = [0u8; 32];
        a[31] = 10;
        let mut b = [0u8; 32];
        b[31] = 3;
        let c = be_sub(&a, &b);
        assert_eq!(c[31], 7);
        assert!((0..31).all(|i| c[i] == 0));
    }

    #[test]
    fn be_sub_borrow() {
        let mut a = [0u8; 32];
        a[30] = 1;
        a[31] = 0;
        let mut b = [0u8; 32];
        b[31] = 1;
        let c = be_sub(&a, &b);
        assert_eq!(c[30], 0);
        assert_eq!(c[31], 0xff);
    }

    #[test]
    fn be_try_increment_works() {
        let mut a = [0u8; 32];
        a[31] = 5;
        assert_eq!(super::be_try_increment(&a).unwrap()[31], 6);
        // overflow
        assert!(super::be_try_increment(&[0xff; 32]).is_none());
    }

    #[test]
    fn be_bit_length_spot_checks() {
        assert_eq!(be_bit_length(&[0; 32]), 0);
        let mut a = [0u8; 32];
        a[31] = 1; // 2^0
        assert_eq!(be_bit_length(&a), 1);
        let mut b = [0u8; 32];
        b[23] = 0x40; // 2^70
        assert_eq!(be_bit_length(&b), 71);
    }

    #[test]
    fn be_lt_works() {
        let mut a = [0u8; 32];
        a[31] = 1;
        let mut b = [0u8; 32];
        b[31] = 2;
        assert!(be_lt(&a, &b));
        assert!(!be_lt(&b, &a));
        assert!(!be_lt(&a, &a));
    }

    // ── hex parsing ─────────────────────────────────────────────────────────

    #[test]
    fn parse_lo_hex_low_bytes() {
        let p = parse_lo_hex("0x400000000000000000").unwrap();
        assert_eq!(p[23], 0x40);
        assert!(p[..23].iter().all(|&b| b == 0));
    }

    #[test]
    fn parse_lo_hex_odd_length() {
        // "0x1000…000" (19 hex chars) → padded to "0100…000" (20) → 10 bytes.
        // The highest byte is 0x01 (0x1000…000 = 16^18 = 0x01 followed by zeros).
        let p = parse_lo_hex("0x1000000000000000000").unwrap();
        assert_eq!(p[22], 0x01);
        assert!(p[23..].iter().all(|&b| b == 0));
    }

    #[test]
    fn parse_lo_hex_rejects_invalid() {
        assert!(parse_lo_hex("0xGG").is_err());
        assert!(parse_lo_hex("").is_err());
    }

    // ── range resolution ────────────────────────────────────────────────────

    #[test]
    fn resolve_puzzle_range() {
        let (lo, hi, hash) = resolve_range(&RangeSpec::Puzzle { puzzle_number: 71 }).unwrap();
        assert!(hash.is_some());
        // puzzle 71: [2^70, 2^71)
        assert_eq!(lo[23], 0x40);
        assert_eq!(hi[23], 0x80);
        assert!(be_lt(&lo, &hi));
    }

    #[test]
    fn resolve_custom_range() {
        let (lo, hi, hash) = resolve_range(&RangeSpec::Custom {
            start_hex: "400000000000000000".to_string(),
            end_hex: "7fffffffffffffffff".to_string(),
        })
        .unwrap();
        assert!(hash.is_none());
        assert_eq!(lo[23], 0x40);
        // inclusive end 0x7f…ff → exclusive hi = 0x80…00
        assert_eq!(hi[23], 0x80);
    }

    #[test]
    fn resolve_custom_max_end() {
        // inclusive end = 0xFF…FF (full 32 bytes) → hi overflows to [0;32] marker.
        let (lo, hi, _) = resolve_range(&RangeSpec::Custom {
            start_hex: "00".to_string(),
            end_hex: "ff".repeat(32),
        })
        .unwrap();
        assert_eq!(lo, [0u8; 32]);
        assert_eq!(hi, [0u8; 32]); // overflow marker
    }

    #[test]
    fn resolve_custom_single_byte_end() {
        // "ff" is a single byte → increments to 0x100 cleanly, no overflow.
        let (lo, hi, _) = resolve_range(&RangeSpec::Custom {
            start_hex: "00".to_string(),
            end_hex: "ff".to_string(),
        })
        .unwrap();
        assert_eq!(lo, [0u8; 32]);
        assert_eq!(hi[30], 0x01);
        assert_eq!(hi[31], 0x00);
    }

    #[test]
    fn resolve_custom_rejects_start_gt_end() {
        let r = resolve_range(&RangeSpec::Custom {
            start_hex: "800000000000000000".to_string(),
            end_hex: "400000000000000000".to_string(),
        });
        assert!(r.is_err());
    }

    // ── timestamp + date formatting ─────────────────────────────────────────

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

    // ── BIP32: validated against the canonical BIP32 test vector ────────────
    //
    // Seed 000102030405060708090a0b0c0d0e0f → master xprv
    // xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNUTGtRBeJgk33yuGBxrMPHi
    // (BIP32 spec test vector 1).  We feed the seed through our `master_key_from_seed`
    // + `serialize_xprv` to confirm both the HMAC and the base58check serialization.

    #[test]
    fn bip32_master_key_vector1() {
        let seed = hex::decode("000102030405060708090a0b0c0d0e0f").unwrap();
        let (privkey, chain_code) = master_key_from_seed(&seed);
        assert_eq!(
            hex::encode(privkey),
            "e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35"
        );
        assert_eq!(
            hex::encode(chain_code),
            "873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508"
        );
    }

    #[test]
    fn bip32_xprv_serialization_vector1() {
        let seed = hex::decode("000102030405060708090a0b0c0d0e0f").unwrap();
        let (privkey, chain_code) = master_key_from_seed(&seed);
        let xprv = serialize_xprv(&chain_code, &privkey);
        assert_eq!(
            xprv,
            "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi"
        );
    }

    // ── random sampling distribution ────────────────────────────────────────

    #[test]
    fn random_key_in_range_respects_bounds() {
        let mut lo = [0u8; 32];
        lo[23] = 0x40; // 2^70
        let mut hi = [0u8; 32];
        hi[23] = 0x80; // 2^71 (exclusive)
        for _ in 0..200 {
            let k = random_key_in_range(&lo, &hi).unwrap();
            assert!(be_lt(&lo, &hi));
            assert!(!be_lt(&k, &lo), "key {k:?} below lo");
            assert!(be_lt(&k, &hi), "key {k:?} above hi");
        }
    }

    #[test]
    fn random_key_from_near_max() {
        // range [0x80…00, 2^256) — exactly half the space, so `random_key_from`
        // accepts ~50% of draws.  Exercises the overflow (0xFF…FF inclusive) path.
        let lo = {
            let mut l = [0u8; 32];
            l[0] = 0x80; // 2^255
            l
        };
        for _ in 0..50 {
            let k = random_key_from(&lo);
            assert!(!be_lt(&k, &lo), "key {k:?} below lo");
        }
    }

    // ── lightweight auto command ─────────────────────────────────────────────

    #[test]
    fn auto_tick_produces_hash160_in_range() {
        // Puzzle 71 range; every tick must land in [2^70, 2^71) with both hash160s.
        for _ in 0..50 {
            let res = random_and_hash160(
                RangeSpec::Puzzle { puzzle_number: 71 },
                "mainnet".to_string(),
            )
            .unwrap();
            assert_eq!(res.private_key_hex.len(), 64);
            assert_eq!(res.compressed_hash160.len(), 40);
            assert_eq!(res.uncompressed_hash160.len(), 40);
            // Compressed and uncompressed hash160s must differ (different input bytes).
            assert_ne!(res.compressed_hash160, res.uncompressed_hash160);
            // address_match is Some (puzzle mode) but almost always false.
            assert!(res.address_match.is_some());
        }
    }

    #[test]
    fn auto_tick_custom_range_no_match_field() {
        let res = random_and_hash160(
            RangeSpec::Custom {
                start_hex: "400000000000000000".to_string(),
                end_hex: "7fffffffffffffffff".to_string(),
            },
            "mainnet".to_string(),
        )
        .unwrap();
        assert_eq!(res.address_match, None);
        assert_eq!(res.save_path, None);
    }

    // ── full derivation of a known key (pause path) ──────────────────────────

    #[test]
    fn derive_full_matches_random_and_derive() {
        // Deriving a known key via `derive_full` must yield the same hash160 and
        // address as a full `random_and_derive` of that same key would.
        let mut lo = [0u8; 32];
        lo[23] = 0x40;
        let mut hi = [0u8; 32];
        hi[23] = 0x80;
        let key = random_key_in_range(&lo, &hi).unwrap();
        let hex = hex::encode(key);

        let full = derive_full(hex.clone(), RangeSpec::Puzzle { puzzle_number: 71 }).unwrap();

        assert_eq!(full.private_key_hex, hex);
        assert_eq!(full.compressed_hash160.len(), 40);
        assert_eq!(full.uncompressed_hash160.len(), 40);
        assert_ne!(full.compressed_hash160, full.uncompressed_hash160);
        assert!(!full.compressed_legacy_address.is_empty());
        assert!(full.compressed_legacy_address.starts_with('1'));
        assert!(!full.uncompressed_legacy_address.is_empty());
        assert!(full.uncompressed_legacy_address.starts_with('1'));
        // Compressed and uncompressed addresses must differ.
        assert_ne!(full.compressed_legacy_address, full.uncompressed_legacy_address);
        assert!(!full.xprv.is_empty());
        assert!(full.xprv.starts_with("xprv"));
        assert_eq!(full.compressed_public_key.len(), 66);
        assert_eq!(full.uncompressed_public_key.len(), 130);
        assert!(full.uncompressed_public_key.starts_with("04"));
    }

    // ── batch group derivation ───────────────────────────────────────────────

    #[test]
    fn derive_group_batch_in_puzzle_range() {
        // Keys in puzzle 71's range [2^70, 2^71): always-valid scalars, never a match.
        let mut lo = [0u8; 32];
        lo[23] = 0x40;
        let mut hi = [0u8; 32];
        hi[23] = 0x80;
        let keys: Vec<String> = (0..3)
            .map(|_| hex::encode(random_key_in_range(&lo, &hi).unwrap()))
            .collect();

        let results = derive_group(keys.clone()).unwrap();
        assert_eq!(results.len(), keys.len());
        for (r, k) in results.iter().zip(&keys) {
            assert_eq!(r.private_key_hex, *k);
            assert_eq!(r.address_match, Some(false));
            assert_eq!(r.save_path, None);
            assert_eq!(r.compressed_hash160.len(), 40);
            assert_eq!(r.uncompressed_hash160.len(), 40);
            assert_ne!(r.compressed_hash160, r.uncompressed_hash160);
            assert_eq!(r.compressed_public_key.len(), 66);
            assert_eq!(r.uncompressed_public_key.len(), 130);
            assert!(r.compressed_legacy_address.starts_with('1'));
            assert!(r.uncompressed_legacy_address.starts_with('1'));
            assert_ne!(r.compressed_legacy_address, r.uncompressed_legacy_address);
            assert!(r.xprv.starts_with("xprv"));
        }
    }
}

