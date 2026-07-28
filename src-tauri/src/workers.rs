//! Worker pool orchestration.
//!
//! This is a trimmed-down re-export of the `luckfind` worker types referenced by
//! the GPU module (`gpu/lottery.rs`). The full worker pool that spawns CPU
//! threads lives in the upstream crate; here we expose just the shared types so
//! the GPU scanner and lottery worker compile. Bring in the full `run()` pool
//! when wiring up CPU-side scanning in the Tauri app.

use crate::puzzles::PuzzleSet;

/// Runtime limits for the worker pool.
pub struct RuntimeLimits {
    pub duration_secs: Option<f64>,
    pub heartbeat_secs: f64,
}

/// What the lottery workers scan against.
pub enum ScanTarget {
    /// Embedded 78 puzzles, range-constrained key generation in [2^70, 2^160).
    PuzzleSet(&'static PuzzleSet),
}

/// Match surfaced by the pool.
#[derive(Debug, Clone)]
pub struct MatchEvent {
    pub private_key: [u8; 32],
    pub compressed: Vec<u8>,
    pub uncompressed: Vec<u8>,
    pub worker_id: u32,
    pub chunk_id: Option<u32>, // puzzle-mode: which worklist chunk this came from (None = lottery)
    pub key_index: u64,
    pub elapsed: f64,
    /// Which embedded puzzle matched (lottery mode).  None in Full256 mode.
    pub puzzle_number: Option<u32>,
}
