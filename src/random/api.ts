// Typed wrappers for the Random tab's backend command.
// Response fields are snake_case (serde, no renames) — see collision.rs.

import { invoke } from "@tauri-apps/api/core";
import type { AddressBook } from "../addresses.svelte";

export interface RandomMatch {
  chain: string;
  /** The configured address, exactly as stored. */
  address: string;
  /** The address derived from this key (same value, possibly different case). */
  derived_address: string;
  private_key_hex: string;
}

/** One derived Bitcoin address and the form that produced it. */
export interface BitcoinAddress {
  /** `P2PKH (compressed)`, `P2PKH (uncompressed)`, `P2SH-P2WPKH`, `P2WPKH`, `P2TR`. */
  kind: string;
  address: string;
}

export interface RandomScanResult {
  private_key_hex: string;
  /**
   * Every Bitcoin form derived from the key.  P2PKH is always compressed; the
   * uncompressed form appears when a legacy (`1…`) target is configured, and
   * P2TR when a taproot target is.
   */
  bitcoin: BitcoinAddress[];
  ethereum: string;
  solana: string;
  checked: number;
  matches: RandomMatch[];
  /** Absolute path of the saved match file; null when this batch had no hit. */
  save_path: string | null;
  /** Set when the hit could not be written to disk; the hit is still valid. */
  save_error: string | null;
}

/** Scan for `timeBudgetMs` (or until the first hit) in one IPC round-trip. */
export const randomScan = (book: AddressBook, timeBudgetMs: number) =>
  invoke<RandomScanResult>("random_scan", {
    book,
    time_budget_ms: timeBudgetMs,
  });
