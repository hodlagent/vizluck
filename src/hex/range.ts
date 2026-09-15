// Pure helpers for key/range arithmetic. Moved verbatim from the original
// main.ts, with the state reads parameterised out.

import type { PuzzleInfo } from "./types";

/** Inclusive [min, max] the puzzle's high byte may take (from start/end hex). */
export function topByteBounds(p: PuzzleInfo): { min: number; max: number } {
  const max = p.end_top === 0 ? 0xff : p.end_top - 1; // overflow → [start_top, 0xFF]
  return { min: p.start_top, max };
}

export function randomTopByte(p: PuzzleInfo): number {
  const { min, max } = topByteBounds(p);
  const range = max - min + 1;
  const arr = new Uint8Array(1);
  crypto.getRandomValues(arr);
  return min + (arr[0] % range);
}

/** `n` random bytes, each 00–ff, as 2-char hex strings (CSPRNG). */
export function randomBytes(n: number): string[] {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0"));
}

/**
 * Build the 64-char key hex for a puzzle from a base + high byte:
 * `00…00 || highByte || baseBytes`, i.e. high bytes 00-padded above the top byte.
 */
export function puzzleKeyHex(
  p: PuzzleInfo,
  topByte: number,
  baseBytes: string[],
): string {
  const pad = "00".repeat(32 - p.hex_bytes_len);
  const top = topByte.toString(16).padStart(2, "0");
  return pad + top + baseBytes.join("");
}

/** Extract the low `n` bytes (as 2-char hex strings) from a 64-char key hex. */
export function lowBytes(keyHex: string, n: number): string[] {
  const slice = keyHex.slice(-n * 2); // last n bytes
  const out: string[] = [];
  for (let i = 0; i < slice.length; i += 2) {
    out.push(slice.slice(i, i + 2));
  }
  return out;
}

/** Rewrite the byte backing grid cell `cellIdx` and return the new key hex. */
export function setKeyByte(
  keyHex: string,
  hexBytesLen: number,
  cellIdx: number,
  value: number,
): string {
  const byteIdx = 32 - hexBytesLen + cellIdx; // 0-based index into the 32-byte key
  const charIdx = byteIdx * 2;
  const hex = value.toString(16).padStart(2, "0");
  return keyHex.slice(0, charIdx) + hex + keyHex.slice(charIdx + 2);
}

/**
 * Split a range string on either ASCII `:` (U+003A) or fullwidth `：` (U+FF1A).
 * Returns null if there is not exactly one separator.
 */
export function splitRange(raw: string): [string, string] | null {
  const ascii = raw.indexOf(":");
  const full = raw.indexOf("：");
  let idx = -1;
  if (ascii >= 0 && full >= 0) idx = Math.min(ascii, full);
  else if (ascii >= 0) idx = ascii;
  else if (full >= 0) idx = full;
  if (idx < 0) return null;
  const start = raw.slice(0, idx).trim();
  const end = raw.slice(idx + 1).trim();
  if (!start || !end) return null;
  return [start, end];
}

/** Byte length of a hex string (low bytes), odd length rounds up. */
export function hexByteLen(hex: string): number {
  let h = hex.trim();
  if (h.startsWith("0x") || h.startsWith("0X")) h = h.slice(2);
  if (h.length === 0) return 0;
  return Math.ceil(h.length / 2);
}

export function isValidHex(hex: string): boolean {
  let h = hex.trim();
  if (h.startsWith("0x") || h.startsWith("0X")) h = h.slice(2);
  return h.length > 0 && h.length <= 64 && /^[0-9a-fA-F]+$/.test(h);
}
