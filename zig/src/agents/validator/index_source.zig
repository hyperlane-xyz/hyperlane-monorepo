//! Validator insertion reads over existing independently owned index clients.
//! Ordinary peer failures are exhausted before Core schedules one failed-range
//! retry. The wrapper owns no transport and never changes checkpoint voters.
const std = @import("std");
const source = @import("../scraper/source.zig");
const observation = @import("../../runtime/indexing_observer.zig");
pub const Fallback = struct {
    context: *anyopaque,
    current_fn: *const fn (*anyopaque) anyerror!source.Source,
    advance_fn: *const fn (*anyopaque) anyerror!void,
    bind_fn: *const fn (*anyopaque, ?*const std.atomic.Value(bool)) void,
    endpoint_count: usize,
    /// Only direct native indexer resources: libcurl's per-request timeout uses
    /// RequestDeadlineExceeded too. Cooperative/injected sources leave false.
    native_timeouts: bool = false,
    cancel: ?*const std.atomic.Value(bool) = null,

    fn checked(self: *Fallback) !void {
        if (self.endpoint_count == 0 or self.endpoint_count > 256) return error.InvalidValidatorIndexerEndpoints;
        if (self.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
    }
    fn retry(self: *Fallback, attempted: *usize, err: anyerror) !void {
        const failure = if (self.native_timeouts and err == error.RequestDeadlineExceeded) error.ConnectionTimedOut else err;
        if (!observation.retryable(failure)) return err;
        try self.checked();
        attempted.* += 1;
        if (attempted.* >= self.endpoint_count) return failure;
        // The owner replaces only its event client. Core's cursor and failed
        // union remain bound to this stable wrapper, never the old client.
        try self.advance_fn(self.context);
    }
    fn current(self: *Fallback, attempted: *usize) !source.Source {
        while (true) {
            try self.checked();
            const value = self.current_fn(self.context) catch |err| {
                try self.retry(attempted, err);
                continue;
            };
            if (value.read_section != null) return error.UnexpectedValidatorIndexerReadJournal;
            return value;
        }
    }
    pub fn interface(self: *Fallback) !source.Source {
        var attempted: usize = 0;
        const value = try self.current(&attempted);
        return .{ .context = self, .header_fn = header, .events_fn = events, .stream_tip_fn = tip, .raw_sequence_fn = raw, .range_fn = rangeEnd, .begin_fn = begin, .cancel_fn = bind, .sequence_mode = value.sequence_mode, .historical_counts = value.historical_counts, .transaction_authority_fn = if (value.transaction_authority_fn != null) authority else null };
    }
    fn cast(context: *anyopaque) *Fallback {
        return @ptrCast(@alignCast(context));
    }
    fn bind(context: *anyopaque, cancel: ?*const std.atomic.Value(bool)) void {
        const self = cast(context);
        self.cancel = cancel;
        self.bind_fn(self.context, cancel);
    }
    fn authority(context: *anyopaque) !source.TransactionAuthority {
        const self = cast(context);
        var attempted: usize = 0;
        const value = try self.current(&attempted);
        const callback = value.transaction_authority_fn orelse return error.MissingTransactionAuthority;
        return callback(value.context);
    }
    fn header(context: *anyopaque, selector: source.Selector, fresh: bool) !source.Header {
        const self = cast(context);
        var attempted: usize = 0;
        while (true) {
            const value = try self.current(&attempted);
            return value.header_fn(value.context, selector, fresh) catch |err| {
                try self.retry(&attempted, err);
                continue;
            };
        }
    }
    fn begin(context: *anyopaque) !void {
        const self = cast(context);
        var attempted: usize = 0;
        while (true) {
            const value = try self.current(&attempted);
            return value.beginCycle() catch |err| {
                try self.retry(&attempted, err);
                continue;
            };
        }
    }
    fn rangeEnd(context: *anyopaque, after: u64, through: u64, head: u64, fresh: bool) !source.Header {
        const self = cast(context);
        var attempted: usize = 0;
        while (true) {
            const value = try self.current(&attempted);
            return value.rangeEnd(after, through, head, fresh) catch |err| {
                try self.retry(&attempted, err);
                continue;
            };
        }
    }
    fn tip(context: *anyopaque, stream: usize) !source.Tip {
        const self = cast(context);
        var attempted: usize = 0;
        while (true) {
            const value = try self.current(&attempted);
            return value.streamTip(stream) catch |err| {
                try self.retry(&attempted, err);
                continue;
            };
        }
    }
    fn events(context: *anyopaque, a: std.mem.Allocator, from: u64, through: u64, sequences: [4]u32) !source.Batch {
        const self = cast(context);
        var attempted: usize = 0;
        while (true) {
            const value = try self.current(&attempted);
            return value.events(a, from, through, sequences) catch |err| {
                try self.retry(&attempted, err);
                continue;
            };
        }
    }
    fn raw(context: *anyopaque, a: std.mem.Allocator, stream: usize, from: u32, through: u32) !source.Batch {
        const self = cast(context);
        var attempted: usize = 0;
        while (true) {
            const value = try self.current(&attempted);
            return value.rawSequence(a, stream, from, through) catch |err| {
                try self.retry(&attempted, err);
                continue;
            };
        }
    }
};

test "transaction-ID validator wrapper forwards current protocol authority and preserves absent capability" {
    const Fixture = struct {
        const Peer = struct { marker: u8, live: bool = true };
        peers: [2]Peer = .{ .{ .marker = 1 }, .{ .marker = 2 } },
        selected: usize = 0,
        enabled: bool = true,
        fn current(ctx: *anyopaque) !source.Source {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return .{ .context = &self.peers[self.selected], .header_fn = header_, .events_fn = events_, .transaction_authority_fn = if (self.enabled) authority_ else null };
        }
        fn advance(ctx: *anyopaque) !void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.peers[self.selected].live = false;
            self.selected = 1;
        }
        fn bind_(_: *anyopaque, _: ?*const std.atomic.Value(bool)) void {}
        fn header_(ctx: *anyopaque, _: source.Selector, _: bool) !source.Header {
            const peer: *Peer = @ptrCast(@alignCast(ctx));
            if (peer.marker == 1) return error.ConnectionResetByPeer;
            return .{ .height = 2, .hash = @splat(2), .parent = @splat(1), .timestamp = 0 };
        }
        fn events_(_: *anyopaque, _: std.mem.Allocator, _: u64, _: u64, _: [4]u32) !source.Batch {
            return error.UnexpectedEvents;
        }
        fn authority_(ctx: *anyopaque) !source.TransactionAuthority {
            const peer: *Peer = @ptrCast(@alignCast(ctx));
            if (!peer.live) return error.StaleEndpointContext;
            return .{ .emitters = .{ .mailbox = @splat(peer.marker), .hook = @splat(peer.marker + 10), .paymaster = @splat(peer.marker + 10) }, .positions = .per_emitter_stream };
        }
    };
    var fixture: Fixture = .{};
    var wrapper: Fallback = .{ .context = &fixture, .current_fn = Fixture.current, .advance_fn = Fixture.advance, .bind_fn = Fixture.bind_, .endpoint_count = 2 };
    const value = try wrapper.interface();
    const logical: source.Contracts = .{ .mailbox = @splat(5), .hook = @splat(6), .paymaster = @splat(7) };
    try std.testing.expectEqual(@as(u8, 11), (try value.transactionAuthority(logical)).emitters.hook[0]);
    _ = try value.header(.latest); // retires the first endpoint/context
    const actual = try value.transactionAuthority(logical);
    try std.testing.expectEqual(@as(u8, 12), actual.emitters.hook[0]);
    try std.testing.expectEqual(actual.emitters.hook, actual.emitters.paymaster);
    try std.testing.expectEqual(.per_emitter_stream, actual.positions);
    var cancel = std.atomic.Value(bool).init(true);
    value.bindCancellation(&cancel);
    try std.testing.expectError(error.RequestCancelled, value.transactionAuthority(logical));
    value.bindCancellation(null);
    fixture.enabled = false;
    const plain = try wrapper.interface();
    try std.testing.expect(plain.transaction_authority_fn == null);
    try std.testing.expectEqual(logical, (try plain.transactionAuthority(logical)).emitters);
}
