//! Validator scraper-stream controller. Canonical insertion and checkpoint
//! authorization remain injected; no signing keys or concrete DB handles appear
//! here. All completions are generation-tagged and owner-thread only.
const std = @import("std");
const wire = @import("protocol.zig");
const protocol = @import("../../protocol/root.zig");
const A = std.mem.Allocator;
pub const Mode = enum { normal, lightweight };
pub const Config = struct {
    domain: u32,
    hook: [32]u8,
    mode: Mode,
    endpoint_count: usize,
    next_sequence: u32 = 0,
    backfill_target: u32 = 0,
    confirmations: ?u32 = null,
};
pub const Acceptance = enum { accepted, duplicate, foreign };
pub const Origin = struct {
    context: *anyopaque,
    accept_fn: *const fn (*anyopaque, u64, wire.MerkleInsertion, u64) anyerror!Acceptance,
    proof_fn: *const fn (*anyopaque, u64, u32) anyerror!?protocol.Checkpoint,
    persist_cursor_fn: *const fn (*anyopaque, u64, u32) anyerror!void,
};
pub const Canonical = struct {
    context: *anyopaque,
    count_fn: *const fn (*anyopaque, u64, u32, u64) anyerror!u32,
    vote_fn: *const fn (*anyopaque, u64, usize, u64) anyerror!?protocol.Checkpoint,
};
pub const Effect = union(enum) {
    subscribe: []u8,
    accepted: struct { insertion: wire.MerkleInsertion, block_number: u64, next_sequence: u32, advanced: bool },
    probe: struct { sampled_sequence: u32 },
    activate,
    fallback,
    authenticated: protocol.Checkpoint,
    cursor: u32,
    closed: struct { retry_delay_ns: u64, rejected: bool, fallback: bool },
    pub fn deinit(self: *Effect, allocator: A) void {
        if (self.* == .subscribe) allocator.free(self.subscribe);
        self.* = undefined;
    }
};

pub const Controller = struct {
    allocator: A,
    config: Config,
    origin: Origin,
    canonical: Canonical,
    state: wire.SubscriptionState = .awaiting_ready,
    next_sequence: u32,
    caught_up: bool = false,
    activated: bool = false,
    live_anchor: bool = false,
    cutover_target: ?u32 = null,
    health: wire.StreamHealth = .{},
    expected: ?[]wire.SubscribedStream = null,
    next_probe_ns: ?u64 = null,
    generation: u64 = 0,
    generation_open: bool = false,

    pub fn init(allocator: A, config: Config, origin: Origin, canonical: Canonical) !Controller {
        if (config.endpoint_count == 0) return error.InvalidValidatorStreamConfig;
        if (config.mode == .lightweight and config.confirmations != null) return error.LightweightCanonicalReplayRequired;
        return .{ .allocator = allocator, .config = config, .origin = origin, .canonical = canonical, .next_sequence = config.next_sequence };
    }

    pub fn deinit(self: *Controller) void {
        self.clearExpected();
        self.* = undefined;
    }

    fn clearExpected(self: *Controller) void {
        if (self.expected) |expected| wire.freeConfirmation(self.allocator, expected);
        self.expected = null;
    }

    pub fn requiredVotes(self: *const Controller) usize {
        return self.config.endpoint_count - self.config.endpoint_count / 3;
    }

    fn subscription(self: *Controller) !Effect {
        const after_sequence: i64 = if (self.next_sequence == 0) -1 else self.next_sequence - 1;
        const address = try wire.formatAddress(self.allocator, self.config.hook);
        defer self.allocator.free(address);
        const after = try std.fmt.allocPrint(self.allocator, "{d}", .{after_sequence});
        defer self.allocator.free(after);
        const cursors = if (self.config.confirmations == null) try self.allocator.alloc(wire.StreamCursor, 1) else null;
        if (cursors) |values| values[0] = .{ .sequence = .{ .address = address, .allow_replay = true, .after_sequence = after, .domain = self.config.domain } };
        defer if (cursors) |values| self.allocator.free(values);
        const domains = [_]u32{self.config.domain};
        const streams = [_]wire.SubscribeStream{.{ .confirmations = self.config.confirmations, .cursors = if (cursors) |values| values else null, .domains = &domains, .event_type = wire.merkle_event_type }};
        const message: wire.SubscribeMessage = .{ .streams = &streams };
        self.clearExpected();
        self.expected = try wire.confirmation(self.allocator, message);
        return .{ .subscribe = try wire.serializeSubscribe(self.allocator, message) };
    }

    /// Called only for a newly connected transport generation. Retain the
    /// monotonic generation after close so late frames cannot revive an old socket.
    pub fn beginGeneration(self: *Controller, generation: u64) !void {
        if (generation == 0 or generation <= self.generation) return error.StaleStreamGeneration;
        self.clearExpected();
        self.state = .awaiting_ready;
        self.caught_up = false;
        self.activated = false;
        self.live_anchor = false;
        self.cutover_target = null;
        self.next_probe_ns = null;
        self.health.reset();
        self.generation = generation;
        self.generation_open = true;
    }
    pub fn handle(self: *Controller, generation: u64, message: wire.ServerMessage, now_ns: u64) !?Effect {
        if (generation < self.generation or generation == 0) return null;
        if (generation > self.generation) {
            if (message != .ready) return error.StreamGenerationNotReady;
            try self.beginGeneration(generation);
        }
        if (!self.generation_open) return null;
        switch (message) {
            .ready => {
                try self.state.receiveReady();
                return try self.subscription();
            },
            .subscribed => |actual| {
                try self.state.receiveSubscribed();
                const expected = self.expected orelse return error.SubscriptionBeforeRequest;
                try wire.validateSubscription(expected, actual);
                self.clearExpected();
                self.next_probe_ns = now_ns;
                return null;
            },
            .caught_up => |marker| {
                try self.state.requireSubscribed();
                return try self.caughtUp(marker);
            },
            .event => |event| {
                try self.state.requireSubscribed();
                return try self.insertion(event);
            },
            .rollback => {
                try self.state.requireSubscribed();
                return error.StreamRollback;
            },
            .@"error" => return error.RejectedStream,
            .other => return null,
        }
    }

    fn caughtUp(self: *Controller, marker: wire.CaughtUp) !?Effect {
        if (marker.legacy_max_stream_cursor != null or marker.row_id != null or marker.stream_cursor != null) return error.InvalidMerkleCaughtUp;
        if (marker.domain != self.config.domain or !std.mem.eql(u8, marker.event_type, wire.merkle_event_type) or !std.mem.eql(u8, &try wire.parseAddress(self.allocator, marker.address), &self.config.hook)) return error.InvalidMerkleCaughtUp;
        const sequence_text = marker.sequence orelse return error.InvalidMerkleCaughtUp;
        const sequence = std.fmt.parseInt(i64, sequence_text, 10) catch return error.InvalidMerkleCaughtUp;
        if (sequence == -1) {
            if (self.next_sequence != 0) return error.InvalidMerkleCaughtUp;
        } else {
            if (sequence < 0 or sequence >= self.next_sequence) return error.InvalidMerkleCaughtUp;
        }
        const first = !self.caught_up;
        self.caught_up = true;
        const reached = if (sequence == -1) true else @as(u64, @intCast(sequence + 1)) == self.next_sequence;
        if (reached) {
            try self.origin.persist_cursor_fn(self.origin.context, self.generation, self.next_sequence);
            if (first) self.health.reset();
            if (self.config.confirmations == null and self.next_sequence >= self.config.backfill_target) {
                if (self.config.mode == .lightweight and !self.activated) {
                    self.activated = true;
                    return .activate;
                }
                return .{ .cursor = self.next_sequence };
            }
        }
        return null;
    }

    fn insertion(self: *Controller, event: wire.EventMessage) !?Effect {
        if (!std.mem.eql(u8, event.event_type, wire.merkle_event_type) or event.domain != self.config.domain) return error.UnexpectedMerkleEvent;
        if (event.row_id != null or event.stream_cursor != null or event.legacy_max_stream_cursor != null) return error.InvalidMerkleCursor;
        const sequence_text = event.sequence orelse return error.MissingMerkleSequence;
        const sequence = std.fmt.parseInt(u32, sequence_text, 10) catch return error.InvalidMerkleSequence;
        if (self.config.confirmations != null) {
            const actual_hook = try wire.parseAddress(self.allocator, (event.data.object.get("merkle_tree_hook") orelse return error.MissingWireField).string);
            if (!std.mem.eql(u8, &actual_hook, &self.config.hook)) return null;
        }
        const decoded = try wire.decodeMerkleData(self.allocator, event.data, self.config.domain, self.config.hook, sequence);
        if (sequence > self.next_sequence) {
            if (self.config.confirmations == null) return error.MerkleSequenceGap;
            self.cutover_target = @max(self.cutover_target orelse 0, sequence +| 1);
            self.live_anchor = true;
            self.caught_up = true;
            return null;
        }
        const acceptance = try self.origin.accept_fn(self.origin.context, self.generation, decoded.insertion, decoded.block_number);
        if (acceptance == .foreign) return null;
        const advanced = sequence == self.next_sequence;
        if (advanced) {
            self.next_sequence +|= 1;
            if (self.next_sequence % 256 == 0) try self.origin.persist_cursor_fn(self.origin.context, self.generation, self.next_sequence);
        }
        if (self.config.confirmations != null) {
            self.live_anchor = true;
            self.caught_up = true;
            self.cutover_target = @max(self.cutover_target orelse 0, sequence +| 1);
        }
        if (advanced) self.health.recordProgress(self.caught_up);
        return .{ .accepted = .{ .insertion = decoded.insertion, .block_number = decoded.block_number, .next_sequence = self.next_sequence, .advanced = advanced } };
    }

    pub fn tick(self: *Controller, generation: u64, now_ns: u64) !?Effect {
        if (generation != self.generation or !self.generation_open) return null;
        if (self.state != .subscribed or self.config.mode == .lightweight) return null;
        if (self.next_probe_ns) |due| if (now_ns < due) return null;
        self.next_probe_ns = now_ns +| wire.progress_check_ns;
        return .{ .probe = .{ .sampled_sequence = self.next_sequence } };
    }

    pub fn probe(self: *Controller, generation: u64, now_ns: u64) !?Effect {
        if (generation != self.generation or !self.generation_open) return null;
        const sampled = self.next_sequence;
        const count = try self.canonical.count_fn(self.canonical.context, generation, sampled, now_ns);
        return self.completeProbe(generation, sampled, count, now_ns);
    }

    pub fn completeProbe(self: *Controller, generation: u64, sampled_sequence: u32, count: u32, now_ns: u64) !?Effect {
        if (generation != self.generation or !self.generation_open) return null;
        if (self.config.mode == .lightweight) return null;
        if (self.config.confirmations == null and wire.countSampleIsStale(sampled_sequence, self.next_sequence, count)) return null;
        if (self.config.confirmations != null and self.next_sequence > count) {
            if (!self.health.observeProbeFailure(now_ns)) return error.StreamCursorAhead;
        } else {
            _ = try self.health.observe(count, self.next_sequence, self.config.mode == .normal and !self.activated, now_ns);
        }
        if (!self.caught_up or self.activated or self.next_sequence < self.config.backfill_target) return null;
        if (self.config.confirmations != null and !self.live_anchor) return null;
        if (self.cutover_target) |target| if (self.next_sequence < target) return null;
        const fresh = if (self.config.confirmations == null) try wire.validateCutoverFreshness(count, self.next_sequence) else self.next_sequence >= count;
        if (!fresh) {
            self.cutover_target = count;
            return null;
        }
        self.cutover_target = null;
        self.activated = true;
        return .activate;
    }

    pub fn probeFailure(self: *Controller, now_ns: u64) !void {
        if (!self.health.observeProbeFailure(now_ns)) return error.StreamStale;
    }

    pub fn authenticate(self: *Controller, generation: u64, now_ns: u64) !?Effect {
        if (generation != self.generation or !self.generation_open) return null;
        if (self.config.mode != .lightweight or !self.activated) return null;
        const required = self.requiredVotes();
        var matches = std.ArrayList(protocol.Checkpoint).empty;
        defer matches.deinit(self.allocator);
        for (0..self.config.endpoint_count) |slot| {
            // Failed endpoints keep their slots in the fixed denominator.
            const observed = (self.canonical.vote_fn(self.canonical.context, generation, slot, now_ns) catch null) orelse continue;
            const local = (try self.origin.proof_fn(self.origin.context, generation, observed.index)) orelse continue;
            if (observed.index != local.index or observed.mailbox_domain != self.config.domain or !std.mem.eql(u8, &observed.merkle_tree_hook_address, &self.config.hook) or !std.mem.eql(u8, &observed.root, &local.root)) continue;
            if (observed.mailbox_domain != local.mailbox_domain or !std.mem.eql(u8, &observed.merkle_tree_hook_address, &local.merkle_tree_hook_address)) continue;
            try matches.append(self.allocator, local);
        }
        if (matches.items.len >= required) {
            // Source submit.rs accepts the required-th highest independently
            // authenticated local prefix, including mixed endpoint heights.
            std.mem.sort(protocol.Checkpoint, matches.items, {}, struct {
                fn less(_: void, left: protocol.Checkpoint, right: protocol.Checkpoint) bool {
                    return left.index > right.index;
                }
            }.less);
            return .{ .authenticated = matches.items[required - 1] };
        }
        return error.CheckpointAgreementUnavailable;
    }

    pub fn close(self: *Controller, rejected: bool) Effect {
        self.clearExpected();
        self.state = .awaiting_ready;
        self.caught_up = false;
        self.activated = false;
        self.live_anchor = false;
        self.cutover_target = null;
        self.next_probe_ns = null;
        self.generation_open = false;
        self.health.reset();
        return .{ .closed = .{ .retry_delay_ns = wire.streamRetryDelay(self.config.domain, rejected), .rejected = rejected, .fallback = self.config.mode == .normal } };
    }
};
