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

Two halves glued together by Tauri:

- **`src/` (frontend)** — plain TypeScript. `main.ts` is the entry; it wires DOM events and calls backend commands with `invoke()` from `@tauri-apps/api/core`. Vite serves this during dev and bundles it to `dist/` for production. `vite.config.ts` is Tauri-aware: fixed port 1420, `strictPort`, ignores `src-tauri` from watching.
- **`src-tauri/` (Rust backend)** — a Cargo project.
  - `src/main.rs` — binary entry, just calls `vizluck_lib::run()`.
  - `src/lib.rs` — real entry point: builds the `tauri::Builder`, registers plugins (`tauri_plugin_opener`) and the `invoke_handler`, then runs the app. Commands are defined here with `#[tauri::command]`.
  - `Cargo.toml` — note the library is named `vizluck_lib` (a Tauri default to avoid name collisions with the binary; don't rename casually).
  - `tauri.conf.json` — app identity and build config: `identifier` (`com.jerin.vizluck`), window defaults, `beforeDevCommand`/`devUrl`, `beforeBuildCommand`/`frontendDist`.
  - `capabilities/default.json` — Tauri v2 capability/permission model. Lists which windows get which permissions (`core:default`, `opener:default`).

### Key conventions

- **Adding a command**: define a `#[tauri::command]` fn in `src-tauri/src/lib.rs`, add it to the `tauri::generate_handler![]` macro call, then `invoke()` it from the frontend. No other wiring needed.
- **Permissions**: Tauri v2 gates APIs by capabilities. If a command or plugin needs new OS access, declare it in `src-tauri/capabilities/default.json` (or a new capability file referenced from `tauri.conf.json`). Running without the right capability fails at runtime.
- **App identifier**: `com.jerin.vizluck` in `tauri.conf.json`. Replace with your own reverse-domain string before publishing.
- **Frontend entry**: `index.html` mounts `/src/main.ts`. `dist/` is the built output and is git-ignored.

### Build pipeline (what `tauri build` does)

1. `beforeBuildCommand` → `npm run build` → `tsc && vite build` → `dist/`
2. Cargo compiles the Rust backend, embedding the `dist/` assets
3. Bundler produces the platform package (`.app`/`.dmg` on macOS, etc.) per `bundle.targets`

## Recommended tooling

- VS Code + **Tauri** extension + **rust-analyzer** for a smooth experience.
- `cargo clippy` for Rust linting; `npx tsc --noEmit` for frontend type-checking.
