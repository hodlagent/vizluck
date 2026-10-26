// The Settings tab's address book, shared with the Random tab.
//
// Unlike `HexState` / `GameState`, this is deliberately a module singleton:
// the two new tabs edit and consume the *same* book, and it is the one piece
// of state that must survive a tab switch without being re-read from disk.
// The JSON file is the durable copy; this proxy is the live one.
//
// All writes go through `invoke` to the two `addresses::*` commands, which use
// `std::fs` (no Tauri fs plugin, no capability change).

import { invoke } from "@tauri-apps/api/core";

export type Chain = "bitcoin" | "ethereum" | "solana";

export interface AddressBook {
  bitcoin: string[];
  ethereum: string[];
  solana: string[];
}

export interface ChainInfo {
  id: Chain;
  label: string;
  /** What a plausible address on this chain looks like, for the placeholder. */
  placeholder: string;
}

export const CHAINS: readonly ChainInfo[] = [
  {
    id: "bitcoin",
    label: "Bitcoin",
    placeholder: "1… / 3… / bc1q… / bc1p…",
  },
  {
    id: "ethereum",
    label: "Ethereum",
    placeholder: "0x… (40 hex chars, 0x optional)",
  },
  {
    id: "solana",
    label: "Solana",
    placeholder: "base58 ed25519 address",
  },
];

interface AddressStore {
  path: string;
  book: AddressBook;
}

const emptyBook = (): AddressBook => ({ bitcoin: [], ethereum: [], solana: [] });

/**
 * The identity of an address for duplicate detection — the same normalisation
 * the scanner applies (`collision.rs::normalized`): trim, drop an optional `0x`,
 * ignore case.  Without the `0x` step `0xABC…` and `ABC…` would be stored as
 * two targets that both match the same derived address.
 */
function compareKey(raw: string): string {
  return raw.trim().replace(/^0x/i, "").toLowerCase();
}

/** Trim, drop empties, and de-duplicate case-insensitively (duplicates would
 *  produce duplicate hits for the same key).  Order is preserved. */
function cleanBook(book: AddressBook): AddressBook {
  const clean = (list: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of list) {
      const value = raw.trim();
      if (!value) continue;
      const key = compareKey(value);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
  };
  return {
    bitcoin: clean(book.bitcoin),
    ethereum: clean(book.ethereum),
    solana: clean(book.solana),
  };
}

/**
 * A deliberately forgiving shape check — the scanner compares strings, so a
 * wrong-looking address simply never matches.  It is only used to flag a row;
 * it never blocks an edit or a save (wallets keep producing new formats).
 */
export function addressWarning(chain: Chain, raw: string): string | null {
  const value = raw.trim();
  if (!value) return "empty address";
  if (chain === "ethereum") {
    const bare = value.replace(/^0x/i, "");
    if (!/^[0-9a-f]{40}$/i.test(bare)) {
      return "Ethereum addresses are 40 hex characters (0x prefix optional)";
    }
  } else if (chain === "bitcoin") {
    if (value.length < 14 || value.length > 90 || !/^[A-Za-z0-9]+$/.test(value)) {
      return "not a plausible Bitcoin address";
    }
  } else if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    return "not a plausible Solana base58 address";
  }
  return null;
}

export class AddressBookStore {
  book = $state<AddressBook>(emptyBook());
  /** Absolute path of the JSON file, once known. */
  path = $state("");
  loaded = $state(false);
  error = $state("");

  /** Not reactive: de-dupes concurrent loads. */
  private loading: Promise<void> | null = null;

  get total(): number {
    return CHAINS.reduce((n, chain) => n + this.count(chain.id), 0);
  }

  /**
   * Distinct, non-blank targets on `chain` — what the scanner will actually
   * check.  A row cleared in the Settings input still exists in `book`, but it
   * must not enable Start or inflate the target count.
   */
  count(chain: Chain): number {
    const seen = new Set<string>();
    for (const raw of this.book[chain]) {
      const value = raw.trim();
      if (value) seen.add(compareKey(value));
    }
    return seen.size;
  }

  /**
   * Plain, cleaned copy for the IPC boundary (a rune proxy is not something to
   * send, and blank rows or near-duplicates should never reach the scanner).
   */
  snapshot(): AddressBook {
    return cleanBook(this.book);
  }

  async ensureLoaded(force = false): Promise<void> {
    if (this.loaded && !force) return;
    if (this.loading) return this.loading;
    this.loading = this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    try {
      const store = await invoke<AddressStore>("load_addresses");
      this.book = cleanBook(store.book);
      this.path = store.path;
      this.error = "";
    } catch (e) {
      // A frontend-only `npm run dev` has no Rust side.  Keep the empty book
      // editable and let the first Save surface the real error.
      this.error = String(e);
    } finally {
      // Mark loaded even on failure: retrying on every tab switch would spam.
      this.loaded = true;
    }
  }

  async save(): Promise<boolean> {
    this.book = cleanBook(this.book);
    try {
      this.path = await invoke<string>("save_addresses", { book: this.snapshot() });
      this.error = "";
      return true;
    } catch (e) {
      this.error = String(e);
      return false;
    }
  }

  add(chain: Chain, raw: string): string | null {
    const value = raw.trim();
    if (!value) return "address is empty";
    const exists = this.book[chain].some((a) => compareKey(a) === compareKey(value));
    if (exists) return "already in the list";
    this.book[chain].push(value);
    return null;
  }

  remove(chain: Chain, index: number): void {
    this.book[chain].splice(index, 1);
  }
}

export const addresses = new AddressBookStore();
