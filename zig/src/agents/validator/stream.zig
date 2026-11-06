//! Scraper-stream binding for the sole checkpoint owner. The socket thread owns
//! framing only; all parsing, cursor/native DB writes, roots and signing stay here.
const std = @import("std");
const controls = @import("../stream/validator.zig");
const wire = @import("../stream/protocol.zig");
const sockets = @import("../stream/socket_owner.zig");
const service = @import("../validator.zig");
const native = @import("../store.zig");
const objects = @import("../../storage/objects.zig");
const driver = @import("driver.zig");
const A = std.mem.Allocator;
const history_cursor_key = "zig_validator_ws_history_next_sequence_v1/";
const cursor_key = "merkle_tree_hook_websocket_next_sequence_";
pub const Reads = struct {
    context: *anyopaque,
    count_fn: *const fn (*anyopaque) anyerror!u32,
    checkpoint_fn: *const fn (*anyopaque, usize, objects.ReorgPeriod) anyerror!?service.Checkpoint,
    height_fn: *const fn (*anyopaque, objects.ReorgPeriod) anyerror!u64,
};
pub const Config = struct { url: []const u8, library_path: []const u8, ca_info: ?[]const u8 = null, lightweight: bool, wake: ?*std.atomic.Value(bool) = null };
pub const Progress = struct { frames: usize = 0, insertions: usize = 0, remaining: bool = false };
pub const Bridge = struct {
    allocator: A,
    state: *service.Service,
    store: *native.Store,
    reads: Reads,
    config: Config,
    controller: controls.Controller,
    history: ?controls.Controller = null,
    history_active: bool = false,
    history_persisted_next: u32 = 0,
    socket: *sockets.Owner,
    local_wake: std.atomic.Value(bool) = .init(false),
    fallback_active: bool,
    persisted_next: u32,
    last_error: ?anyerror = null,
    pub fn open(a: A, state: *service.Service, store: *native.Store, reads: Reads, config: Config) !*Bridge {
        if (config.lightweight and state.options.consensus != .majority) return error.LightweightRequiresMajority;
        const self = try a.create(Bridge);
        errdefer a.destroy(self);
        const confirmations: ?u32 = if (config.lightweight) null else switch (state.options.reorg_period) {
            .none => 0,
            .blocks => |n| n,
            .tag => null,
        };
        const floor = if (state.verified_through) |index| try std.math.add(u32, index, 1) else 0;
        self.* = .{ .allocator = a, .state = state, .store = store, .reads = reads, .config = config, .controller = undefined, .socket = undefined, .fallback_active = !config.lightweight and confirmations != null, .persisted_next = floor };
        self.controller = try controls.Controller.init(a, .{ .domain = state.options.domain, .hook = state.options.hook, .mode = if (config.lightweight) .lightweight else .normal, .endpoint_count = state.options.endpoint_count, .next_sequence = floor, .backfill_target = state.tree.count, .confirmations = confirmations }, .{ .context = self, .accept_fn = accept, .proof_fn = proof, .persist_cursor_fn = persist }, .{ .context = self, .count_fn = count, .vote_fn = vote });
        errdefer self.controller.deinit();
        // Recompute from the authenticated floor, not an old unverified cursor.
        try self.writeCursor(floor);
        try self.refreshCursor(64);
        self.socket = try sockets.Owner.init(a, config.url, .{ .transport = .{ .library_path = config.library_path, .ca_info = config.ca_info }, .retry_delay_ns = wire.streamRetryDelay(state.options.domain, false), .connections = if (state.repair_complete) 1 else 2, .initially_paused_mask = if (state.repair_complete) 0 else 2, .wake = config.wake orelse &self.local_wake });
        errdefer self.socket.deinit();
        try self.socket.start();
        return self;
    }
    pub fn deinit(self: *Bridge) void {
        self.socket.deinit(); // join framing before releasing callbacks/DB state
        self.controller.deinit();
        if (self.history) |*history| history.deinit();
        self.allocator.destroy(self);
    }
    pub fn stop(self: *Bridge) void {
        self.socket.requestStop();
    }
    /// RPC fallback may have appended leaves since the last socket callback.
    pub fn refreshCursor(self: *Bridge, limit: usize) !void {
        var scanned: usize = 0;
        while (scanned < limit and try self.store.insertionByIndex(self.controller.next_sequence) != null) : (scanned += 1) {
            self.controller.next_sequence = try std.math.add(u32, self.controller.next_sequence, 1);
            if (self.controller.next_sequence % 256 == 0) try self.persistMonotonic(self.controller.next_sequence);
        }
    }
    pub fn drive(self: *Bridge, now_ms: u64, cancel: ?*const std.atomic.Value(bool)) !Progress {
        self.local_wake.store(false, .release);
        if (self.fallback_active) try self.refreshCursor(64);
        var result: Progress = .{};
        while (result.frames < 64) {
            if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
            const event = self.socket.take() orelse break;
            defer self.socket.release(event);
            result.frames += 1;
            const controller = self.controllerFor(event.lane) orelse continue;
            switch (event.kind) {
                .connected => {
                    if (event.generation > controller.generation) try controller.beginGeneration(event.generation);
                },
                .closed, .failed => {
                    // A failed HTTP/TLS handshake has an attempt generation but
                    // no .connected event. Retire it monotonically before retry;
                    // otherwise a first transient failure strands lightweight mode.
                    if (event.generation > controller.generation) try controller.beginGeneration(event.generation);
                    if (event.generation != controller.generation or !controller.generation_open) {
                        if (event.generation == 0 and controller.generation == 0) try self.socket.reconnectFor(event.lane, 0, wire.streamRetryDelay(self.state.options.domain, false));
                        continue;
                    }
                    if (event.kind == .failed) self.last_error = event.kind.failed;
                    try self.disconnectLane(event.lane, false);
                },
                .text => |text| {
                    if (event.generation != controller.generation or !controller.generation_open) continue;
                    var document = wire.parse(self.allocator, text) catch |err| {
                        self.last_error = err;
                        try self.disconnectLane(event.lane, false);
                        continue;
                    };
                    defer document.deinit();
                    var effect = controller.handle(event.generation, document.value, now_ms *| std.time.ns_per_ms) catch |err| {
                        self.last_error = err;
                        try self.disconnectLane(event.lane, err == error.RejectedStream);
                        continue;
                    } orelse continue;
                    defer effect.deinit(self.allocator);
                    if (effect == .accepted and effect.accepted.advanced) result.insertions += 1;
                    try self.apply(event.lane, effect);
                },
            }
        }
        const snapshot = self.socket.snapshot();
        result.remaining = snapshot.retained_events > 0;
        return result;
    }
    pub fn probe(self: *Bridge, now_ms: u64) !void {
        var effect = (try self.controller.tick(self.controller.generation, now_ms *| std.time.ns_per_ms)) orelse return;
        defer effect.deinit(self.allocator);
        if (effect != .probe) return error.UnexpectedStreamEffect;
        var completion = self.controller.probe(self.controller.generation, now_ms *| std.time.ns_per_ms) catch |err| {
            self.last_error = err;
            self.controller.probeFailure(now_ms *| std.time.ns_per_ms) catch {
                try self.disconnect(false);
            };
            return;
        } orelse return;
        defer completion.deinit(self.allocator);
        try self.apply(0, completion);
    }
    pub fn forceFallback(self: *Bridge) !void {
        if (self.config.lightweight) return error.LightweightRpcFallbackForbidden;
        try self.disconnect(false);
    }
    fn controllerFor(self: *Bridge, lane: u8) ?*controls.Controller {
        return if (lane == 0) &self.controller else if (lane == 1 and self.history_active) if (self.history) |*history| history else null else null;
    }
    fn disconnect(self: *Bridge, rejected: bool) !void {
        try self.disconnectLane(0, rejected);
    }
    fn disconnectLane(self: *Bridge, lane: u8, rejected: bool) !void {
        const controller = self.controllerFor(lane) orelse return;
        const generation = controller.generation;
        const effect = controller.close(rejected).closed;
        if (lane == 0) self.fallback_active = effect.fallback;
        try self.socket.reconnectFor(lane, generation, effect.retry_delay_ns);
    }
    fn apply(self: *Bridge, lane: u8, effect: controls.Effect) !void {
        const controller = self.controllerFor(lane) orelse return;
        switch (effect) {
            .subscribe => |text| try self.socket.sendTextFor(lane, controller.generation, text),
            .activate => {
                if (lane == 0) self.fallback_active = false;
            },
            .fallback => {
                if (lane != 0 or self.config.lightweight) return error.LightweightRpcFallbackForbidden;
                self.fallback_active = true;
            },
            .closed => |closed| {
                if (lane == 0) self.fallback_active = closed.fallback;
            },
            .accepted, .cursor, .authenticated => {},
            .probe => return error.UnexpectedStreamEffect,
        }
    }
    fn updateHistory(self: *Bridge) !void {
        if (self.state.repair_complete) {
            if (self.history_active) {
                const generation = self.history.?.generation;
                _ = self.history.?.close(false);
                try self.socket.suspendFor(1, generation);
                self.history_active = false;
            }
            return;
        }
        if (self.history_active or self.state.repair_waiting_for_insertion == null) return;
        const first = self.state.repair_waiting_for_insertion.?;
        var history = try controls.Controller.init(self.allocator, .{ .domain = self.state.options.domain, .hook = self.state.options.hook, .mode = .lightweight, .endpoint_count = self.state.options.endpoint_count, .next_sequence = first, .backfill_target = try std.math.add(u32, self.state.bootstrap_index orelse return error.InvalidRepairState, 1) }, .{ .context = self, .accept_fn = accept, .proof_fn = proof, .persist_cursor_fn = historyPersist }, .{ .context = self, .count_fn = count, .vote_fn = vote });
        errdefer history.deinit();
        if (self.history) |*old| old.deinit();
        self.history = null;
        try self.writeHistoryCursor(first);
        try self.socket.reconnectFor(1, 0, 0);
        self.history = history;
        self.history_active = true;
    }
    pub fn tickCheckpoints(self: *Bridge, signer: service.Signer, publisher: service.Publisher, timestamp: u64, limit: usize) !driver.Progress {
        const result = driver.tick(self.state, .{ .context = self, .finalized_height = height, .insertion = insertion, .checkpoint = checkpoint }, signer, publisher, timestamp, .{ .publications = limit }) catch |err| {
            if (!self.state.halted) try self.updateHistory();
            return err;
        };
        try self.updateHistory();
        return result;
    }
    fn cast(context: *anyopaque) *Bridge {
        return @ptrCast(@alignCast(context));
    }
    fn accept(context: *anyopaque, _: u64, incoming: wire.MerkleInsertion, block: u64) !controls.Acceptance {
        const self = cast(context);
        const value: @import("../../db/codec.zig").MerkleInsertion = .{ .leaf_index = incoming.leaf_index, .message_id = incoming.message_id };
        if (try self.store.storeInsertionIfAbsent(value, block)) |previous| {
            if (!std.meta.eql(previous, value)) return error.ConflictingWebsocketInsertion;
            return .duplicate;
        }
        return .accepted;
    }
    fn proof(context: *anyopaque, _: u64, index: u32) !?service.Checkpoint {
        const self = cast(context);
        return self.state.checkpoint(index) catch |err| {
            if (err == error.UnknownCheckpoint) return null;
            return err;
        };
    }
    fn count(context: *anyopaque, _: u64, _: u32, _: u64) !u32 {
        const self = cast(context);
        return self.reads.count_fn(self.reads.context);
    }
    fn vote(context: *anyopaque, _: u64, slot: usize, _: u64) !?service.Checkpoint {
        const self = cast(context);
        return self.reads.checkpoint_fn(self.reads.context, slot, self.state.options.reorg_period);
    }
    fn persist(context: *anyopaque, _: u64, next: u32) !void {
        try cast(context).persistMonotonic(next);
    }
    fn historyPersist(context: *anyopaque, _: u64, next: u32) !void {
        const self = cast(context);
        if (next > self.history_persisted_next) try self.writeHistoryCursor(next);
    }
    fn writeHistoryCursor(self: *Bridge, next: u32) !void {
        var bytes: [4]u8 = undefined;
        std.mem.writeInt(u32, &bytes, next, .big);
        try self.store.typed.put(self.allocator, history_cursor_key, &.{0}, &bytes);
        self.history_persisted_next = next;
    }
    fn persistMonotonic(self: *Bridge, next: u32) !void {
        if (next > self.persisted_next) try self.writeCursor(next);
    }
    fn writeCursor(self: *Bridge, next: u32) !void {
        var bytes: [4]u8 = undefined;
        std.mem.writeInt(u32, &bytes, next, .big);
        try self.store.typed.put(self.allocator, cursor_key, &.{0}, &bytes);
        self.persisted_next = next;
    }
    fn height(context: *anyopaque, period: objects.ReorgPeriod) !u64 {
        const self = cast(context);
        return self.reads.height_fn(self.reads.context, period);
    }
    fn checkpoint(context: *anyopaque, slot: usize, period: objects.ReorgPeriod) !?service.Checkpoint {
        const self = cast(context);
        return self.reads.checkpoint_fn(self.reads.context, slot, period);
    }
    fn insertion(context: *anyopaque, index: u32, finalized: u64) !?service.Observation {
        const self = cast(context);
        const value = try self.store.insertionByIndex(index) orelse return null;
        const block = try self.store.logBlock(.insertion, index) orelse return null;
        if (block > finalized) return null;
        // The stream supplies no canonical header hash. Authenticate the entire
        // reconstructed prefix against fresh independent endpoint checkpoints.
        return .{ .message_id = value.message_id, .block_height = block, .block_hash = @splat(0) };
    }
};
