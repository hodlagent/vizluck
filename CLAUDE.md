# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**vizluck** — a Tauri v2 desktop application. Frontend is Vanilla TypeScript + Vite; backend is Rust. The frontend runs inside a native Tauri webview and communicates with Rust commands via `@tauri-apps/api`.

## Commands

```bash
npm install              # install frontend deps (first time only)
npm run tauri dev        # develop: starts Vite (port 1420, strictPort) + native window with HMR
npm run tauri build       # production build: frontend (tsc + vite) then native bundle/packager
npm run dev              # frontend-only Vite dev server (http://localhost:1420) without the Tauri shell
npm run build            # frontend-only build to dist/
npx tsc --noEmit         # type-check frontend without emitting
cargo check              # type-check the Rust backend (from repo root; reads src-tauri/Cargo.toml)
cargo clippy             # lint the Rust backend
```

For desktop development prefer `npm run tauri dev` — it orchestrates both Vite and the Rust app. For Android/iOS, use `npm run tauri android dev` / `npm run tauri ios dev` after running the corresponding `tauri * init`.

## Architecture

Two halves glued together by Tauri, plus a GPU-accelerated BTC scanning engine:

- **`src/` (frontend)** — plain TypeScript. `main.ts` is the entry; it wires DOM events and calls backend commands with `invoke()` from `@tauri-apps/api/core`. Vite serves this during dev and bundles it to `dist/` for production. `vite.config.ts` is Tauri-aware: fixed port 1420, `strictPort`, ignores `src-tauri` from watching.
- **`src-tauri/` (Rust backend)** — a Cargo project.
  - `src/main.rs` — binary entry, just calls `vizluck_lib::run()`.
  - `src/lib.rs` — real entry point: builds the `tauri::Builder`, registers plugins (`tauri_plugin_opener`) and the `invoke_handler`, then runs the app. Also declares the `btc`/`gpu`/`puzzles`/`progress`/`workers` modules.
  - `Cargo.toml` — note the library is named `vizluck_lib` (a Tauri default to avoid name collisions with the binary; don't rename casually). BTC/GPU deps are listed under `[dependencies]`; `sha2` is configured per-OS (`asm` on macOS/Linux for ARMv8-Crypto SHA256, pure-Rust on Windows) via `[target.'cfg(...)'.dependencies]`.
  - `tauri.conf.json` — app identity and build config: `identifier` (`com.jerin.vizluck`), window defaults, `beforeDevCommand`/`devUrl`, `beforeBuildCommand`/`frontendDist`.
  - `capabilities/default.json` — Tauri v2 capability/permission model. Lists which windows get which permissions (`core:default`, `opener:default`).

### BTC + GPU scanning engine (adapted from the `luckfind` crate)

A Bitcoin dormant-address "lottery" scanner: 100k independent GPU walkers each step `P += G` on secp256k1 and compare hash160 against a candidate set of BTC addresses. Target ~80–150 Mkeys/s on Apple Silicon via Metal.

- **`src-tauri/src/btc.rs`** — address derivation. `hash160`, base58 encode/decode, and the 5 address types: `p2pkh_compressed`, `p2sh_p2wpkh`, `p2wpkh`, `p2tr`, plus `legacy_address_hash160` for parsing. Exposes the secp256k1 generator as `GENERATOR_COMPRESSED` / `generator_public_key()` (≈10–20× cheaper than scalar mult for the "advance by 1" hot path).
- **`src-tauri/src/gpu/`** — cross-platform wgpu + naga backend.
  - `mod.rs` — public types `GpuConfig`, `GeneratorPoint`, `GpuState`, `GpuContext`, `GpuScanner`, `GpuMatchOutput`; the `NUM_GPU_THREADS` (=100k) parallelism knob.
  - `context.rs` — device/queue init via `wgpu` + `pollster`, 3-source WGSL concatenation helper.
  - `pipeline.rs` — compute pipeline; concatenates shaders in dependency order (field → curve → sha256 → ripemd160 → hash_glue → luckfind) with `WORKGROUP_SIZE=128`.
  - `buffers.rs` — the 5 GPU buffers (config, states, candidates, matches, match_count); creates a fresh staging buffer per dispatch to avoid "buffer already mapped" panics.
  - `scanner.rs` — init (random range-constrained seeding via `rayon`), dispatch loop, calibration, match readback.
  - `convert.rs` — CPU↔GPU byte/limb conversion (LE `[u32; 8]` limbs ↔ BE `[u8; 32]`), `stride_step_point`, candidate packing, `puzzle_set_to_candidates`.
  - `lottery.rs` — the GPU lottery worker: seeds 100k walkers, walks stride-1, re-seeds every `RESEED_INTERVAL_KEYS` (2^26) for uniform coverage, CPU-verifies every match.
- **`src-tauri/src/shaders/`** — WGSL kernels: `field.wgsl` (mod-p arithmetic), `curve.wgsl` (Jacobian point ops), `sha256.wgsl`, `ripemd160.wgsl`, `hash_glue.wgsl`, `luckfind.wgsl` (the stepping + hash160 kernel). `field.wgsl`/`curve.wgsl` are shared verbatim with the kangaroo ECDLP solver.
- **`src-tauri/src/puzzles.rs`** — the embedded 78 unsolved BTC puzzles as a JSON literal, parsed into `PuzzleSet` with range-weighted `pick_random_puzzle`, `generate_key_in_range`, and `puzzle_number_for_hash160` lookup.
- **`src-tauri/src/progress.rs`** — atomic `Progress` counters shared between workers.
- **`src-tauri/src/workers.rs`** — trimmed shared types (`RuntimeLimits`, `ScanTarget`, `MatchEvent`) referenced by the GPU worker. The full CPU worker-pool `run()` lives upstream in `luckfind`; bring it in when wiring CPU-side scanning to the Tauri app.

### Key conventions

- **Adding a Tauri command**: define a `#[tauri::command]` fn (in `lib.rs` or a new module), add it to the `tauri::generate_handler![]` macro call, then `invoke()` it from the frontend.
- **Permissions**: Tauri v2 gates APIs by capabilities. If a command or plugin needs new OS access, declare it in `src-tauri/capabilities/default.json`.
- **GPU↔CPU data layout**: the GPU uses LE `[u32; 8]` limbs; secp256k1 uses BE `[u8; 32]`. Go through `gpu/convert.rs` — do not hand-transcribe constants across that boundary.
- **App identifier**: `com.jerin.vizluck` in `tauri.conf.json`. Replace with your own reverse-domain string before publishing.
- **Frontend entry**: `index.html` mounts `/src/main.ts`. `dist/` is the built output and is git-ignored.

### Build pipeline (what `tauri build` does)

1. `beforeBuildCommand` → `npm run build` → `tsc && vite build` → `dist/`
2. Cargo compiles the Rust backend (pulling in `wgpu`, `secp256k1`, OS-specific `sha2`), embedding the `dist/` assets
3. Bundler produces the platform package (`.app`/`.dmg` on macOS, etc.) per `bundle.targets`

## Recommended tooling

- VS Code + **Tauri** extension + **rust-analyzer** for a smooth experience.
- `cargo clippy` for Rust linting; `npx tsc --noEmit` for frontend type-checking.
