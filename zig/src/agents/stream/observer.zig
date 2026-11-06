//! Source-defined relayer WS telemetry. Caller owns the borrowed context and
//! chain label until callbacks return; no request, event body or URL is retained.
pub const Kind = enum { dispatch, gas_payment, merkle_tree_insertion };
pub const SequencedKind = enum {
    dispatch,
    merkle_tree_insertion,
    pub fn cursorLabel(self: SequencedKind) []const u8 {
        return switch (self) {
            .dispatch => "hyperlane_message",
            .merkle_tree_insertion => "merkle_tree_insertion",
        };
    }
};
pub const EventType = enum { dispatch, gas_payment, merkle_tree_insertion, unknown };
pub const EventResult = enum { accepted, duplicate, shadow, dropped, invalid, conflict, caught_up, gap };
pub const ParityResult = enum { match, conflict, expired, @"error" };
pub const State = struct {
    /// A validated Subscribed reply, not merely a connected socket.
    active: ?bool = null,
    /// Completed RPC-pause acknowledgement, not a desired authority command.
    authority: ?bool = null,
    /// Exact canonical agreement; grace may retain authority while this is false.
    fresh: ?bool = null,
};
pub const Stream = struct {
    kind: Kind,
    caught_up: ?bool = null,
    /// Source currently produces this gauge for gas payments only.
    degraded: ?bool = null,
    /// Source sequenced streams only, including staged, queued and in-flight.
    parity_pending: ?usize = null,
    parity_ready: ?bool = null,
};
pub const Change = union(enum) {
    /// Once per origin attachment. Mirrors Source constructor zero samples.
    initial,
    state: State,
    stream: Stream,
    event: struct { kind: EventType, result: EventResult },
    /// Only terminal parity; transient Missing retries do not increment.
    parity: struct { kind: SequencedKind, result: ParityResult },
    /// Current+max after durable cursor write/replay. max_only is canonical
    /// count.checked_sub(1) during a freshness probe, never count itself.
    cursor: struct { kind: SequencedKind, sequence: u32, max_only: bool = false },
};
pub const Observer = struct {
    context: *anyopaque,
    notify_fn: *const fn (*anyopaque, []const u8, Change) void,
    pub fn notify(self: Observer, chain: []const u8, change: Change) void {
        self.notify_fn(self.context, chain, change);
    }
};
