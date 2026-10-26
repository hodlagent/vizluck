//! Random-tab collision scanning: draw fully random 32-byte keys and check the
//! addresses they produce on all three chains against the Settings book.
//!
//! One 32-byte draw is used two ways, which is the only honest way to talk
//! about "a private key" across these chains:
//!   - Bitcoin / Ethereum: the draw is a secp256k1 secret key.
//!   - Solana: the draw is the ed25519 seed.
//!
//! The scan runs for a wall-clock budget rather than a fixed key count, so the
//! frontend gets a regular stream of results without guessing how fast the
//! machine is.  Comparison is case-insensitive by design (see `check`).

use std::time::{Duration, Instant};

use rand::TryRng;
use secp256k1::{PublicKey, SecretKey};
use serde::Serialize;
use tiny_keccak::{Hasher, Keccak};

use crate::addresses::AddressBook;

/// One configured address that the generated key hit.
#[derive(Serialize, Clone, Debug)]
pub struct RandomMatch {
    /// `bitcoin` / `ethereum` / `solana`.
    pub chain: String,
    /// The configured address, as stored in `addresses.json`.
    pub address: String,
    /// The address actually derived from this key (same value, different case
    /// or checksum spelling).
    pub derived_address: String,
    pub private_key_hex: String,
}

/// One Bitcoin address form derived from a key.
///
/// The `kind` is carried next to the address instead of the frontend labelling
/// rows by array index: a legacy target can opt into an extra uncompressed
/// P2PKH row, which would otherwise shift every label after it.
#[derive(Serialize, Clone, Debug)]
pub struct BitcoinAddress {
    /// `P2PKH (compressed)` / `P2PKH (uncompressed)` / `P2SH-P2WPKH` /
    /// `P2WPKH` / `P2TR`.
    pub kind: &'static str,
    pub address: String,
}

/// One time-budgeted batch of scanned keys.
#[derive(Serialize)]
pub struct RandomScanResult {
    /// The last key generated in this batch — the one the 32 byte cards show.
    pub private_key_hex: String,
    /// Every Bitcoin address form derived from that key.  P2PKH is always
    /// checked in its compressed form, the uncompressed form is added when a
    /// legacy (`1…`) target is configured, and P2TR when a taproot target is.
    pub bitcoin: Vec<BitcoinAddress>,
    /// EIP-55 checksummed Ethereum address.
    pub ethereum: String,
    /// Base58 of the ed25519 public key.
    pub solana: String,
    /// Keys generated and checked in this batch.
    pub checked: u64,
    /// Every configured address hit by any key in this batch.  Non-empty means
    /// the batch stopped early.
    pub matches: Vec<RandomMatch>,
    /// Absolute path of the match file written through `crate::matches`.
    /// `None` when nothing was hit.
    pub save_path: Option<String>,
    /// Why the hit could not be saved, if it could not.  The hit itself is
    /// still valid and is returned in `matches`.
    pub save_error: Option<String>,
}

/// Build the shared match-file record for a batch of hits from one key.
///
/// One key can hit several configured addresses (e.g. the same key stored once
/// per chain, or a BTC target duplicated in two forms); all of them go into one
/// file, because they share the private key that produced them.
fn match_record(matches: &[RandomMatch], private_key_hex: &str) -> crate::matches::MatchRecord {
    let indexed = matches.len() > 1;
    let mut details = Vec::with_capacity(matches.len() * 3);
    for (i, m) in matches.iter().enumerate() {
        let suffix = if indexed {
            format!(" {}", i + 1)
        } else {
            String::new()
        };
        details.push((format!("Chain{suffix}"), m.chain.clone()));
        details.push((format!("Configured{suffix}"), m.address.clone()));
        details.push((format!("Derived{suffix}"), m.derived_address.clone()));
    }
    crate::matches::MatchRecord {
        title: "ADDRESS MATCH FOUND".to_string(),
        source: "random".to_string(),
        private_key_hex: private_key_hex.to_string(),
        details,
    }
}

/// Draw a uniform 32-byte key and reject the astronomically unlikely values
/// that are not valid secp256k1 scalars (≈2^-128).  Rejection keeps the draw
/// uniform over the valid scalar set and guarantees the same 32 bytes are a
/// usable ed25519 seed.
fn random_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    loop {
        rand::rngs::SysRng
            .try_fill_bytes(&mut key)
            .expect("OS entropy source always available");
        if SecretKey::from_byte_array(key).is_ok() {
            return key;
        }
    }
}

/// Lowercase-stripped comparison form.  Ethereum users paste both `0xAB…` and
/// `AB…`, and Bitcoin/Solana addresses are pasted with stray whitespace; the
/// actual comparison is case-insensitive either way.
#[inline]
fn normalized(s: &str) -> &str {
    let t = s.trim();
    t.strip_prefix("0x")
        .or_else(|| t.strip_prefix("0X"))
        .unwrap_or(t)
}

/// Record every configured address in `configured` that `derived` equals
/// ignoring ASCII case.
fn check(
    chain: &str,
    derived: &str,
    configured: &[String],
    private_key_hex: &str,
    out: &mut Vec<RandomMatch>,
) {
    let d = normalized(derived);
    if d.is_empty() {
        return;
    }
    for address in configured {
        let a = normalized(address);
        if !a.is_empty() && d.eq_ignore_ascii_case(a) {
            out.push(RandomMatch {
                chain: chain.to_string(),
                address: address.trim().to_string(),
                derived_address: derived.to_string(),
                private_key_hex: private_key_hex.to_string(),
            });
        }
    }
}

/// All Bitcoin address forms a key can produce, labelled by form.
///
/// P2PKH has two encodings of the same key: the compressed pubkey (33 bytes)
/// and the 2010-era uncompressed one (65 bytes).  A legacy `1…` address does
/// not reveal which was used, so a book containing one needs both, or a genuine
/// match is silently missed.  It is opt-in because the extra hash160 + base58
/// costs ~20% throughput, and modern books never need it.
///
/// P2TR is likewise opt-in (`bc1p…` target): the BIP341 tweak is an extra
/// scalar multiplication and would otherwise be paid for every key.
///
/// Segwit v0 (P2SH-P2WPKH, P2WPKH) and P2TR use the compressed key by
/// definition; only legacy P2PKH gets the uncompressed variant.
fn bitcoin_addresses(
    pubkey: &PublicKey,
    want_uncompressed_p2pkh: bool,
    want_taproot: bool,
) -> Vec<BitcoinAddress> {
    let compressed = pubkey.serialize();
    let mut out = vec![BitcoinAddress {
        kind: "P2PKH (compressed)",
        address: crate::btc::p2pkh(&compressed),
    }];
    if want_uncompressed_p2pkh {
        out.push(BitcoinAddress {
            kind: "P2PKH (uncompressed)",
            address: crate::btc::p2pkh(&pubkey.serialize_uncompressed()),
        });
    }
    out.push(BitcoinAddress {
        kind: "P2SH-P2WPKH",
        address: crate::btc::p2sh_p2wpkh(&compressed),
    });
    out.push(BitcoinAddress {
        kind: "P2WPKH",
        address: crate::btc::p2wpkh(&compressed),
    });
    if want_taproot {
        out.push(BitcoinAddress {
            kind: "P2TR",
            address: crate::btc::p2tr(&compressed),
        });
    }
    out.retain(|a| !a.address.is_empty());
    out
}

/// EIP-55 checksummed Ethereum address: keccak256 of the uncompressed public
/// key without its `0x04` prefix, last 20 bytes, then the EIP-55 case mix.
fn ethereum_address(pubkey: &PublicKey) -> String {
    let uncompressed = pubkey.serialize_uncompressed(); // 65 bytes, 0x04 prefix

    let mut hash = [0u8; 32];
    let mut keccak = Keccak::v256();
    keccak.update(&uncompressed[1..]);
    keccak.finalize(&mut hash);

    let lower = hex::encode(&hash[12..]); // 40 lowercase hex chars

    let mut checksum = [0u8; 32];
    let mut keccak = Keccak::v256();
    keccak.update(lower.as_bytes());
    keccak.finalize(&mut checksum);

    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (i, byte) in lower.bytes().enumerate() {
        let nibble = if i % 2 == 0 {
            checksum[i / 2] >> 4
        } else {
            checksum[i / 2] & 0x0f
        };
        if byte.is_ascii_alphabetic() && nibble >= 8 {
            out.push((byte as char).to_ascii_uppercase());
        } else {
            out.push(byte as char);
        }
    }
    out
}

/// Solana address: base58 of the ed25519 public key derived from the seed.
fn solana_address(seed: &[u8; 32]) -> String {
    let signing = ed25519_dalek::SigningKey::from_bytes(seed);
    crate::btc::bs58_encode(&signing.verifying_key().to_bytes())
}

/// Scan for `time_budget_ms`, or until a configured address is hit.
///
/// The check for a match happens for every generated key against every
/// configured address on all three chains, exactly as the tab promises.
///
/// `async` runs this sync function on Tauri's thread pool instead of the main
/// thread — a 40 ms batch must never stall window events between batches.
#[tauri::command(async, rename_all = "snake_case")]
pub fn random_scan(book: AddressBook, time_budget_ms: u64) -> Result<RandomScanResult, String> {
    let budget = Duration::from_millis(time_budget_ms.clamp(1, 500));
    let want_taproot = book
        .bitcoin
        .iter()
        .any(|a| normalized(a).to_ascii_lowercase().starts_with("bc1p"));
    // A `1…` target might have come from a compressed or an uncompressed key;
    // only the address cannot tell us, so check both.
    let want_uncompressed_p2pkh = book
        .bitcoin
        .iter()
        .any(|a| normalized(a).starts_with('1'));
    let secp = crate::btc::secp_context();
    let started = Instant::now();

    let mut checked = 0u64;
    let mut matches = Vec::new();
    let mut result = RandomScanResult {
        private_key_hex: String::new(),
        bitcoin: Vec::new(),
        ethereum: String::new(),
        solana: String::new(),
        checked: 0,
        matches: Vec::new(),
        save_path: None,
        save_error: None,
    };

    loop {
        let key = random_key();
        let private_key_hex = hex::encode(key);
        let secret = SecretKey::from_byte_array(key)
            .expect("random_key() only returns valid secp256k1 scalars");
        let pubkey = PublicKey::from_secret_key(secp, &secret);

        let bitcoin =
            bitcoin_addresses(&pubkey, want_uncompressed_p2pkh, want_taproot);
        let ethereum = ethereum_address(&pubkey);
        let solana = solana_address(&key);

        for derived in &bitcoin {
            check(
                "bitcoin",
                &derived.address,
                &book.bitcoin,
                &private_key_hex,
                &mut matches,
            );
        }
        check(
            "ethereum",
            &ethereum,
            &book.ethereum,
            &private_key_hex,
            &mut matches,
        );
        check("solana", &solana, &book.solana, &private_key_hex, &mut matches);

        checked += 1;
        result.private_key_hex = private_key_hex;
        result.bitcoin = bitcoin;
        result.ethereum = ethereum;
        result.solana = solana;

        if !matches.is_empty() || started.elapsed() >= budget {
            break;
        }
    }

    result.checked = checked;
    result.matches = matches;

    // A hit is still a hit even if the disk is unavailable: record the failure
    // next to the matches instead of turning the whole batch into an error.
    if !result.matches.is_empty() {
        let record = match_record(&result.matches, &result.private_key_hex);
        match crate::matches::save(&record) {
            Ok(path) => result.save_path = Some(path),
            Err(e) => result.save_error = Some(e),
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Well-known secp256k1 vector: private key 1.
    const KEY_ONE: [u8; 32] = {
        let mut k = [0u8; 32];
        k[31] = 1;
        k
    };

    fn key_one_pubkey() -> PublicKey {
        let secret = SecretKey::from_byte_array(KEY_ONE).unwrap();
        PublicKey::from_secret_key(crate::btc::secp_context(), &secret)
    }

    #[test]
    fn bitcoin_derivation_private_key_one() {
        let addresses = bitcoin_addresses(&key_one_pubkey(), false, false);
        assert_eq!(addresses[0].kind, "P2PKH (compressed)");
        // Legacy compressed P2PKH for private key 1 (the canonical vector).
        assert_eq!(
            addresses[0].address,
            "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"
        );
        assert_eq!(addresses[1].kind, "P2SH-P2WPKH");
        assert!(addresses[1].address.starts_with('3'), "P2SH-P2WPKH: {}", addresses[1].address);
        assert_eq!(addresses[2].kind, "P2WPKH");
        assert!(addresses[2].address.starts_with("bc1q"), "P2WPKH: {}", addresses[2].address);
        assert_eq!(addresses.len(), 3);
    }

    #[test]
    fn uncompressed_p2pkh_is_opt_in_and_checked_when_enabled() {
        // Private key 1's 2010-era uncompressed address.  Without the flag we
        // would never derive it, so a saved `1EHNa…` target could never match.
        let pubkey = key_one_pubkey();
        let without = bitcoin_addresses(&pubkey, false, false);
        assert!(without.iter().all(|a| a.kind != "P2PKH (uncompressed)"));

        let with = bitcoin_addresses(&pubkey, true, false);
        assert_eq!(with.len(), without.len() + 1);
        assert_eq!(with[1].kind, "P2PKH (uncompressed)");
        assert_eq!(
            with[1].address,
            "1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm"
        );
    }

    #[test]
    fn taproot_is_only_added_on_request() {
        let pubkey = key_one_pubkey();
        let without = bitcoin_addresses(&pubkey, false, false);
        let with = bitcoin_addresses(&pubkey, false, true);
        assert_eq!(with.len(), without.len() + 1);
        assert_eq!(with[3].kind, "P2TR");
        assert!(with[3].address.starts_with("bc1p"), "P2TR: {}", with[3].address);
    }

    #[test]
    fn ethereum_derivation_private_key_one() {
        let address = ethereum_address(&key_one_pubkey());
        // EIP-55 checksummed address for private key 1.
        assert_eq!(address, "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
        assert!(address.eq_ignore_ascii_case("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"));
    }

    #[test]
    fn solana_derivation_rfc8032_vector() {
        // RFC 8032 §7.1 TEST 1 secret seed → public key.
        let seed =
            hex::decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
                .unwrap()
                .try_into()
                .unwrap();
        let address = solana_address(&seed);
        // base58(d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a)
        assert_eq!(address, "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z");
    }

    #[test]
    fn comparison_ignores_case_and_0x_prefix() {
        let configured = vec!["0x7e5f4552091a69125d5dfcb7b8c2659029395bdf".to_string()];
        let mut matches = Vec::new();
        check(
            "ethereum",
            "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
            &configured,
            "01",
            &mut matches,
        );
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].chain, "ethereum");
    }

    #[test]
    fn comparison_rejects_other_addresses() {
        let configured = vec!["0x0000000000000000000000000000000000000000".to_string()];
        let mut matches = Vec::new();
        check(
            "ethereum",
            "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
            &configured,
            "01",
            &mut matches,
        );
        assert!(matches.is_empty());
    }

    #[test]
    fn match_record_carries_every_configured_hit() {
        let matches = vec![RandomMatch {
            chain: "ethereum".into(),
            address: "0xabc".into(),
            derived_address: "0xABC".into(),
            private_key_hex: "01".into(),
        }];
        let record = match_record(&matches, "01");
        assert_eq!(record.title, "ADDRESS MATCH FOUND");
        assert_eq!(record.source, "random");
        assert_eq!(record.private_key_hex, "01");
        assert_eq!(
            record.details,
            vec![
                ("Chain".to_string(), "ethereum".to_string()),
                ("Configured".to_string(), "0xabc".to_string()),
                ("Derived".to_string(), "0xABC".to_string()),
            ]
        );
    }

    #[test]
    fn match_record_indexes_labels_when_a_key_hits_several_targets() {
        let hit = |chain: &str| RandomMatch {
            chain: chain.into(),
            address: "target".into(),
            derived_address: "derived".into(),
            private_key_hex: "01".into(),
        };
        let record = match_record(&[hit("bitcoin"), hit("solana")], "01");
        let labels: Vec<&str> = record.details.iter().map(|(l, _)| l.as_str()).collect();
        assert_eq!(
            labels,
            vec![
                "Chain 1",
                "Configured 1",
                "Derived 1",
                "Chain 2",
                "Configured 2",
                "Derived 2",
            ]
        );
    }

    #[test]
    fn scan_always_checks_at_least_one_key() {
        let result = random_scan(AddressBook::default(), 1).unwrap();
        assert!(result.checked >= 1);
        assert_eq!(result.private_key_hex.len(), 64);
        assert_eq!(result.bitcoin.len(), 3);
        assert!(result.ethereum.starts_with("0x"));
        assert_eq!(result.ethereum.len(), 42);
        assert!(!result.solana.is_empty());
        assert!(result.matches.is_empty());
    }

    #[test]
    fn scan_accepts_a_populated_book() {
        // Configuring an address derived from a *known* key cannot make the
        // random scan hit it (2^256 search), so this only proves the command
        // accepts a populated book and still returns a result.  The matching
        // path itself is exercised by `comparison_ignores_case_and_0x_prefix`.
        let book = AddressBook {
            ethereum: vec!["0x0000000000000000000000000000000000000000".into()],
            ..AddressBook::default()
        };
        let result = random_scan(book, 1).unwrap();
        assert!(result.matches.is_empty(), "a 2^160 target cannot be hit in 1 ms");
    }
}
