# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**vizluck** — a Tauri v2 desktop application. Frontend is Svelte 5 (runes) + vanilla TypeScript + Vite; backend is Rust. The frontend runs inside a native Tauri webview and communicates with Rust commands via `@tauri-apps/api`.

Two tabs: **Hex** (`src/hex/`, the original brute-force byte-grid explorer) and **Game** (`src/game/`, a survival game whose player state *is* the key material). Both stay mounted at all times — see [Game tab](#game-tab-srcgame) below.

## Commands

```bash
npm install              # install frontend deps (first time only)
npm run tauri dev        # develop: starts Vite (port 1420, strictPort) + native window with HMR
npm run tauri build      # production build: frontend (svelte-check + vite) then native bundle/packager
npm run dev              # frontend-only Vite dev server (http://localhost:1420) without the Tauri shell
npm run build            # frontend-only build to dist/ (svelte-check + vite build)
npm run check            # svelte-check --tsconfig ./tsconfig.json (type-check, no emit)
npm run test:e2e         # hex-tab + game-tab + game-sim; spawns its own dev server
cargo check              # type-check the Rust backend (from repo root; reads src-tauri/Cargo.toml)
cargo clippy             # lint the Rust backend
```

There is no TS unit-test runner. `tests/*.mjs` drive a real browser through Playwright and import the TS modules through the vite dev server (`await import("/src/game/sim.ts")`) — so the tests exercise the same module graph the app does.

For desktop development prefer `npm run tauri dev` — it orchestrates both Vite and the Rust app. For Android/iOS, use `npm run tauri android dev` / `npm run tauri ios dev` after running the corresponding `tauri * init`.

## Architecture

Two halves glued together by Tauri, plus a GPU-accelerated BTC scanning engine:

- **`src/` (frontend)** — Svelte 5 + TypeScript. `main.ts` mounts `App.svelte`, which owns the tab bar and keeps **both panels mounted**, toggling only the `hidden` attribute. Vite serves this during dev and bundles it to `dist/` for production. `vite.config.ts` is Tauri-aware: fixed port 1420, `strictPort`, ignores `src-tauri` from watching.
  - `src/hex/` — Hex tab state, byte-range math, and the reused `MatchBanner`.
  - `src/game/` — the Game tab (see below).
  - `src/styles.css` — one global, **unscoped** stylesheet. Do not add `<style>` blocks to components: the canvas reads colours back out of `:root` via `getComputedStyle`.
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

### Game tab (`src/game/`)

A survival game rendered with Phaser 4 whose **player state is the key material**: the sim's fields are folded into the `b-1` free bytes of the private key, and the run samples that key through the same `derive_group` path the Hex tab uses. **Read `docs/game-design.md` before changing anything here** — it is the contract, and code comments cite its section numbers (§3.3, §8.3, …). Update the doc *without renumbering*: append or rewrite a section's body, never insert one in the middle.

- `sim.ts` — the **pure simulation**: regions, monster AI, combat, upgrades, drops, respawns. No Phaser, no DOM. Every random draw goes through `state.rng` (seeded at `createSim`, `Math.random` only as its default); the tests inject a seeded generator, which is what makes them deterministic — **never call `Math.random` directly in the sim.**
- `keymap.ts` — pure mapping from a `GameSnapshot` to the state vector `V` and to bytes. **`V` is fixed-length (64) on purpose**; a variable-length vector would shift every byte's owner whenever a monster died, and the HUD's byte-ownership labels would jitter.
- `scenes/GameScene.ts` — rendering + keyboard input, no rules. It is **immediate-mode**: one shared `Graphics`, cleared and redrawn each frame, no per-entity Sprites. There is no event stream from the sim, so the scene diffs state frame-to-frame to fire its effects (its own `Math.random` is only ever particle jitter, never gameplay).
- `state.svelte.ts` — puzzle selection, run intent, the key tick. `syncStatus()` is the single decision point for pause semantics; nothing else pauses the scene or touches the key loop.
- `config.ts` — Phaser config. `type: Phaser.AUTO` deliberately, because WEBGL has no Canvas fallback and throws in the headless Chromium the tests run in — **the Canvas renderer is the floor**, so no WebGL-only features (gradients, blend modes, post-FX).

### Key conventions

- **Adding a Tauri command**: define a `#[tauri::command]` fn (in `lib.rs` or a new module), add it to the `tauri::generate_handler![]` macro call, then `invoke()` it from the frontend.
- **Permissions**: Tauri v2 gates APIs by capabilities. If a command or plugin needs new OS access, declare it in `src-tauri/capabilities/default.json`.
- **GPU↔CPU data layout**: the GPU uses LE `[u32; 8]` limbs; secp256k1 uses BE `[u8; 32]`. Go through `gpu/convert.rs` — do not hand-transcribe constants across that boundary.
- **App identifier**: `com.jerin.vizluck` in `tauri.conf.json`. Replace with your own reverse-domain string before publishing.
- **Frontend entry**: `index.html` mounts `/src/main.ts`. `dist/` is the built output and is git-ignored.

### Build pipeline (what `tauri build` does)

1. `beforeBuildCommand` → `npm run build` → `svelte-check && vite build` → `dist/`
2. Cargo compiles the Rust backend (pulling in `wgpu`, `secp256k1`, OS-specific `sha2`), embedding the `dist/` assets
3. Bundler produces the platform package (`.app`/`.dmg` on macOS, etc.) per `bundle.targets`

## Recommended tooling

- VS Code + **Tauri** extension + **rust-analyzer** for a smooth experience.
- `cargo clippy` for Rust linting; `npm run check` for frontend type-checking.
