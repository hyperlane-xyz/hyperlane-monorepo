//! Source-backed scraper authority, replay parity and RPC fallback control.
//! Transport readers call validation/plan methods only. Rocks parity and canonical
//! RPC work belongs in independent bounded jobs tagged with connection generation.
const std = @import("std");
const protocol = @import("../../protocol/root.zig");
const store = @import("relayer_store.zig");

pub const EventKind = store.EventKind;
pub const Contracts = store.Contracts;
pub const ParityInput = store.ParityInput;
pub const DispatchInput = store.DispatchInput;
pub const MerkleInput = store.MerkleInput;
pub const GasPaymentInput = store.GasPaymentInput;
pub const GasPaymentCursor = store.GasPaymentCursor;
pub const ParityResult = store.ParityResult;
pub const DUPLICATE_FINGERPRINT_WINDOW = 1024;
pub const GAS_PAYMENT_STREAM_CURSOR_VERSION = 3;

pub const Options = struct {
    authority_enabled: bool,
    parity_queue_capacity: usize = 256,
    parity_staged_body_bytes: usize = 16 * 1024 * 1024,
    parity_pending_capacity: usize = 4096,
    parity_cap_exempt_pending: usize = 16,
    parity_retry_attempts: usize = 300,
    parity_retry_delay_ms: u64 = 1000,
    progress_grace_ms: u64 = 300000,
    authoritative_probe_interval_ms: u64 = 120000,
    pub fn validate(self: Options) !void {
        if (self.parity_queue_capacity == 0 or self.parity_pending_capacity == 0 or
            self.parity_retry_attempts == 0 or self.parity_retry_delay_ms == 0 or
            self.progress_grace_ms == 0 or self.authoritative_probe_interval_ms == 0) return error.InvalidAuthorityOptions;
    }
};

pub const Source = struct {
    domain: u32,
    adapter: *store.Adapter,
};

pub const AuthorityCommand = struct {
    desired: bool,
    generation: u64,
};

pub const AuthorityObservation = struct {
    active: bool,
    fresh: bool,
};

pub const StreamObservation = struct {
    caught_up: bool,
    degraded: bool,
    parity_pending: usize,
    parity_ready: bool,
};

pub const Subscription = struct {
    address: [32]u8,
    after_sequence: ?i64,
    after_stream_cursor: ?u64,
    stream_cursor_version: ?u32,
};

pub const SequenceResult = enum { accepted, duplicate };
pub const GasEventResult = enum { accepted, duplicate, shadow, dropped, conflict };
pub const ParityStep = enum { idle, pending, matched, conflict, expired, stale_generation };
pub const Action = enum { none, probe, cutover };

const StreamCursor = struct {
    fingerprints: std.AutoHashMap(u32, [32]u8),
    order: std.ArrayList(u32) = .empty,
    first_sequence: ?u32 = null,
    next_sequence: u32,

    fn init(allocator: std.mem.Allocator, next_sequence: u32) StreamCursor {
        return .{ .fingerprints = std.AutoHashMap(u32, [32]u8).init(allocator), .next_sequence = next_sequence };
    }
    fn fromAfter(allocator: std.mem.Allocator, sequence: u32) !StreamCursor {
        return init(allocator, std.math.add(u32, sequence, 1) catch return error.StreamSequenceExhausted);
    }
    fn deinit(self: *StreamCursor) void {
        const allocator = self.fingerprints.allocator;
        self.fingerprints.deinit();
        self.order.deinit(allocator);
    }
    fn check(self: *const StreamCursor, sequence: u32, fingerprint: [32]u8) !SequenceResult {
        if (sequence < self.next_sequence) {
            const previous = self.fingerprints.get(sequence) orelse return error.StreamSequenceOutsideDuplicateWindow;
            if (!std.mem.eql(u8, &previous, &fingerprint)) return error.ConflictingStreamSequence;
            return .duplicate;
        }
        if (sequence > self.next_sequence) return error.StreamGap;
        _ = std.math.add(u32, self.next_sequence, 1) catch return error.StreamSequenceExhausted;
        return .accepted;
    }
    fn accept(self: *StreamCursor, sequence: u32, fingerprint: [32]u8) !void {
        try self.fingerprints.ensureUnusedCapacity(1);
        try self.order.ensureUnusedCapacity(self.fingerprints.allocator, 1);
        self.first_sequence = self.first_sequence orelse sequence;
        self.next_sequence = std.math.add(u32, self.next_sequence, 1) catch return error.StreamSequenceExhausted;
        self.fingerprints.putAssumeCapacity(sequence, fingerprint);
        self.order.appendAssumeCapacity(sequence);
        if (self.order.items.len > DUPLICATE_FINGERPRINT_WINDOW) {
            const oldest = self.order.orderedRemove(0);
            _ = self.fingerprints.remove(oldest);
        }
    }
    fn latest(self: *const StreamCursor) !u32 {
        return std.math.sub(u32, self.next_sequence, 1);
    }
};

const Health = struct {
    lag_started_ms: ?u64 = null,
    grace_ms: u64,
    fn reset(self: *Health) void {
        self.lag_started_ms = null;
    }
    fn observe(self: *Health, count: u32, next: u32, authoritative: bool, now_ms: u64) !bool {
        if (next > count) return error.CanonicalCursorAhead;
        if (count <= next) {
            self.reset();
            return true;
        }
        if (!authoritative) return false;
        const started = self.lag_started_ms orelse blk: {
            self.lag_started_ms = now_ms;
            break :blk now_ms;
        };
        return now_ms - started < self.grace_ms;
    }
    fn observeFailure(self: *Health, authoritative: bool, now_ms: u64) bool {
        if (!authoritative) return false;
        const started = self.lag_started_ms orelse blk: {
            self.lag_started_ms = now_ms;
            break :blk now_ms;
        };
        return now_ms - started < self.grace_ms;
    }
};

const Pending = struct {
    input: ParityInput,
    sequence: u32,
    generation: u64,
    attempts: usize = 0,
    next_retry_ms: u64 = 0,
    owned_body: ?[]u8,
    fn deinit(self: *Pending, allocator: std.mem.Allocator) void {
        if (self.owned_body) |body| allocator.free(body);
    }
};

const SequencedStream = struct {
    kind: EventKind,
    cursor: ?StreamCursor,
    caught_up_sequence: ?i64 = null,
    caught_up: bool = false,
    rejected_fresh_marker: ?u32 = null,
    pending: std.ArrayList(Pending) = .empty,
    overflowed: bool = false,
    unhealthy: bool,

    fn init(allocator: std.mem.Allocator, adapter: *store.Adapter, kind: EventKind) !SequencedStream {
        const floor = try adapter.cursor(kind);
        return .{
            .kind = kind,
            .cursor = if (floor) |sequence| StreamCursor.init(allocator, sequence) else null,
            .unhealthy = try adapter.parityUnhealthy(kind),
        };
    }
    fn deinit(self: *SequencedStream, allocator: std.mem.Allocator) void {
        if (self.cursor) |*cursor| cursor.deinit();
        for (self.pending.items) |*pending| pending.deinit(allocator);
        self.pending.deinit(allocator);
    }
    fn validateFreshBaseline(self: *const SequencedStream, sequence: i64) !void {
        const cursor = self.cursor orelse return;
        const first = cursor.first_sequence orelse return;
        const expected_i64 = try std.math.add(i64, sequence, 1);
        const expected = std.math.cast(u32, expected_i64) orelse return error.StreamSequenceExhausted;
        if (first != expected) return error.InvalidFreshStreamBaseline;
    }
    fn setBaseline(self: *SequencedStream, allocator: std.mem.Allocator, sequence: i64) !void {
        if (self.cursor != null or sequence < 0) return;
        self.cursor = try StreamCursor.fromAfter(allocator, std.math.cast(u32, sequence) orelse return error.StreamSequenceOverflow);
    }
    fn latest(self: *const SequencedStream) !?u32 {
        const cursor = self.cursor orelse return null;
        if (cursor.next_sequence == 0) return null;
        return try cursor.latest();
    }
};

const GasStream = struct {
    cursor: ?GasPaymentCursor,
    caught_up: bool = false,
    degraded: bool = false,
};

const Origin = struct {
    domain: u32,
    adapter: *store.Adapter,
    dispatch: SequencedStream,
    merkle: SequencedStream,
    gas: GasStream,
    ready: bool = false,
    gas_enabled: bool = false,
    subscribed: bool = false,
    fresh: bool = false,
    active: bool = false,
    desired: bool = false,
    command_generation: u64 = 0,
    connection_generation: u64 = 0,
    cutover_pending: bool = false,
    paused_generation: ?u64 = null,
    ahead_probe: bool = false,
    last_fresh_probe_ms: ?u64 = null,
    health: [2]Health,

    fn deinit(self: *Origin, allocator: std.mem.Allocator) void {
        self.dispatch.deinit(allocator);
        self.merkle.deinit(allocator);
    }
    fn sequenced(self: *Origin, kind: EventKind) *SequencedStream {
        return switch (kind) {
            .dispatch => &self.dispatch,
            .merkle_tree_insertion => &self.merkle,
            .gas_payment => unreachable,
        };
    }
};

pub const ProbePlan = struct {
    domain: u32,
    generation: u64,
    dispatch_cursor: ?u32,
    merkle_cursor: ?u32,
};

pub const CanonicalCounts = struct {
    dispatch: ?u32,
    merkle_tree_insertion: ?u32,
};

pub const Controller = struct {
    allocator: std.mem.Allocator,
    options: Options,
    origins: std.AutoHashMap(u32, *Origin),
    total_pending: usize = 0,
    total_body_bytes: usize = 0,

    pub fn init(allocator: std.mem.Allocator, sources: []const Source, options: Options) !Controller {
        try options.validate();
        var self: Controller = .{
            .allocator = allocator,
            .options = options,
            .origins = std.AutoHashMap(u32, *Origin).init(allocator),
        };
        errdefer self.deinit();
        try self.origins.ensureTotalCapacity(@intCast(sources.len));
        for (sources) |source| {
            if (self.origins.contains(source.domain)) return error.DuplicateAuthoritySource;
            const origin = try allocator.create(Origin);
            errdefer allocator.destroy(origin);
            origin.* = undefined;
            origin.domain = source.domain;
            origin.adapter = source.adapter;
            origin.dispatch = try SequencedStream.init(allocator, source.adapter, .dispatch);
            errdefer origin.dispatch.deinit(allocator);
            origin.merkle = try SequencedStream.init(allocator, source.adapter, .merkle_tree_insertion);
            errdefer origin.merkle.deinit(allocator);
            origin.gas = .{ .cursor = try source.adapter.gasPaymentCursor() };
            origin.health = .{
                .{ .grace_ms = options.progress_grace_ms },
                .{ .grace_ms = options.progress_grace_ms },
            };
            origin.ready = false;
            origin.gas_enabled = false;
            origin.subscribed = false;
            origin.fresh = false;
            origin.active = false;
            origin.desired = false;
            origin.command_generation = 0;
            origin.connection_generation = 0;
            origin.cutover_pending = false;
            origin.paused_generation = null;
            origin.ahead_probe = false;
            origin.last_fresh_probe_ms = null;
            self.origins.putAssumeCapacity(source.domain, origin);
        }
        return self;
    }

    pub fn deinit(self: *Controller) void {
        var iterator = self.origins.valueIterator();
        while (iterator.next()) |origin| {
            origin.*.deinit(self.allocator);
            self.allocator.destroy(origin.*);
        }
        self.origins.deinit();
    }

    fn getOrigin(self: *Controller, domain: u32) !*Origin {
        return self.origins.get(domain) orelse error.UnknownAuthoritySource;
    }

    fn requireGeneration(origin: *Origin, generation: u64) !void {
        if (origin.connection_generation != generation) return error.StaleConnectionGeneration;
    }

    pub fn connectionGeneration(self: *Controller, domain: u32) !u64 {
        return (try self.getOrigin(domain)).connection_generation;
    }

    pub fn command(self: *Controller, domain: u32) !AuthorityCommand {
        const origin = try self.getOrigin(domain);
        return .{ .desired = origin.desired, .generation = origin.command_generation };
    }

    pub fn rpcRequired(self: *Controller, domain: u32) !bool {
        return !(try self.getOrigin(domain)).active;
    }

    pub fn gasAuthority(self: *Controller, domain: u32) !bool {
        const origin = try self.getOrigin(domain);
        return self.options.authority_enabled and origin.active and origin.subscribed and origin.gas_enabled and origin.gas.caught_up and !origin.gas.degraded;
    }

    pub fn authorityObservation(self: *Controller, domain: u32) !AuthorityObservation {
        const origin = try self.getOrigin(domain);
        return .{ .active = origin.active, .fresh = origin.fresh };
    }

    pub fn streamObservation(self: *Controller, domain: u32, kind: EventKind) !StreamObservation {
        const origin = try self.getOrigin(domain);
        if (kind == .gas_payment) return .{
            .caught_up = origin.gas.caught_up,
            .degraded = origin.gas.degraded,
            .parity_pending = 0,
            .parity_ready = false,
        };
        const stream = origin.sequenced(kind);
        return .{
            .caught_up = stream.caught_up,
            .degraded = stream.unhealthy or stream.overflowed,
            .parity_pending = stream.pending.items.len,
            .parity_ready = parityReady(stream),
        };
    }

    pub fn subscription(self: *Controller, domain: u32, kind: EventKind) !Subscription {
        const origin = try self.getOrigin(domain);
        if (kind == .gas_payment) {
            return .{
                .address = origin.adapter.contracts.interchain_gas_paymaster,
                .after_sequence = null,
                .after_stream_cursor = if (origin.gas.cursor) |cursor| cursor.stream_cursor else null,
                .stream_cursor_version = GAS_PAYMENT_STREAM_CURSOR_VERSION,
            };
        }
        const floor = try origin.adapter.cursor(kind);
        return .{
            .address = origin.adapter.contracts.address(kind),
            .after_sequence = if (floor) |sequence| @as(i64, sequence) - 1 else null,
            .after_stream_cursor = null,
            .stream_cursor_version = null,
        };
    }

    pub fn revoke(self: *Controller, domain: u32) !void {
        const origin = try self.getOrigin(domain);
        origin.active = false;
        origin.desired = false;
        origin.cutover_pending = false;
        origin.paused_generation = null;
        origin.fresh = false;
        origin.ahead_probe = false;
        origin.last_fresh_probe_ms = null;
        origin.health[0].reset();
        origin.health[1].reset();
    }

    fn clearPending(self: *Controller, stream: *SequencedStream) void {
        for (stream.pending.items) |*pending| {
            self.total_pending -= 1;
            self.total_body_bytes -= pending.input.bodyBytes();
            pending.deinit(self.allocator);
        }
        stream.pending.clearRetainingCapacity();
    }

    fn resetStream(self: *Controller, origin: *Origin, kind: EventKind) !void {
        const stream = origin.sequenced(kind);
        self.clearPending(stream);
        stream.pending.deinit(self.allocator);
        if (stream.cursor) |*cursor| cursor.deinit();
        const floor = try origin.adapter.cursor(kind);
        stream.* = .{
            .kind = kind,
            .cursor = if (floor) |sequence| StreamCursor.init(self.allocator, sequence) else null,
            .unhealthy = try origin.adapter.parityUnhealthy(kind),
        };
    }

    pub fn beginConnection(self: *Controller, domain: u32) !u64 {
        const origin = try self.getOrigin(domain);
        try self.revoke(domain);
        origin.ready = false;
        origin.gas_enabled = false;
        origin.subscribed = false;
        origin.connection_generation = try std.math.add(u64, origin.connection_generation, 1);
        origin.gas.caught_up = false;
        origin.gas.degraded = false;
        origin.gas.cursor = try origin.adapter.gasPaymentCursor();
        try self.resetStream(origin, .dispatch);
        try self.resetStream(origin, .merkle_tree_insertion);
        return origin.connection_generation;
    }

    pub fn markReady(self: *Controller, domain: u32, generation: u64, gas_cursor_version: ?u32) !void {
        const origin = try self.getOrigin(domain);
        try requireGeneration(origin, generation);
        errdefer self.revoke(domain) catch {};
        if (origin.ready) return error.DuplicateReady;
        origin.ready = true;
        origin.gas_enabled = gas_cursor_version == GAS_PAYMENT_STREAM_CURSOR_VERSION;
        origin.gas.degraded = !origin.gas_enabled;
    }

    pub fn markSubscribed(self: *Controller, domain: u32, generation: u64) !void {
        const origin = try self.getOrigin(domain);
        try requireGeneration(origin, generation);
        errdefer self.revoke(domain) catch {};
        if (!origin.ready) return error.SubscribedBeforeReady;
        if (origin.subscribed) return error.DuplicateSubscription;
        origin.subscribed = true;
    }

    fn updateCaughtUp(_: *Controller, origin: *Origin, kind: EventKind) !void {
        const stream = origin.sequenced(kind);
        const baseline = stream.caught_up_sequence orelse {
            stream.caught_up = false;
            return;
        };
        if (baseline < 0) {
            try stream.validateFreshBaseline(baseline);
            stream.caught_up = true;
            return;
        }
        const latest = try stream.latest() orelse {
            stream.caught_up = false;
            return;
        };
        stream.caught_up = latest >= std.math.cast(u32, baseline) orelse return error.StreamSequenceOverflow;
    }

    pub fn acceptCaughtUp(self: *Controller, domain: u32, generation: u64, kind: EventKind, address: [32]u8, sequence: i64) !void {
        if (kind == .gas_payment) return error.UseGasCaughtUp;
        const origin = try self.getOrigin(domain);
        try requireGeneration(origin, generation);
        errdefer self.revoke(domain) catch {};
        if (!origin.subscribed) return error.EventBeforeSubscription;
        if (!std.mem.eql(u8, &address, &origin.adapter.contracts.address(kind))) return error.ContractAddressMismatch;
        if (sequence < -1) return error.InvalidCaughtUpSequence;
        const stream = origin.sequenced(kind);
        if (stream.caught_up_sequence != null) return error.DuplicateCaughtUpMarker;
        const floor = try origin.adapter.cursor(kind);
        if (floor != null and sequence < floor.?) return error.CaughtUpBehindDurableFloor;
        if (floor == null) try stream.validateFreshBaseline(sequence);
        try stream.setBaseline(self.allocator, sequence);
        stream.caught_up_sequence = sequence;
        if (floor == null and sequence >= 0) {
            const trusted = stream.pending.items.len == 0 and !stream.overflowed and
                try origin.adapter.localEventPresent(kind, std.math.cast(u32, sequence) orelse return error.StreamSequenceOverflow);
            if (trusted) {
                try origin.adapter.storeCursor(kind, std.math.cast(u32, sequence) orelse unreachable);
                origin.fresh = false;
            } else {
                stream.rejected_fresh_marker = std.math.cast(u32, sequence) orelse unreachable;
            }
        }
        try self.updateCaughtUp(origin, kind);
    }

    pub fn retryFreshMarkers(self: *Controller, domain: u32) !void {
        const origin = try self.getOrigin(domain);
        for ([_]EventKind{ .dispatch, .merkle_tree_insertion }) |kind| {
            const stream = origin.sequenced(kind);
            const sequence = stream.rejected_fresh_marker orelse continue;
            if (try origin.adapter.cursor(kind)) |cursor| {
                if (cursor >= sequence) {
                    stream.rejected_fresh_marker = null;
                    continue;
                }
            }
            if (stream.pending.items.len != 0 or stream.overflowed or !try origin.adapter.localEventPresent(kind, sequence)) continue;
            try origin.adapter.storeCursor(kind, sequence);
            stream.rejected_fresh_marker = null;
            origin.fresh = false;
        }
    }

    pub fn acceptGasCaughtUp(self: *Controller, domain: u32, generation: u64, address: [32]u8, legacy_max_stream_cursor: u64, stream_cursor: u64) !GasEventResult {
        const origin = try self.getOrigin(domain);
        try requireGeneration(origin, generation);
        errdefer self.revoke(domain) catch {};
        if (!origin.subscribed) return error.EventBeforeSubscription;
        if (!origin.gas_enabled) return error.GasCursorUnsupported;
        if (origin.gas.degraded) return .dropped;
        if (origin.gas.caught_up) return error.DuplicateCaughtUpMarker;
        if (!std.mem.eql(u8, &address, &origin.adapter.contracts.interchain_gas_paymaster)) return error.ContractAddressMismatch;
        const cursor = if (origin.gas.cursor) |previous| blk: {
            if (previous.stream_cursor != stream_cursor or previous.legacy_max_stream_cursor != legacy_max_stream_cursor) return error.GasCaughtUpCursorMismatch;
            break :blk previous;
        } else blk: {
            if (stream_cursor != 0) return error.GasCaughtUpSkippedHistory;
            break :blk GasPaymentCursor{ .fingerprint = null, .legacy_max_stream_cursor = legacy_max_stream_cursor, .stream_cursor = stream_cursor };
        };
        if (self.options.authority_enabled) try origin.adapter.storeGasPaymentCursor(cursor);
        origin.gas.cursor = cursor;
        origin.gas.caught_up = true;
        return .accepted;
    }

    fn persistenceReady(stream: *const SequencedStream, floor: ?u32, sequence: u32) !bool {
        if (floor != null) return true;
        const baseline = stream.caught_up_sequence orelse return false;
        try stream.validateFreshBaseline(baseline);
        const expected = try std.math.add(i64, baseline, 1);
        return sequence >= expected;
    }

    fn stage(self: *Controller, origin: *Origin, kind: EventKind, input: ParityInput, fingerprint: [32]u8) !SequenceResult {
        const stream = origin.sequenced(kind);
        if (stream.overflowed) return error.ParityOverflow;
        if (stream.unhealthy) return error.ParityUnhealthy;
        const sequence = input.sequence();
        var result: SequenceResult = .accepted;
        if (stream.cursor) |*cursor| {
            result = try cursor.check(sequence, fingerprint);
        }
        const body: []u8 = switch (input) {
            .dispatch => |event| try self.allocator.dupe(u8, event.message.body),
            .merkle_tree_insertion => try self.allocator.alloc(u8, 0),
        };
        var pending = Pending{ .input = input, .sequence = sequence, .generation = origin.connection_generation, .owned_body = if (body.len == 0) null else body };
        if (body.len > 0) pending.input.dispatch.message.body = body;
        errdefer pending.deinit(self.allocator);
        try stream.pending.ensureUnusedCapacity(self.allocator, 1);
        if (stream.pending.items.len >= self.options.parity_queue_capacity or
            input.bodyBytes() > self.options.parity_staged_body_bytes -| self.total_body_bytes or
            (self.total_pending >= self.options.parity_pending_capacity and stream.pending.items.len > self.options.parity_cap_exempt_pending))
        {
            stream.overflowed = true;
            try self.revoke(origin.domain);
            return error.ParityOverflow;
        }
        if (result == .accepted) {
            if (stream.cursor) |*cursor| {
                try cursor.accept(sequence, fingerprint);
            } else {
                stream.cursor = StreamCursor.init(self.allocator, sequence);
                try stream.cursor.?.accept(sequence, fingerprint);
            }
        }
        stream.pending.appendAssumeCapacity(pending);
        // The queue owns the body even when caught-up validation below fails.
        // Keep the local error cleanup from freeing the transferred allocation.
        pending.owned_body = null;
        self.total_pending += 1;
        self.total_body_bytes += input.bodyBytes();
        try self.updateCaughtUp(origin, kind);
        return result;
    }

    pub fn acceptDispatch(self: *Controller, domain: u32, generation: u64, input: DispatchInput, fingerprint: [32]u8) !SequenceResult {
        const origin = try self.getOrigin(domain);
        try requireGeneration(origin, generation);
        errdefer self.revoke(domain) catch {};
        if (!origin.subscribed) return error.EventBeforeSubscription;
        return self.stage(origin, .dispatch, .{ .dispatch = input }, fingerprint);
    }

    pub fn acceptMerkle(self: *Controller, domain: u32, generation: u64, input: MerkleInput, fingerprint: [32]u8) !SequenceResult {
        const origin = try self.getOrigin(domain);
        try requireGeneration(origin, generation);
        errdefer self.revoke(domain) catch {};
        if (!origin.subscribed) return error.EventBeforeSubscription;
        return self.stage(origin, .merkle_tree_insertion, .{ .merkle_tree_insertion = input }, fingerprint);
    }

    fn removePending(self: *Controller, stream: *SequencedStream, index: usize) void {
        var pending = stream.pending.orderedRemove(index);
        self.total_pending -= 1;
        self.total_body_bytes -= pending.input.bodyBytes();
        pending.deinit(self.allocator);
    }

    pub fn processParityNext(self: *Controller, domain: u32, kind: EventKind, generation: u64, now_ms: u64) !ParityStep {
        if (kind == .gas_payment) return error.GasPaymentHasNoParityHealth;
        const origin = try self.getOrigin(domain);
        if (origin.connection_generation != generation) return .stale_generation;
        errdefer self.revoke(domain) catch {};
        const stream = origin.sequenced(kind);
        if (stream.overflowed or stream.unhealthy) return .idle;
        const floor = try origin.adapter.cursor(kind);
        const index = for (stream.pending.items, 0..) |pending, i| {
            if (try persistenceReady(stream, floor, pending.sequence)) break i;
        } else return .idle;
        const pending = &stream.pending.items[index];
        if (pending.generation != generation) return .stale_generation;
        if (now_ms < pending.next_retry_ms) return .pending;
        pending.attempts += 1;
        const comparison = origin.adapter.compare(pending.input) catch |err| {
            stream.overflowed = true;
            self.clearPending(stream);
            try self.revoke(domain);
            return err;
        };
        switch (comparison) {
            .conflict => {
                origin.adapter.storeParityUnhealthy(kind) catch |err| {
                    stream.overflowed = true;
                    self.clearPending(stream);
                    try self.revoke(domain);
                    return err;
                };
                stream.unhealthy = true;
                stream.overflowed = true;
                self.clearPending(stream);
                try self.revoke(domain);
                try self.updateCaughtUp(origin, kind);
                return .conflict;
            },
            .missing => {
                if (origin.active) {
                    origin.adapter.storeSequencedEvent(pending.input) catch |err| {
                        stream.overflowed = true;
                        self.clearPending(stream);
                        try self.revoke(domain);
                        return err;
                    };
                } else if (pending.attempts >= self.options.parity_retry_attempts) {
                    stream.overflowed = true;
                    self.clearPending(stream);
                    try self.revoke(domain);
                    return .expired;
                } else {
                    pending.next_retry_ms = now_ms + self.options.parity_retry_delay_ms;
                    return .pending;
                }
            },
            .match => {
                origin.adapter.storeSequencedEvent(pending.input) catch |err| {
                    stream.overflowed = true;
                    self.clearPending(stream);
                    try self.revoke(domain);
                    return err;
                };
            },
        }
        const sequence = pending.sequence;
        origin.adapter.storeCursor(kind, sequence) catch |err| {
            stream.overflowed = true;
            self.clearPending(stream);
            try self.revoke(domain);
            return err;
        };
        self.removePending(stream, index);
        origin.fresh = false;
        try self.updateCaughtUp(origin, kind);
        return .matched;
    }

    fn parityReady(stream: *const SequencedStream) bool {
        return !stream.overflowed and !stream.unhealthy and stream.pending.items.len == 0;
    }

    pub fn baseAuthorityReady(self: *Controller, domain: u32) !bool {
        const origin = try self.getOrigin(domain);
        return self.options.authority_enabled and origin.subscribed and
            origin.dispatch.caught_up and origin.merkle.caught_up and
            parityReady(&origin.dispatch) and parityReady(&origin.merkle);
    }

    pub fn acceptGasPayment(self: *Controller, domain: u32, generation: u64, input: GasPaymentInput) !GasEventResult {
        const origin = try self.getOrigin(domain);
        try requireGeneration(origin, generation);
        errdefer self.revoke(domain) catch {};
        if (!origin.subscribed) return error.EventBeforeSubscription;
        if (!origin.gas_enabled) return error.GasCursorUnsupported;
        if (origin.gas.degraded) return .dropped;
        const cursor = input.cursor;
        if (origin.gas.cursor) |previous| {
            if (cursor.legacy_max_stream_cursor != previous.legacy_max_stream_cursor) return error.GasLegacyBoundaryChanged;
            if (cursor.stream_cursor < previous.stream_cursor) return error.GasCursorMovedBackwards;
            if (cursor.stream_cursor == previous.stream_cursor) {
                if (previous.fingerprint != null and (cursor.fingerprint == null or !std.mem.eql(u8, &previous.fingerprint.?, &cursor.fingerprint.?))) return error.ConflictingGasCursor;
                return .duplicate;
            }
            const expected = try std.math.add(u64, previous.stream_cursor, 1);
            if (cursor.stream_cursor > cursor.legacy_max_stream_cursor and cursor.stream_cursor != expected) return error.StreamGap;
        } else if (cursor.stream_cursor > cursor.legacy_max_stream_cursor and cursor.stream_cursor != 1) return error.StreamGap;
        if (!self.options.authority_enabled) {
            origin.gas.cursor = cursor;
            return .shadow;
        }
        origin.adapter.storeGasPayment(input) catch |err| {
            if (err == error.GasPaymentSequenceConflict) {
                origin.gas.degraded = true;
                origin.gas.caught_up = false;
                return .conflict;
            }
            return err;
        };
        try origin.adapter.storeGasPaymentCursor(cursor);
        origin.gas.cursor = cursor;
        return .accepted;
    }

    pub fn probePlan(self: *Controller, domain: u32, now_ms: u64) !?ProbePlan {
        const origin = try self.getOrigin(domain);
        try self.retryFreshMarkers(domain);
        if (!try self.baseAuthorityReady(domain)) {
            if (origin.active) try self.revoke(domain);
            return null;
        }
        if (origin.active and origin.last_fresh_probe_ms != null and now_ms - origin.last_fresh_probe_ms.? < self.options.authoritative_probe_interval_ms) return null;
        return .{
            .domain = domain,
            .generation = origin.connection_generation,
            .dispatch_cursor = try origin.adapter.cursor(.dispatch),
            .merkle_cursor = try origin.adapter.cursor(.merkle_tree_insertion),
        };
    }

    fn cursorNext(cursor: ?u32) !u32 {
        return if (cursor) |sequence| try std.math.add(u32, sequence, 1) else 0;
    }

    pub fn applyProbe(self: *Controller, plan: ProbePlan, counts: ?CanonicalCounts, now_ms: u64) !void {
        const origin = try self.getOrigin(plan.domain);
        if (origin.connection_generation != plan.generation) return;
        errdefer self.revoke(plan.domain) catch {};
        if (counts == null) {
            origin.ahead_probe = false;
            origin.last_fresh_probe_ms = null;
            origin.fresh = false;
            const usable = origin.active and origin.health[0].observeFailure(true, now_ms) and origin.health[1].observeFailure(true, now_ms);
            if (!usable) try self.revoke(plan.domain);
            return;
        }
        const value = counts.?;
        const dispatch_next = cursorNext(plan.dispatch_cursor) catch |err| {
            try self.revoke(plan.domain);
            return err;
        };
        const merkle_next = cursorNext(plan.merkle_cursor) catch |err| {
            try self.revoke(plan.domain);
            return err;
        };
        const dispatch_count = value.dispatch orelse 0;
        const merkle_count = value.merkle_tree_insertion orelse 0;
        const current_dispatch_next = try cursorNext(try origin.adapter.cursor(.dispatch));
        const current_merkle_next = try cursorNext(try origin.adapter.cursor(.merkle_tree_insertion));
        const snapshot_current = current_dispatch_next == dispatch_next and current_merkle_next == merkle_next;
        const ahead = dispatch_next > dispatch_count or merkle_next > merkle_count;
        const tolerate_ahead = ahead and origin.active and !origin.ahead_probe;
        origin.ahead_probe = ahead;
        const dispatch_usable = origin.health[0].observe(dispatch_count, dispatch_next, origin.active, now_ms) catch tolerate_ahead;
        const merkle_usable = origin.health[1].observe(merkle_count, merkle_next, origin.active, now_ms) catch tolerate_ahead;
        origin.fresh = snapshot_current and dispatch_next == dispatch_count and merkle_next == merkle_count and try self.baseAuthorityReady(plan.domain);
        if (origin.active and origin.fresh) {
            origin.last_fresh_probe_ms = now_ms;
        } else {
            origin.last_fresh_probe_ms = null;
        }
        if (!try self.baseAuthorityReady(plan.domain) or (!origin.fresh and !(dispatch_usable and merkle_usable))) try self.revoke(plan.domain);
    }

    pub fn nextAction(self: *Controller, domain: u32, now_ms: u64) !Action {
        const origin = try self.getOrigin(domain);
        if (!origin.active and origin.fresh and try self.baseAuthorityReady(domain) and !origin.cutover_pending) return .cutover;
        if (try self.probePlan(domain, now_ms) != null) return .probe;
        return .none;
    }

    pub fn beginCutover(self: *Controller, domain: u32, generation: u64) !AuthorityCommand {
        const origin = try self.getOrigin(domain);
        try requireGeneration(origin, generation);
        errdefer self.revoke(domain) catch {};
        if (origin.active or origin.cutover_pending or !origin.fresh or !try self.baseAuthorityReady(domain)) return error.AuthorityNotReady;
        origin.desired = true;
        origin.command_generation = try std.math.add(u64, origin.command_generation, 1);
        origin.cutover_pending = true;
        origin.paused_generation = null;
        return self.command(domain);
    }

    pub fn markPaused(self: *Controller, domain: u32, command_generation: u64) !void {
        const origin = try self.getOrigin(domain);
        if (!origin.desired or origin.command_generation != command_generation) return error.StaleAuthorityGeneration;
        origin.paused_generation = command_generation;
    }

    pub fn markRunning(self: *Controller, domain: u32) !void {
        (try self.getOrigin(domain)).paused_generation = null;
    }

    pub fn completeCutover(self: *Controller, domain: u32, generation: u64, command_generation: u64) !void {
        const origin = try self.getOrigin(domain);
        try requireGeneration(origin, generation);
        errdefer self.revoke(domain) catch {};
        if (!origin.desired or origin.command_generation != command_generation or origin.paused_generation != command_generation or
            !origin.fresh or !try self.baseAuthorityReady(domain))
        {
            try self.revoke(domain);
            return error.AuthorityHandoffFailed;
        }
        origin.active = true;
        origin.cutover_pending = false;
        origin.health[0].reset();
        origin.health[1].reset();
    }
};

pub const Envelope = struct {
    row_id: ?[]const u8 = null,
    stream_cursor: ?[]const u8 = null,
    legacy_max_stream_cursor: ?[]const u8 = null,
    sequence: ?[]const u8 = null,
};

fn object(value: std.json.Value) !std.json.ObjectMap {
    return if (value == .object) value.object else error.ExpectedEventObject;
}

fn requireOnly(value: std.json.Value, allowed: []const []const u8) !void {
    const fields = try object(value);
    var iterator = fields.iterator();
    while (iterator.next()) |entry| {
        for (allowed) |name| {
            if (std.mem.eql(u8, entry.key_ptr.*, name)) break;
        } else return error.UnexpectedEventField;
    }
}

fn required(value: std.json.Value, name: []const u8) !std.json.Value {
    return (try object(value)).get(name) orelse error.MissingEventField;
}

fn text(value: std.json.Value) ![]const u8 {
    return if (value == .string) value.string else error.ExpectedEventString;
}

fn integer(value: std.json.Value) !u64 {
    return switch (value) {
        .integer => |number| std.math.cast(u64, number) orelse error.EventIntegerOverflow,
        .number_string, .string => try std.fmt.parseInt(u64, try text(value), 10),
        else => error.ExpectedEventInteger,
    };
}

fn unsigned(comptime T: type, value: std.json.Value) !T {
    return std.math.cast(T, try integer(value)) orelse error.EventIntegerOverflow;
}

fn decimal256(value: std.json.Value) !u256 {
    return std.fmt.parseInt(u256, try text(value), 10);
}

fn hexAlloc(allocator: std.mem.Allocator, value: []const u8) ![]u8 {
    const raw = if (std.mem.startsWith(u8, value, "0x") or std.mem.startsWith(u8, value, "\\x")) value[2..] else value;
    if (raw.len % 2 != 0) return error.InvalidEventHex;
    const bytes = try allocator.alloc(u8, raw.len / 2);
    errdefer allocator.free(bytes);
    _ = try std.fmt.hexToBytes(bytes, raw);
    return bytes;
}

pub fn parseAddress(allocator: std.mem.Allocator, value: []const u8) ![32]u8 {
    const bytes = try hexAlloc(allocator, value);
    defer allocator.free(bytes);
    if (bytes.len != 20 and bytes.len != 32) return error.InvalidContractAddressWidth;
    var result = [_]u8{0} ** 32;
    @memcpy(result[32 - bytes.len ..], bytes);
    return result;
}

fn parseHash(allocator: std.mem.Allocator, value: []const u8) ![32]u8 {
    const bytes = try hexAlloc(allocator, value);
    defer allocator.free(bytes);
    if (bytes.len != 32) return error.InvalidEventHashWidth;
    return bytes[0..32].*;
}

pub fn parseTransaction(allocator: std.mem.Allocator, value: []const u8) ![64]u8 {
    const bytes = try hexAlloc(allocator, value);
    defer allocator.free(bytes);
    if (bytes.len != 32 and bytes.len != 64) return error.InvalidTransactionHashWidth;
    var result = [_]u8{0} ** 64;
    @memcpy(result[64 - bytes.len ..], bytes);
    return result;
}

pub fn formatAddressAlloc(allocator: std.mem.Allocator, address: [32]u8) ![]u8 {
    const bytes = if (std.mem.allEqual(u8, address[0..12], 0)) address[12..] else address[0..];
    const out = try allocator.alloc(u8, 2 + bytes.len * 2);
    out[0..2].* = "0x".*;
    const digits = "0123456789abcdef";
    for (bytes, 0..) |byte, index| {
        out[2 + index * 2] = digits[byte >> 4];
        out[3 + index * 2] = digits[byte & 15];
    }
    return out;
}

pub fn eventFingerprint(fields: []const []const u8) [32]u8 {
    var hasher = std.crypto.hash.sha3.Keccak256.init(.{});
    for (fields) |field| {
        var length: [8]u8 = undefined;
        std.mem.writeInt(u64, &length, field.len, .big);
        hasher.update(&length);
        hasher.update(field);
    }
    var result: [32]u8 = undefined;
    hasher.final(&result);
    return result;
}

pub const DecodedDispatch = struct {
    input: DispatchInput,
    fingerprint: [32]u8,
};

pub fn decodeDispatch(allocator: std.mem.Allocator, domain: u32, mailbox: [32]u8, sequence: u32, data: std.json.Value) !DecodedDispatch {
    try requireOnly(data, &.{ "destination_domain", "id", "msg_body", "msg_id", "nonce", "origin_block_hash", "origin_block_height", "origin_domain", "origin_mailbox", "origin_tx_hash", "recipient", "sender", "time_created" });
    if (try unsigned(u32, try required(data, "origin_domain")) != domain) return error.EventDomainMismatch;
    const origin_mailbox = try parseAddress(allocator, try text(try required(data, "origin_mailbox")));
    if (!std.mem.eql(u8, &origin_mailbox, &mailbox)) return error.ContractAddressMismatch;
    const nonce = try unsigned(u32, try required(data, "nonce"));
    if (nonce != sequence) return error.EventSequenceMismatch;
    const message_id = try parseHash(allocator, try text(try required(data, "msg_id")));
    const body_value = try required(data, "msg_body");
    const body = if (body_value == .null) try allocator.alloc(u8, 0) else try hexAlloc(allocator, try text(body_value));
    errdefer allocator.free(body);
    const message = protocol.Message{
        .version = 3,
        .nonce = nonce,
        .origin = domain,
        .sender = try parseAddress(allocator, try text(try required(data, "sender"))),
        .destination = try unsigned(u32, try required(data, "destination_domain")),
        .recipient = try parseAddress(allocator, try text(try required(data, "recipient"))),
        .body = body,
    };
    if (body_value != .null and !std.mem.eql(u8, &message.id(), &message_id)) return error.DispatchMessageIdMismatch;
    const created = try text(try required(data, "time_created"));
    if (created.len == 0) return error.MissingEventCreationTime;
    const row_id = try unsigned(u64, try required(data, "id"));
    const block_hash = try parseHash(allocator, try text(try required(data, "origin_block_hash")));
    const block_number = try unsigned(u64, try required(data, "origin_block_height"));
    const transaction = try parseTransaction(allocator, try text(try required(data, "origin_tx_hash")));
    var row_bytes = std.mem.toBytes(std.mem.nativeToBig(u64, row_id));
    var block_bytes = std.mem.toBytes(std.mem.nativeToBig(u64, block_number));
    const fingerprint = eventFingerprint(&.{
        "dispatch",
        &row_bytes,
        &message_id,
        &block_hash,
        &block_bytes,
        &origin_mailbox,
        &transaction,
        created,
    });
    return .{
        .input = .{
            .block_number = block_number,
            .message = message,
            .missing_body_id = if (body_value == .null) message_id else null,
            .transaction_id = transaction,
        },
        .fingerprint = fingerprint,
    };
}

pub const DecodedMerkle = struct {
    input: MerkleInput,
    fingerprint: [32]u8,
};

pub fn decodeMerkle(allocator: std.mem.Allocator, domain: u32, hook: [32]u8, sequence: u32, data: std.json.Value) !DecodedMerkle {
    try requireOnly(data, &.{ "block_number", "domain", "leaf_index", "merkle_tree_hook", "message_id" });
    if (try unsigned(u32, try required(data, "domain")) != domain) return error.EventDomainMismatch;
    const actual_hook = try parseAddress(allocator, try text(try required(data, "merkle_tree_hook")));
    if (!std.mem.eql(u8, &actual_hook, &hook)) return error.ContractAddressMismatch;
    if (try unsigned(u32, try required(data, "leaf_index")) != sequence) return error.EventSequenceMismatch;
    const message_id = try parseHash(allocator, try text(try required(data, "message_id")));
    const block_number = try unsigned(u64, try required(data, "block_number"));
    var block_bytes = std.mem.toBytes(std.mem.nativeToBig(u64, block_number));
    return .{
        .input = .{ .block_number = block_number, .insertion = .{ .leaf_index = sequence, .message_id = message_id } },
        .fingerprint = eventFingerprint(&.{
            "merkle_tree_insertion",
            &block_bytes,
            &actual_hook,
            &message_id,
        }),
    };
}

const GasJson = struct {
    destination: u32,
    domain: u32,
    gas_amount: []const u8,
    id: []const u8,
    interchain_gas_paymaster: []const u8,
    log_index: []const u8,
    msg_id: []const u8,
    origin: u32,
    origin_block_hash: ?[]const u8,
    origin_block_height: ?[]const u8,
    origin_tx_hash: ?[]const u8,
    payment: []const u8,
    sequence: ?[]const u8,
    time_created: []const u8,
    tx_id: ?[]const u8,
};

pub const DecodedGasPayment = struct {
    input: GasPaymentInput,
};

pub fn decodeGasPayment(allocator: std.mem.Allocator, domain: u32, paymaster: [32]u8, envelope: Envelope, data: std.json.Value) !DecodedGasPayment {
    if (envelope.sequence != null) return error.UnexpectedGasSequence;
    const row_id_text = envelope.row_id orelse return error.MissingGasRowId;
    const stream_text = envelope.stream_cursor orelse return error.MissingGasStreamCursor;
    const legacy_text = envelope.legacy_max_stream_cursor orelse return error.MissingGasLegacyBoundary;
    const row_id = try std.fmt.parseInt(u64, row_id_text, 10);
    const stream_cursor = try std.fmt.parseInt(u64, stream_text, 10);
    const legacy_max = try std.fmt.parseInt(u64, legacy_text, 10);
    try requireOnly(data, &.{ "destination", "domain", "gas_amount", "id", "interchain_gas_paymaster", "log_index", "msg_id", "origin", "origin_block_hash", "origin_block_height", "origin_tx_hash", "payment", "sequence", "time_created", "tx_id" });
    if (try unsigned(u64, try required(data, "id")) != row_id) return error.GasRowIdMismatch;
    const destination = try unsigned(u32, try required(data, "destination"));
    const data_domain = try unsigned(u32, try required(data, "domain"));
    const origin = try unsigned(u32, try required(data, "origin"));
    if (data_domain != domain or origin != domain) return error.EventDomainMismatch;
    const actual_paymaster = try parseAddress(allocator, try text(try required(data, "interchain_gas_paymaster")));
    if (!std.mem.eql(u8, &actual_paymaster, &paymaster)) return error.ContractAddressMismatch;
    const message_id = try parseHash(allocator, try text(try required(data, "msg_id")));
    const payment = try decimal256(try required(data, "payment"));
    const gas_amount = try decimal256(try required(data, "gas_amount"));
    const log_index = try decimal256(try required(data, "log_index"));
    if (log_index > std.math.maxInt(u64)) return error.EventIntegerOverflow;
    const sequence_value = try required(data, "sequence");
    const sequence = if (sequence_value == .null) null else try unsigned(u32, sequence_value);
    const block_hash_value = try required(data, "origin_block_hash");
    const block_height_value = try required(data, "origin_block_height");
    const transaction_value = try required(data, "origin_tx_hash");
    const present = block_hash_value != .null and block_height_value != .null and transaction_value != .null;
    if (!present) {
        if (block_hash_value != .null or block_height_value != .null or transaction_value != .null) return error.PartialGasTransactionMetadata;
        const native_sequence = sequence orelse return error.MissingGasNativeSequence;
        if (log_index != native_sequence) return error.GasNativeSequenceMismatch;
        return error.UnresolvedCanonicalGasMetadata;
    }
    const block_number = try unsigned(u64, block_height_value);
    _ = try parseHash(allocator, try text(block_hash_value));
    const transaction = try parseTransaction(allocator, try text(transaction_value));
    const tx_id_value = try required(data, "tx_id");
    if (tx_id_value != .null) _ = try unsigned(u64, tx_id_value);
    const created = try text(try required(data, "time_created"));
    if (created.len == 0) return error.MissingEventCreationTime;
    const json = GasJson{
        .destination = destination,
        .domain = data_domain,
        .gas_amount = try text(try required(data, "gas_amount")),
        .id = try text(try required(data, "id")),
        .interchain_gas_paymaster = try text(try required(data, "interchain_gas_paymaster")),
        .log_index = try text(try required(data, "log_index")),
        .msg_id = try text(try required(data, "msg_id")),
        .origin = origin,
        .origin_block_hash = if (block_hash_value == .null) null else try text(block_hash_value),
        .origin_block_height = if (block_height_value == .null) null else try text(block_height_value),
        .origin_tx_hash = if (transaction_value == .null) null else try text(transaction_value),
        .payment = try text(try required(data, "payment")),
        .sequence = if (sequence_value == .null) null else try text(sequence_value),
        .time_created = created,
        .tx_id = if (tx_id_value == .null) null else try text(tx_id_value),
    };
    const encoded = try std.json.Stringify.valueAlloc(allocator, json, .{});
    defer allocator.free(encoded);
    var stream_bytes = std.mem.toBytes(std.mem.nativeToBig(u64, stream_cursor));
    var row_bytes = std.mem.toBytes(std.mem.nativeToBig(u64, row_id));
    const fingerprint = eventFingerprint(&.{
        "gas_payment",
        &stream_bytes,
        &row_bytes,
        encoded,
    });
    return .{ .input = .{
        .cursor = .{ .fingerprint = fingerprint, .legacy_max_stream_cursor = legacy_max, .stream_cursor = stream_cursor },
        .payment = .{ .message_id = message_id, .destination = destination, .payment = payment, .gas_amount = gas_amount },
        .meta = .{ .transaction_id = transaction, .log_index = @intCast(log_index) },
        .sequence = sequence,
        .block_number = block_number,
    } };
}

pub const CaughtUpEnvelope = struct {
    address: []const u8,
    domain: u32,
    event_type: []const u8,
    legacy_max_stream_cursor: ?[]const u8 = null,
    row_id: ?[]const u8 = null,
    stream_cursor: ?[]const u8 = null,
    sequence: ?[]const u8 = null,
};

pub fn acceptCaughtUpJson(self: *Controller, domain: u32, generation: u64, kind: EventKind, marker: CaughtUpEnvelope) !void {
    if (kind == .gas_payment) return error.UseGasCaughtUp;
    if (marker.domain != domain or !std.mem.eql(u8, marker.event_type, kind.label())) return error.EventDomainMismatch;
    if (marker.row_id != null or marker.stream_cursor != null or marker.legacy_max_stream_cursor != null) return error.UnexpectedSequencedCursor;
    const origin = try self.getOrigin(domain);
    errdefer self.revoke(domain) catch {};
    const address = try parseAddress(self.allocator, marker.address);
    const sequence_text = marker.sequence orelse return error.MissingEventSequence;
    const sequence = try std.fmt.parseInt(i64, sequence_text, 10);
    _ = origin;
    return self.acceptCaughtUp(domain, generation, kind, address, sequence);
}

fn gasUnusable(self: *Controller, domain: u32, generation: u64) !bool {
    const origin = try self.getOrigin(domain);
    try Controller.requireGeneration(origin, generation);
    if (!origin.subscribed) return error.EventBeforeSubscription;
    if (!origin.gas_enabled) return error.GasCursorUnsupported;
    return origin.gas.degraded;
}

pub fn acceptGasCaughtUpJson(self: *Controller, domain: u32, generation: u64, marker: CaughtUpEnvelope) !GasEventResult {
    if (marker.domain != domain or !std.mem.eql(u8, marker.event_type, EventKind.gas_payment.label())) return error.EventDomainMismatch;
    errdefer self.revoke(domain) catch {};
    if (try gasUnusable(self, domain, generation)) return .dropped;
    if (marker.row_id != null or marker.sequence != null) return error.UnexpectedGasCaughtUpCursor;
    const address = try parseAddress(self.allocator, marker.address);
    const legacy_text = marker.legacy_max_stream_cursor orelse return error.MissingGasLegacyBoundary;
    const stream_text = marker.stream_cursor orelse return error.MissingGasStreamCursor;
    return self.acceptGasCaughtUp(domain, generation, address, try std.fmt.parseInt(u64, legacy_text, 10), try std.fmt.parseInt(u64, stream_text, 10));
}

pub fn acceptDispatchJson(self: *Controller, domain: u32, generation: u64, envelope: Envelope, data: std.json.Value) !SequenceResult {
    if (envelope.row_id != null or envelope.stream_cursor != null or envelope.legacy_max_stream_cursor != null) return error.UnexpectedSequencedCursor;
    const sequence = try std.fmt.parseInt(u32, envelope.sequence orelse return error.MissingEventSequence, 10);
    const origin = try self.getOrigin(domain);
    errdefer self.revoke(domain) catch {};
    const decoded = try decodeDispatch(self.allocator, domain, origin.adapter.contracts.mailbox, sequence, data);
    defer self.allocator.free(decoded.input.message.body);
    return self.acceptDispatch(domain, generation, decoded.input, decoded.fingerprint);
}

pub fn acceptMerkleJson(self: *Controller, domain: u32, generation: u64, envelope: Envelope, data: std.json.Value) !SequenceResult {
    if (envelope.row_id != null or envelope.stream_cursor != null or envelope.legacy_max_stream_cursor != null) return error.UnexpectedSequencedCursor;
    const sequence = try std.fmt.parseInt(u32, envelope.sequence orelse return error.MissingEventSequence, 10);
    const origin = try self.getOrigin(domain);
    errdefer self.revoke(domain) catch {};
    const decoded = try decodeMerkle(self.allocator, domain, origin.adapter.contracts.merkle_tree_hook, sequence, data);
    return self.acceptMerkle(domain, generation, decoded.input, decoded.fingerprint);
}

pub fn acceptGasPaymentJson(self: *Controller, domain: u32, generation: u64, envelope: Envelope, data: std.json.Value) !GasEventResult {
    const origin = try self.getOrigin(domain);
    errdefer self.revoke(domain) catch {};
    if (try gasUnusable(self, domain, generation)) return .dropped;
    const decoded = try decodeGasPayment(self.allocator, domain, origin.adapter.contracts.interchain_gas_paymaster, envelope, data);
    return self.acceptGasPayment(domain, generation, decoded.input);
}

pub fn reconnectDelayMs(rejected: bool, base_delay_ms: u64, random: std.Random) u64 {
    const jitter = random.uintLessThan(u64, 5001);
    return base_delay_ms + (if (rejected) @as(u64, 300000) else 0) + jitter;
}

test "stream cursor rejects gaps conflicts and bounded duplicate history" {
    const allocator = std.testing.allocator;
    var cursor = StreamCursor.init(allocator, 0);
    defer cursor.deinit();
    const a = [_]u8{1} ** 32;
    const b = [_]u8{2} ** 32;
    try std.testing.expectEqual(SequenceResult.accepted, try cursor.check(0, a));
    try cursor.accept(0, a);
    try std.testing.expectEqual(SequenceResult.duplicate, try cursor.check(0, a));
    try std.testing.expectError(error.ConflictingStreamSequence, cursor.check(0, b));
    try std.testing.expectError(error.StreamGap, cursor.check(2, a));
    var health = Health{ .grace_ms = 1 };
    try std.testing.expectError(error.CanonicalCursorAhead, health.observe(0, 1, true, 0));
}

test "duplicate window eviction and sequence exhaustion are explicit" {
    const allocator = std.testing.allocator;
    var cursor = StreamCursor.init(allocator, 0);
    defer cursor.deinit();
    for (0..DUPLICATE_FINGERPRINT_WINDOW + 1) |index| {
        const sequence: u32 = @intCast(index);
        const print = [_]u8{1} ** 32;
        try std.testing.expectEqual(SequenceResult.accepted, try cursor.check(sequence, print));
        try cursor.accept(sequence, print);
    }
    try std.testing.expectError(error.StreamSequenceOutsideDuplicateWindow, cursor.check(0, [_]u8{1} ** 32));
    try std.testing.expectEqual(SequenceResult.duplicate, try cursor.check(1, [_]u8{1} ** 32));
    try std.testing.expectError(error.StreamSequenceExhausted, StreamCursor.fromAfter(allocator, std.math.maxInt(u32)));
    var maximum = StreamCursor.init(allocator, std.math.maxInt(u32));
    defer maximum.deinit();
    try std.testing.expectError(error.StreamSequenceExhausted, maximum.check(std.math.maxInt(u32), [_]u8{1} ** 32));
}

test "injected reconnect jitter is bounded and rejection backoff is explicit" {
    var prng = std.Random.DefaultPrng.init(7);
    const delay = reconnectDelayMs(true, 5000, prng.random());
    try std.testing.expect(delay >= 305000 and delay <= 310000);
}
