/// A loop control operation.
#[must_use]
#[derive(Debug, Copy, Clone)]
pub enum LoopControl {
    /// No op, just flow through the rest of the loop normally
    Flow,
    /// Inject `continue` and run next loop iteration
    Continue,
    /// Inject `break` and end the loop
    Break,
}

impl Default for LoopControl {
    fn default() -> Self {
        LoopControl::Flow
    }
}

/// Handle a loop control operation. This must be called directly within a loop.
#[macro_export]
macro_rules! loop_ctrl {
    ($ctrl:expr) => {
        match $ctrl {
            ::loop_control::LoopControl::Flow => {},
            ::loop_control::LoopControl::Continue => { continue; },
            ::loop_control::LoopControl::Break => { break; },
        }
    }
}
