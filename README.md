# vizluck

基于 **Tauri v2** 的桌面应用脚手架，前端使用 Vanilla TypeScript + Vite，后端使用 Rust。

## 环境要求

- Node.js（建议 v18+）
- Rust（`rustc`、`cargo`，建议通过 [rustup](https://rustup.rs) 安装）
- Tauri 平台依赖：参见 <https://v2.tauri.app/start/prerequisites/>

## 常用命令

```bash
# 安装前端依赖
npm install

# 启动开发（前端 Vite + Tauri 桌面窗口，支持前端 HMR）
npm run tauri dev

# 生产构建（前端 + 原生打包）
npm run tauri build

# 仅启动前端 Vite 开发服务器（http://localhost:1420，无 Tauri 壳）
npm run dev

# 仅构建前端产物到 dist/
npm run build

# 类型检查（tsc，不输出）
npx tsc --noEmit
```

> 开发桌面端推荐 `npm run tauri dev`：它会自动启动 Vite（1420 端口，strictPort）并拉起原生窗口，前端改动通过 HMR 热更新。

## 项目结构

```
vizluck/
├── src/                      # 前端（TypeScript + 资源）
│   ├── main.ts               # 入口：DOM 事件、调用 Tauri 命令
│   └── styles.css
├── src-tauri/                # Rust 后端
│   ├── src/
│   │   ├── main.rs           # 二进制入口，调用 vizluck_lib::run()
│   │   └── lib.rs            # 库入口：注册插件、invoke_handler、启动 Builder
│   ├── capabilities/         # 权限清单（Tauri v2 能力模型）
│   │   └── default.json
│   ├── Cargo.toml            # Rust 依赖与 crate 配置
│   └── tauri.conf.json       # Tauri 配置（窗口、构建、打包、identifier）
├── index.html                # Vite 入口 HTML
├── vite.config.ts            # Vite 配置（Tauri 适配：固定 1420 端口、忽略 src-tauri）
└── package.json
```

## BTC + GPU 扫描引擎

项目集成了源自 `luckfind` 的 Bitcoin 休眠地址"寻宝"扫描器，使用 GPU (wgpu + WGSL) 并行做 secp256k1 密钥碰撞：

- `src-tauri/src/btc.rs` — 地址派生（P2PKH/P2SH/P2WPKH/P2TR、base58/bech32）
- `src-tauri/src/gpu/` — 跨平台 wgpu 扫描后端（设备、管线、缓冲区、扫描器、转换、lottery worker）
- `src-tauri/src/shaders/` — WGSL 内核（有限域运算、曲线点运算、SHA256、RIPEMD160、主扫描内核）
- `src-tauri/src/puzzles.rs` — 内嵌的 78 个未解谜题表 + 范围受限密钥生成
- `src-tauri/src/progress.rs` / `workers.rs` — 进度计数与共享类型

100k 个独立 GPU 线程各自执行 `P += G` 步进并与候选地址集比对 hash160，Apple Silicon 上目标吞吐 80–150 Mkeys/s。

## 约定与说明

- **前后端通信**：前端通过 `@tauri-apps/api` 的 `invoke("commandName", args)` 调用 Rust 命令；命令在 `src-tauri/src/lib.rs` 中用 `#[tauri::command]` 定义，并通过 `tauri::generate_handler!` 注册。
- **权限模型**：Tauri v2 使用 `capabilities/*.json` 声明权限。新增命令/窗口需在 `src-tauri/capabilities/default.json` 中声明对应权限。
- **GPU↔CPU 数据布局**：GPU 使用小端 `[u32; 8]` 字序，secp256k1 使用大端 `[u8; 32]`。跨边界时统一走 `gpu/convert.rs`，不要手动重排。
- **应用标识**：`com.jerin.vizluck`（见 `tauri.conf.json` → `identifier`），发布时请替换为你自己的反向域名标识。
- **lib crate 命名**：Rust 库名为 `vizluck_lib`（Cargo.toml 中 `name = "vizluck_lib"`），这是为了避免与二进制名冲突的 Tauri 默认约定，不要随意改动。
- **sha2 的 OS 差异**：macOS/Linux 启用 `asm` 特性（aarch64 上激活 ARMv8-Crypto SHA256，吞吐提升约 3–5×），Windows 使用纯 Rust 实现。配置见 `Cargo.toml` 的 `[target.'cfg(...)'.dependencies]`。
