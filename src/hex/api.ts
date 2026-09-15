// Typed wrappers over the five homepage Tauri commands registered in
// src-tauri/src/lib.rs. Argument names matter: `derive_full` and `derive_group`
// carry `#[tauri::command(rename_all = "snake_case")]`, hence the snake_case
// keys below.

import { invoke } from "@tauri-apps/api/core";
import type { AutoKeyInfo, KeyInfo, PuzzleInfo, RangeSpec } from "./types";

/** The puzzle table backing the group dropdown. */
export const getPuzzles = () => invoke<PuzzleInfo[]>("get_puzzles");

/** Sample a random key in `spec` and derive everything. */
export const randomAndDerive = (spec: RangeSpec) =>
  invoke<KeyInfo>("random_and_derive", { spec, network: "mainnet" });

/** Auto-mode tick: sample a key and compute only its hash160. */
export const randomAndHash160 = (spec: RangeSpec) =>
  invoke<AutoKeyInfo>("random_and_hash160", { spec, network: "mainnet" });

/** Full derivation for one known key. */
export const deriveFull = (privateKeyHex: string, spec: RangeSpec) =>
  invoke<KeyInfo>("derive_full", { private_key_hex: privateKeyHex, spec });

/** Derive + match-check a batch; results are index-aligned with the input. */
export const deriveGroup = (privateKeys: string[]) =>
  invoke<KeyInfo[]>("derive_group", { private_keys: privateKeys });
