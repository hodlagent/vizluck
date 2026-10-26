// Typed wrappers over the homepage Tauri commands registered in
// src-tauri/src/lib.rs. Argument names matter: `derive_full`, `derive_group`,
// `hex_scan_custom` and `hex_scan_group` carry
// `#[tauri::command(rename_all = "snake_case")]`, hence the snake_case keys.

import { invoke } from "@tauri-apps/api/core";
import type {
  GroupPuzzleSpec,
  HexCustomBatch,
  HexGroupBatch,
  KeyInfo,
  PuzzleInfo,
  RangeSpec,
} from "./types";

/** The puzzle table backing the group dropdown. */
export const getPuzzles = () => invoke<PuzzleInfo[]>("get_puzzles");

/** Sample a random key in `spec` and derive everything. */
export const randomAndDerive = (spec: RangeSpec) =>
  invoke<KeyInfo>("random_and_derive", { spec, network: "mainnet" });

/**
 * One time-budgeted batch of the custom-range Auto loop.  The loop runs in Rust
 * and returns only the last key, so one IPC call replaces hundreds of per-key
 * round-trips.
 */
export const hexScanCustom = (spec: RangeSpec, timeBudgetMs: number) =>
  invoke<HexCustomBatch>("hex_scan_custom", {
    spec,
    time_budget_ms: timeBudgetMs,
  });

/**
 * One time-budgeted batch of the group Auto loop.  The backend draws each
 * round's base and top bytes itself; `puzzles` only describes the shape, the
 * top-byte bounds and the targets.
 */
export const hexScanGroup = (puzzles: GroupPuzzleSpec[], timeBudgetMs: number) =>
  invoke<HexGroupBatch>("hex_scan_group", {
    puzzles,
    time_budget_ms: timeBudgetMs,
  });

/** Full derivation for one known key (display only — never persists). */
export const deriveFull = (privateKeyHex: string, spec: RangeSpec) =>
  invoke<KeyInfo>("derive_full", { private_key_hex: privateKeyHex, spec });

/**
 * Derive + match-check a batch; results are index-aligned with the input.
 *
 * `source` is written into the match file's `Source` line.  Hex and Game share
 * this command, so Game passes `"game (group)"` to keep hits attributable.
 */
export const deriveGroup = (privateKeys: string[], source = "hex (group)") =>
  invoke<KeyInfo[]>("derive_group", { private_keys: privateKeys, source });
