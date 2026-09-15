# vizluck

基于 **Tauri v2** 的桌面应用：用 GPU 暴力搜索 Bitcoin 休眠地址「彩票」，并把这段漫长等待包装成一个可以玩的东西。前端使用 **Svelte 5（runes）+ TypeScript + Vite**，后端使用 Rust。

应用有两个 Tab：

- **Hex** —— 暴力搜索实验室。一排字节的 grid，Random / hover 循环 / auto 模式驱动它滚动，命中即高亮冻结。
- **Game** —— 生存玩法。同一个搜索被讲成一场 3×3 竞技场里的生存：玩家躲怪、杀怪、成长，而**玩家的状态本身就是密钥材料**。设计细节见 [`docs/game-design.md`](docs/game-design.md)。

> 诚实声明：**这两个 Tab 都「搜不出」puzzle。** `b ≥ 9` 意味着一个 puzzle 的区间至少 `2^72` 个密钥，任何玩法、任何存活时长都不可能穷尽它。命中是极小概率的彩票事件，不是可攻略的目标。

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

# 仅构建前端产物到 dist/（svelte-check + vite build）
npm run build

# 类型检查（svelte-check，不输出）
npm run check

# 端到端回归（hex-tab + game-tab + game-sim，自带 dev server）
npm run test:e2e
```

> 项目没有 TS 单测运行器。`tests/*.mjs` 用 Playwright 驱动真实浏览器，再经 dev server 的模块图 `await import("/src/game/sim.ts")` 加载被测 TS —— 跑的就是应用本身的模块图。

> 开发桌面端推荐 `npm run tauri dev`：它会自动启动 Vite（1420 端口，strictPort）并拉起原生窗口，前端改动通过 HMR 热更新。

## 项目结构

```
vizluck/
├── src/                      # 前端（Svelte 5 + TypeScript）
│   ├── main.ts               # 入口：挂载 App.svelte
│   ├── App.svelte            # Tab 栏；两个面板常驻，只切 hidden
│   ├── styles.css            # 唯一的全局样式表（不 scope，画布要从 :root 读颜色）
│   ├── tabs/
│   │   ├── Hex.svelte        # Hex tab 的壳
│   │   └── Game.svelte       # Game tab 的壳（下拉框 + 按钮 + HUD）
│   ├── hex/                  # Hex tab：状态、字节范围、grid、命中横幅
│   └── game/                 # Game tab（见 docs/game-design.md）
│       ├── sim.ts            #   纯模拟：无 Phaser、无 DOM，随机数全部走可注入的 rng
│       ├── keymap.ts         #   纯映射：状态向量 V → 密钥字节
│       ├── types.ts          #   Dir / PlayerStats / MonsterStats / ItemStats …
│       ├── config.ts         #   Phaser 配置与 HUD 事件契约
│       ├── state.svelte.ts   #   运行意图、暂停语义、密钥 tick
│       └── scenes/GameScene.ts  # Phaser 渲染 + 键盘输入（不含规则）
├── tests/                    # Playwright 端到端回归（hex-tab / game-tab / game-sim）
├── docs/game-design.md       # 玩法设计文档（契约：代码注释按 §编号引用它）
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

- **设计文档是契约**：动 `src/game/` 之前先读 [`docs/game-design.md`](docs/game-design.md) —— 那里的 §编号被代码注释直接引用。改文档时**只增不删、不重排编号**（新增小节追加到同章末尾），否则注释里的引用会集体指错。
- **样式集中在 `styles.css`**：不要给组件加 `<style>` 块。颜色统一声明在 `:root`，游戏画布经 `getComputedStyle` 把同一批变量读回去，两边因此不可能漂移。
- **前后端通信**：前端通过 `@tauri-apps/api` 的 `invoke("commandName", args)` 调用 Rust 命令；命令在 `src-tauri/src/lib.rs` 中用 `#[tauri::command]` 定义，并通过 `tauri::generate_handler!` 注册。
- **权限模型**：Tauri v2 使用 `capabilities/*.json` 声明权限。新增命令/窗口需在 `src-tauri/capabilities/default.json` 中声明对应权限。
- **GPU↔CPU 数据布局**：GPU 使用小端 `[u32; 8]` 字序，secp256k1 使用大端 `[u8; 32]`。跨边界时统一走 `gpu/convert.rs`，不要手动重排。
- **应用标识**：`com.jerin.vizluck`（见 `tauri.conf.json` → `identifier`），发布时请替换为你自己的反向域名标识。
- **lib crate 命名**：Rust 库名为 `vizluck_lib`（Cargo.toml 中 `name = "vizluck_lib"`），这是为了避免与二进制名冲突的 Tauri 默认约定，不要随意改动。
- **sha2 的 OS 差异**：macOS/Linux 启用 `asm` 特性（aarch64 上激活 ARMv8-Crypto SHA256，吞吐提升约 3–5×），Windows 使用纯 Rust 实现。配置见 `Cargo.toml` 的 `[target.'cfg(...)'.dependencies]`。
