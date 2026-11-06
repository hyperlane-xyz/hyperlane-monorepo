//! Observations emitted only by actual origin indexing decisions/commits.
const sequence = @import("sequence_cursor.zig");
const block = @import("block_cursor.zig");
const native = @import("../agents/store.zig");
pub const Stream = native.Stream;
pub const Snapshot = struct {
    stream: Stream,
    forward_block: u32,
    forward_sequence: ?u32 = null,
    backward_block: ?u32 = null,
    backward_sequence: ?u32 = null,
    max_sequence: ?u32 = null,
    gap_retry_at: u64 = 0,
    now_ms: u64,
};
pub const Event = union(enum) {
    tree_ingested: u32,
    stored: struct { stream: Stream, count: u64 = 1 },
    completed: Snapshot,
    fetch_backoff: struct { stream: Stream, delay_ms: u64, retry: bool = false },
};
pub const Observer = struct {
    context: *anyopaque,
    notify_fn: *const fn (*anyopaque, Event) void,
    pub fn notify(self: Observer, event: Event) void {
        self.notify_fn(self.context, event);
    }
};
pub fn completed(observer: ?Observer, stream: Stream, cursor: ?*const sequence.Cursor, gas: ?*const block.Cursor, count: ?u32, now_ms: u64) void {
    const sink = observer orelse return;
    if (cursor) |value| {
        sink.notify(.{ .completed = .{
            .stream = stream,
            .forward_block = value.forward.block,
            .forward_sequence = value.forward_last.sequence orelse 0,
            .backward_block = if (value.backward) |point| point.block else value.backward_last.block,
            .backward_sequence = value.backward_last.sequence orelse 0,
            .max_sequence = if (count) |n| n -| 1 else null,
            .gap_retry_at = value.gap_retry_at,
            .now_ms = now_ms,
        } });
    } else if (gas) |value| sink.notify(.{ .completed = .{ .stream = stream, .forward_block = value.next -| 1, .now_ms = now_ms } });
}
/// Only ordinary source transport/RPC failures enter range backoff. Corruption,
/// refusal, persistence and cooperative control retain their original errors.
pub fn retryable(err: anyerror) bool {
    return switch (err) {
        error.RpcError,
        error.RpcResponseDecode,
        error.RpcRateLimited,
        error.RpcHttpStatus,
        error.CurlTransportFailed,
        error.BrokenPipe,
        error.ConnectionResetByPeer,
        error.ConnectionAborted,
        error.ConnectionRefused,
        error.NetworkUnreachable,
        error.HostUnreachable,
        error.SocketNotConnected,
        error.ConnectionTimedOut,
        error.GrpcRemoteStatus,
        error.HttpStatus,
        error.TronApiError,
        => true,
        else => false,
    };
}
