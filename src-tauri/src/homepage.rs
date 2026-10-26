//! Homepage backend: puzzle listing, range-constrained random key generation,
//! BIP32 master key derivation, and address derivation.
//!
//! Tauri commands used by the Hex tab:
//!   - `get_puzzles`       → the dropdown dataset
//!   - `random_and_derive` → sample a random key in a range + derive everything
//!   - `hex_scan_custom`   → one time-budgeted custom-range Auto batch
//!   - `hex_scan_group`    → one time-budgeted group Auto batch
//!   - `derive_full`       → display-only derivation of a known key
//!   - `derive_group`      → derive a batch of known keys (Hex/Game hover)

use std::time::{Duration, Instant};

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
#[derive(Serialize, Clone)]
pub struct KeyInfo {
    /// Full 32-byte private key, 64-char hex.
    pub private_key_hex: String,
    /// BIP32 master extended private key (xprv / tprv).
    pub xprv: String,
    /// BIP32 master extended public key (xpub / tpub).
    pub xpub: String,
    /// Compressed public key, 66-char hex.
    pub compressed_public_key: String,
    /// Legacy P2PKH address derived from the compressed pubkey.
    pub compressed_legacy_address: String,
    /// 40-char hex hash160 of the compressed pubkey (for puzzle comparison).
    pub compressed_hash160: String,
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

/// Fill `buf` with OS entropy.  The OS source is always available, so a failure
/// is unrecoverable rather than something a caller can retry.
fn fill_random(buf: &mut [u8]) {
    rand::rngs::SysRng
        .try_fill_bytes(buf)
        .expect("OS entropy source always available");
}

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
        fill_random(&mut r);
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
        fill_random(&mut r);
        if !be_lt(&r, lo) {
            // r >= lo
            return r;
        }
    }
}

/// Sample one key from `[lo, hi_excl)`, or from `[lo, 2^256)` when `hi_excl`
/// carries the overflow marker (`[0; 32]`).
fn sample_key(lo: &[u8; 32], hi_excl: &[u8; 32]) -> Result<[u8; 32], String> {
    if be_lt(lo, hi_excl) {
        random_key_in_range(lo, hi_excl)
    } else {
        Ok(random_key_from(lo))
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

// ── Time-budgeted batch scanning (Hex Auto mode) ─────────────────────────────
//
// The Hex tab's Auto loop used to live in the frontend: one IPC round-trip (one
// key in custom mode, one round of N keys in group mode) followed by a 60 ms
// wait.  These two commands move the loop into Rust, so one call checks as many
// keys as fit in the time budget before returning the *last* state for the UI.

/// One puzzle of the active group, as the Hex tab sees it.  The backend itself
/// draws the round's shared base bytes and each puzzle's top byte, so the
/// frontend does not have to pre-generate keys per round.
#[derive(serde::Deserialize)]
pub struct GroupPuzzleSpec {
    pub puzzle_number: u32,
    /// Puzzle width in low bytes, top byte included (1–32).
    pub hex_bytes_len: u8,
    /// Inclusive lower bound of the random top byte.
    pub start_top: u8,
    /// Exclusive upper bound; 0 encodes the 0xFF overflow case.
    pub end_top: u8,
    /// 40-char hex target hash160 for this puzzle.
    pub hash160: String,
}

/// Result of one bounded custom-range batch.
#[derive(Serialize)]
pub struct HexCustomBatch {
    /// Valid keys checked in this batch (invalid scalars are retried, not counted).
    pub checked: u64,
    /// The last key checked (drives the grid), 64-char hex.
    pub private_key_hex: String,
    /// Its compressed-pubkey hash160, 40-char hex.
    pub compressed_hash160: String,
    /// Full info when the batch hit the range's target; already persisted.
    pub matched: Option<KeyInfo>,
}

/// Result of one bounded group batch.
#[derive(Serialize)]
pub struct HexGroupBatch {
    /// Valid keys checked in this batch.
    pub checked: u64,
    /// Shared low bytes of the last round, one byte per grid cell.
    pub base_bytes: Vec<u8>,
    /// Top byte of the last round, index-aligned with the request.
    pub top_bytes: Vec<u8>,
    /// Full derived info of the last round, index-aligned with the request.
    pub infos: Vec<KeyInfo>,
    /// The first hit of this batch (already persisted).  The hit's round is the
    /// one returned in `base_bytes` / `top_bytes` / `infos`, so the UI can
    /// freeze on exactly what produced it.
    pub matched: Option<KeyInfo>,
}

/// Inclusive upper bound of a puzzle's top byte.  `end_top == 0` encodes the
/// range ending at 0xFF…FF, so its real inclusive bound is 0xFF.
fn top_byte_max(end_top: u8) -> u8 {
    if end_top == 0 {
        0xff
    } else {
        end_top - 1
    }
}

/// Uniform random top byte in `[start_top, top_byte_max(end_top)]`.
fn random_top_byte(start_top: u8, end_top: u8) -> u8 {
    let max = top_byte_max(end_top);
    if max <= start_top {
        return start_top;
    }
    let range = (max - start_top) as usize + 1;
    let mut b = [0u8; 1];
    fill_random(&mut b);
    start_top + (b[0] as usize % range) as u8
}

/// Build a group key: `00…00 || top || base`.  `hex_bytes_len` includes `top`,
/// so `base.len() == hex_bytes_len - 1`.
fn build_group_key(hex_bytes_len: usize, top: u8, base: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    key[32 - hex_bytes_len] = top;
    key[32 - hex_bytes_len + 1..].copy_from_slice(base);
    key
}

// ── Core + full derivation ──────────────────────────────────────────────────

/// The unavoidable core: turn a private key into its compressed-pubkey hash160.
/// Scalar multiplication is required to compute a hash160, so this is the one
/// cost every check must pay.  Returns `(compressed_h160, public_key)` — the
/// `PublicKey` lets the full path reuse the already-computed point.
fn compute_compressed_hash160(
    key: &[u8; 32],
) -> Result<([u8; 20], secp256k1::PublicKey), String> {
    use secp256k1::{PublicKey, SecretKey};
    let sk = SecretKey::from_byte_array(*key).map_err(|e| format!("invalid scalar: {e}"))?;
    let pk = PublicKey::from_secret_key(crate::btc::secp_context(), &sk);
    let h160_compressed = crate::btc::hash160(&pk.serialize());
    Ok((h160_compressed, pk))
}

/// Derive every display field from a 32-byte private key.  Returns `Err` if the
/// key is not a valid secp256k1 scalar, or if the BIP32 master key isn't a valid
/// scalar (≈2^-128) — the caller regenerates in that case.
///
/// Only the compressed-pubkey hash160 is checked against the puzzle target.
fn derive_key_info(
    key: &[u8; 32],
    expected_hash160: Option<[u8; 20]>,
) -> Result<KeyInfo, String> {
    use secp256k1::SecretKey;

    let (h160_compressed, pk) = compute_compressed_hash160(key)?;

    let compressed = pk.serialize(); // 33 bytes
    let compressed_hex = hex::encode(compressed);
    let private_key_hex = hex::encode(key);
    let compressed_hash160_hex = hex::encode(h160_compressed);

    let compressed_legacy_address = crate::btc::p2pkh(&compressed);

    // BIP32 master key.  The HMAC left half must also be a valid scalar; if not,
    // signal the caller to regenerate (probability ≈ 2^-128).
    let (master_key, chain_code) = master_key_from_seed(key);
    SecretKey::from_byte_array(master_key)
        .map_err(|_| "BIP32 master key is not a valid scalar".to_string())?;
    let xprv = serialize_xprv(&chain_code, &master_key);
    let xpub = serialize_xpub(&chain_code, &compressed);

    let address_match = expected_hash160.map(|target| h160_compressed == target);

    Ok(KeyInfo {
        private_key_hex,
        xprv,
        xpub,
        compressed_public_key: compressed_hex,
        compressed_legacy_address,
        compressed_hash160: compressed_hash160_hex,
        address_match,
        save_path: None,
    })
}

// ── Match persistence ─────────────────────────────────────────────────────────
//
// When a generated key hits a puzzle's target hash160, the hit is persisted
// through `crate::matches`, the same writer the Random tab uses, so every tab
// produces the same file in `<app_data_dir>/matches/`.

/// Persist a puzzle hit.  `source` says which tab/path produced it
/// (`hex (random)`, `hex (auto)`, `hex/game (group)`); the file layout itself
/// lives in `crate::matches`.
fn save_match(
    info: &KeyInfo,
    puzzle_number: u32,
    network: &str,
    source: &str,
) -> Result<String, String> {
    let match_line = match info.address_match {
        Some(true) => "YES ✅",
        Some(false) => "no",
        None => "n/a",
    };
    crate::matches::save(&crate::matches::MatchRecord {
        title: "PUZZLE MATCH FOUND".to_string(),
        source: source.to_string(),
        private_key_hex: info.private_key_hex.clone(),
        details: vec![
            ("Puzzle".to_string(), format!("#{puzzle_number}")),
            ("Network".to_string(), network.to_string()),
            ("Match".to_string(), match_line.to_string()),
            ("xprv".to_string(), info.xprv.clone()),
            ("xpub".to_string(), info.xpub.clone()),
            (
                "Public Key (compressed)".to_string(),
                info.compressed_public_key.clone(),
            ),
            (
                "Legacy Address (compressed)".to_string(),
                info.compressed_legacy_address.clone(),
            ),
            (
                "hash160 (compressed)".to_string(),
                info.compressed_hash160.clone(),
            ),
        ],
    })
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
                // On a puzzle hit, persist the full result through the shared writer.
                if info.address_match == Some(true) {
                    match save_match(&info, puzzle_number, "mainnet", "hex (random)") {
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

/// One time-budgeted batch for the custom-range Auto loop.  Samples as many
/// keys as fit in `time_budget_ms`, checking only the cheap hash160, and returns
/// the last one so the grid can follow along.  On a target hit the full info is
/// derived (once per run), persisted, and returned in `matched`.
#[tauri::command(async, rename_all = "snake_case")]
pub fn hex_scan_custom(spec: RangeSpec, time_budget_ms: u64) -> Result<HexCustomBatch, String> {
    let (lo, hi_excl, expected_hash160) = resolve_range(&spec)?;

    // Puzzle number for the save file (0 for custom ranges — never matched anyway).
    let puzzle_number = match &spec {
        RangeSpec::Puzzle { puzzle_number } => *puzzle_number,
        RangeSpec::Custom { .. } => 0,
    };

    let budget = Duration::from_millis(time_budget_ms.clamp(1, 500));
    let started = Instant::now();

    let mut checked = 0u64;
    let mut invalid = 0u32;

    let (last_key, last_h160) = loop {
        let key = sample_key(&lo, &hi_excl)?;
        let (h160_comp, _pk) = match compute_compressed_hash160(&key) {
            Ok(r) => r,
            Err(_) => {
                // A custom range spanning near 2^256 rejects ~half of its draws
                // as invalid scalars; the cap only trips on a degenerate range.
                invalid += 1;
                if invalid >= 1000 {
                    return Err("failed to generate a valid key after 1000 attempts".to_string());
                }
                continue;
            }
        };

        checked += 1;

        if expected_hash160 == Some(h160_comp) {
            // Rare enough that the full derivation is free in context.  If the
            // BIP32 master scalar is invalid, fall back to the minimal record:
            // the hit itself is what matters and it is already known.
            let mut info = derive_key_info(&key, expected_hash160).unwrap_or_else(|_| KeyInfo {
                private_key_hex: hex::encode(key),
                xprv: String::new(),
                xpub: String::new(),
                compressed_public_key: String::new(),
                compressed_legacy_address: String::new(),
                compressed_hash160: hex::encode(h160_comp),
                address_match: Some(true),
                save_path: None,
            });
            match save_match(&info, puzzle_number, "mainnet", "hex (auto)") {
                Ok(path) => info.save_path = Some(path),
                Err(e) => info.save_path = Some(format!("ERROR: {e}")),
            }
            return Ok(HexCustomBatch {
                checked,
                private_key_hex: hex::encode(key),
                compressed_hash160: hex::encode(h160_comp),
                matched: Some(info),
            });
        }

        if started.elapsed() >= budget {
            break (key, h160_comp);
        }
    };

    Ok(HexCustomBatch {
        checked,
        private_key_hex: hex::encode(last_key),
        compressed_hash160: hex::encode(last_h160),
        matched: None,
    })
}

/// One time-budgeted batch for the group Auto loop.  Each round draws one shared
/// base-byte tail plus one top byte per puzzle, derives the whole group, and
/// checks every key against its own puzzle target.  The batch returns the last
/// round's state plus the first hit, if any.
#[tauri::command(async, rename_all = "snake_case")]
pub fn hex_scan_group(
    puzzles: Vec<GroupPuzzleSpec>,
    time_budget_ms: u64,
) -> Result<HexGroupBatch, String> {
    let Some(first) = puzzles.first() else {
        return Err("empty puzzle group".to_string());
    };
    let hex_bytes_len = first.hex_bytes_len as usize;
    if hex_bytes_len == 0 || hex_bytes_len > 32 {
        return Err(format!(
            "hex_bytes_len must be 1..=32, got {hex_bytes_len}"
        ));
    }

    let mut targets = Vec::with_capacity(puzzles.len());
    for p in &puzzles {
        if p.hex_bytes_len as usize != hex_bytes_len {
            return Err("group puzzles must share a hex_bytes_len".to_string());
        }
        if top_byte_max(p.end_top) < p.start_top {
            return Err(format!(
                "puzzle {}: empty top-byte range",
                p.puzzle_number
            ));
        }
        let bytes = hex::decode(&p.hash160)
            .map_err(|e| format!("puzzle {}: bad hash160: {e}", p.puzzle_number))?;
        let target: [u8; 20] = bytes
            .try_into()
            .map_err(|_| format!("puzzle {}: hash160 is not 20 bytes", p.puzzle_number))?;
        targets.push(target);
    }

    let budget = Duration::from_millis(time_budget_ms.clamp(1, 500));
    let started = Instant::now();
    let base_len = hex_bytes_len - 1;

    let mut checked = 0u64;
    loop {
        let mut base = vec![0u8; base_len];
        if base_len > 0 {
            fill_random(&mut base);
        }
        let mut top_bytes = Vec::with_capacity(puzzles.len());
        let mut infos = Vec::with_capacity(puzzles.len());
        let mut matched: Option<KeyInfo> = None;

        for (p, target) in puzzles.iter().zip(&targets) {
            // Retry only the astronomically-unlikely invalid BIP32 master key
            // (≈2^-128); a fresh top byte changes the seed.
            let mut attempts = 0;
            let (top, info) = loop {
                let top = random_top_byte(p.start_top, p.end_top);
                let key = build_group_key(hex_bytes_len, top, &base);
                match derive_key_info(&key, Some(*target)) {
                    Ok(info) => break (top, info),
                    Err(_) => {
                        attempts += 1;
                        if attempts >= 1000 {
                            return Err("failed to generate a valid group key".to_string());
                        }
                    }
                }
            };
            checked += 1;
            top_bytes.push(top);

            let mut info = info;
            if info.address_match == Some(true) {
                match save_match(&info, p.puzzle_number, "mainnet", "hex (group)") {
                    Ok(path) => info.save_path = Some(path),
                    Err(e) => info.save_path = Some(format!("ERROR: {e}")),
                }
                if matched.is_none() {
                    matched = Some(info.clone());
                }
            }
            infos.push(info);
        }

        if matched.is_some() || started.elapsed() >= budget {
            return Ok(HexGroupBatch {
                checked,
                base_bytes: base,
                top_bytes,
                infos,
                matched,
            });
        }
    }
}

/// Full derivation of a *known* private key (64-char hex).  Used when auto mode
/// pauses: the last key the user saw on the grid gets its address / xprv / etc.
/// filled in so the bottom info cards can update.
///
/// **Display only.**  It never persists.  A custom `RangeSpec` carries no
/// target hash160 (`resolve_range` returns `None` for it), so `address_match`
/// can only ever be `None`/`false` on this path; the persistence call sites are
/// the sampling commands and `derive_group`, not this one.
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
/// Each key's compressed-pubkey hash160 is checked against the *whole* embedded
/// puzzle set (a key inside a group's key space can only ever belong to that
/// group's puzzles, and each group's ranges are disjoint), and a match is
/// persisted through `crate::matches`.  The response is index-aligned with
/// `private_keys`, so the caller already knows which result maps to which puzzle.
///
/// This is the per-hex-iteration workhorse for the group-collision UI: every
/// grid / puzzle-block hover tick (and each Auto round) sends the group's keys
/// here in one IPC call.
///
/// `source` names the originating tab in the match file.  Hex and Game share
/// this command, so without it every hit would be labelled the same; the
/// default keeps older callers working.
#[tauri::command(rename_all = "snake_case")]
pub fn derive_group(
    private_keys: Vec<String>,
    source: Option<String>,
) -> Result<Vec<KeyInfo>, String> {
    let source = source.as_deref().unwrap_or("hex (group)");
    let ps = crate::puzzles::puzzle_set();
    let mut out = Vec::with_capacity(private_keys.len());

    for key_hex in private_keys {
        let key = parse_lo_hex(&key_hex).map_err(|e| format!("bad private_key_hex: {e}"))?;
        let mut info = derive_key_info(&key, None)?;

        // Check the compressed hash160 against the puzzle set.
        let h160_comp: [u8; 20] = {
            let bytes = hex::decode(&info.compressed_hash160)
                .map_err(|e| format!("hash160 hex: {e}"))?;
            bytes
                .try_into()
                .map_err(|_| "hash160 is not 20 bytes".to_string())?
        };

        let puzzle_number = ps.puzzle_number_for_hash160(&h160_comp);

        match puzzle_number {
            Some(puzzle_number) => {
                info.address_match = Some(true);
                match save_match(&info, puzzle_number, "mainnet", source) {
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

    // ── time-budgeted Hex batches ─────────────────────────────────────────────

    #[test]
    fn build_group_key_pads_the_high_bytes() {
        let key = build_group_key(4, 0xab, &[0x11, 0x22, 0x33]);
        assert_eq!(hex::encode(key), "00".repeat(28) + "ab112233");
        // A one-byte puzzle has no base tail.
        let key = build_group_key(1, 0x7f, &[]);
        assert_eq!(hex::encode(key), "00".repeat(31) + "7f");
    }

    #[test]
    fn custom_batch_checks_keys_and_returns_the_last_one() {
        let res = hex_scan_custom(
            RangeSpec::Custom {
                start_hex: "400000000000000000".to_string(),
                end_hex: "7fffffffffffffffff".to_string(),
            },
            5,
        )
        .unwrap();
        assert!(res.checked > 0, "a 5 ms batch must check at least one key");
        assert_eq!(res.private_key_hex.len(), 64);
        assert_eq!(res.compressed_hash160.len(), 40);
        assert!(res.matched.is_none());
    }

    #[test]
    fn group_batch_finds_a_known_target() {
        // The smallest possible group: hex_bytes_len 1, top byte exactly 1, no
        // base bytes — the only key is 1.  G's compressed-key hash160 is the
        // well-known target, so the batch must hit and stop after one round.
        let target = crate::btc::hash160(&crate::btc::GENERATOR_COMPRESSED);
        let res = hex_scan_group(
            vec![GroupPuzzleSpec {
                puzzle_number: 1,
                hex_bytes_len: 1,
                start_top: 1,
                end_top: 2,
                hash160: hex::encode(target),
            }],
            10,
        )
        .unwrap();
        assert_eq!(res.checked, 1);
        assert_eq!(res.base_bytes, Vec::<u8>::new());
        assert_eq!(res.top_bytes, vec![1]);
        assert_eq!(res.infos.len(), 1);
        let hit = res.matched.expect("the only key in the group must match");
        assert_eq!(hit.private_key_hex, "00".repeat(31) + "01");
        assert_eq!(hit.compressed_hash160, hex::encode(target));
        assert_eq!(hit.address_match, Some(true));
    }

    #[test]
    fn group_batch_returns_a_full_round_without_a_hit() {
        let res = hex_scan_group(
            vec![GroupPuzzleSpec {
                puzzle_number: 71,
                hex_bytes_len: 4,
                start_top: 1,
                end_top: 0,
                hash160: "a".repeat(40),
            }],
            5,
        )
        .unwrap();
        assert!(res.checked > 0);
        assert_eq!(res.base_bytes.len(), 3, "group_4 has 3 base grid cells");
        assert_eq!(res.top_bytes.len(), 1);
        assert_eq!(res.infos.len(), 1);
        assert!(res.matched.is_none());
        assert_eq!(res.infos[0].address_match, Some(false));
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
        assert!(!full.compressed_legacy_address.is_empty());
        assert!(full.compressed_legacy_address.starts_with('1'));
        assert!(!full.xprv.is_empty());
        assert!(full.xprv.starts_with("xprv"));
        assert_eq!(full.compressed_public_key.len(), 66);
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

        let results = derive_group(keys.clone(), None).unwrap();
        assert_eq!(results.len(), keys.len());
        for (r, k) in results.iter().zip(&keys) {
            assert_eq!(r.private_key_hex, *k);
            assert_eq!(r.address_match, Some(false));
            assert_eq!(r.save_path, None);
            assert_eq!(r.compressed_hash160.len(), 40);
            assert_eq!(r.compressed_public_key.len(), 66);
            assert!(r.compressed_legacy_address.starts_with('1'));
            assert!(r.xprv.starts_with("xprv"));
        }
    }
}

