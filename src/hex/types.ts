// Shapes mirroring the Rust response structs in src-tauri/src/homepage.rs.
// Response fields are snake_case (serde, no renames) — see that file.

export interface PuzzleInfo {
  puzzle_number: number;
  hex_bytes_len: number;
  start_hex: string;
  end_hex: string;
  hash160: string;
  /** Inclusive lower bound of the top byte (the puzzle's high byte). */
  start_top: number;
  /** Exclusive upper bound; 0 encodes overflow (real max 0xFF). */
  end_top: number;
}

/** A byte-group: puzzles sharing the same `hex_bytes_len`. */
export interface PuzzleGroup {
  bytes: number;
  puzzles: PuzzleInfo[];
}

export type RangeSpec =
  | { type: "puzzle"; puzzle_number: number }
  | { type: "custom"; start_hex: string; end_hex: string };

export interface KeyInfo {
  private_key_hex: string;
  xprv: string;
  xpub: string;
  compressed_public_key: string;
  compressed_legacy_address: string;
  compressed_hash160: string;
  address_match: boolean | null;
  /** Absolute path the match was saved to, or null when no match was saved. */
  save_path: string | null;
}

/** Lightweight auto-mode result: key + hash160 only (no address/xprv). */
export interface AutoKeyInfo {
  private_key_hex: string;
  compressed_hash160: string;
  address_match: boolean | null;
  save_path: string | null;
}
