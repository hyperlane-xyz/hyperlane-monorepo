//! Port of `agent-subscription.ts`: canonical event filtering, ordered replay,
//! and the handoff to live delivery. Methods require the loop mutex.
const std = @import("std");
const core = @import("core");
const protocol = @import("protocol.zig");
const runtime = @import("runtime.zig");
const es = @import("event_store.zig");
const frames = @import("frames.zig");

const json = core.json;
const Value = json.Value;
const Allocator = std.mem.Allocator;
const fail = runtime.fail;

pub const MAX_PENDING_EVENTS = 5_000;
pub const ReplayOutcome = enum { success, aborted, failure };

const CursorPosition = struct { value: ?i128 = null, legacy_max_id: ?i128 = null };

pub const Io = struct {
    ctx: *anyopaque,
    active: *const fn (ctx: *anyopaque) bool,
    /// `await send(message)`.
    send: *const fn (ctx: *anyopaque, frame: []const u8) bool,
    close: *const fn (ctx: *anyopaque, reason: []const u8) void,
    /// Called once when the subscription is freed.
    deinit: ?*const fn (ctx: *anyopaque) void = null,
};

/// `eventForDelivery` result: `undefined` (skip), `false` (gap; the socket is
/// closing) or a message to deliver.
pub const Delivery = union(enum) {
    skip,
    gap,
    deliver: struct {
        domain: u32,
        cursor: ?es.Cursor,
        legacy_max_stream_cursor: ?i128,
    },
};

pub const AgentSubscription = struct {
    allocator: Allocator,
    /// Owns the copied request.
    request_arena: std.heap.ArenaAllocator,
    request: protocol.StreamRequest,
    event_type: protocol.EventType,
    store: *es.EventStore,
    loop: *runtime.Loop,
    max_catch_up_ms: u64,
    io: Io,
    state: enum { waiting, replaying, live },
    catch_up_rows: usize = 0,
    catch_up_started_at: i64,
    pending: std.ArrayList(Value) = .empty,
    pending_arena: std.heap.ArenaAllocator,
    /// Per-row scratch for replay (reset per row; replay task only).
    scratch: std.heap.ArenaAllocator,
    positions: ?std.StringArrayHashMapUnmanaged(CursorPosition) = null,
    refs: usize = 1,

    pub fn create(
        allocator: Allocator,
        request: protocol.StreamRequest,
        store: *es.EventStore,
        loop: *runtime.Loop,
        max_catch_up_ms: u64,
        io: Io,
    ) !*AgentSubscription {
        const self = try allocator.create(AgentSubscription);
        errdefer allocator.destroy(self);
        self.* = .{
            .allocator = allocator,
            .request_arena = .init(allocator),
            .request = undefined,
            .event_type = request.kind.eventType().?,
            .store = store,
            .loop = loop,
            .max_catch_up_ms = max_catch_up_ms,
            .io = io,
            .state = if (request.cursors != null) .waiting else .live,
            .catch_up_started_at = loop.now(),
            .pending_arena = .init(allocator),
            .scratch = .init(allocator),
        };
        errdefer self.request_arena.deinit();
        const a = self.request_arena.allocator();
        self.request = try copyRequest(a, request);
        if (self.request.cursors) |cursors| {
            var positions: std.StringArrayHashMapUnmanaged(CursorPosition) = .empty;
            for (cursors) |cursor| try positions.put(a, try es.cursorKey(a, cursor.domain, cursor.address), .{});
            self.positions = positions;
        }
        return self;
    }

    pub fn retain(self: *AgentSubscription) void {
        self.refs += 1;
    }

    pub fn release(self: *AgentSubscription) void {
        self.refs -= 1;
        if (self.refs > 0) return;
        if (self.io.deinit) |deinit| deinit(self.io.ctx);
        self.pending.deinit(self.allocator);
        self.pending_arena.deinit();
        self.scratch.deinit();
        self.request_arena.deinit();
        self.allocator.destroy(self);
    }

    pub fn isActive(self: *AgentSubscription) bool {
        return self.io.active(self.io.ctx);
    }

    pub fn pendingCount(self: *const AgentSubscription) usize {
        return self.pending.items.len;
    }

    pub fn matchesDomain(self: *const AgentSubscription, domain: u32) bool {
        return self.request.hasDomain(domain);
    }

    pub fn matches(self: *const AgentSubscription, domain: u32, cursor_key: ?[]const u8) bool {
        if (self.request.confirmations != null or !self.matchesDomain(domain)) return false;
        const positions = self.positions orelse return true;
        const key = cursor_key orelse return false;
        return positions.contains(key);
    }

    /// Waiting subscriptions will read these events from the database.
    pub fn buffer(self: *AgentSubscription, row: Value) !bool {
        if (self.state == .waiting) return true;
        try self.pending.append(self.allocator, try clone(self.pending_arena.allocator(), row));
        return self.pending.items.len <= MAX_PENDING_EVENTS;
    }

    /// Runs in a catch-up task; blocks (releasing the mutex) on reads/sends.
    pub fn replay(self: *AgentSubscription) !ReplayOutcome {
        self.catch_up_started_at = self.loop.now();
        self.state = .replaying;
        for (self.request.cursors orelse &.{}) |cursor| {
            if (!self.io.active(self.io.ctx) or !(try self.catchUpCursor(cursor))) return .aborted;
        }
        while (self.pending.items.len > 0) {
            if (!self.io.active(self.io.ctx)) return .aborted;
            var arena = self.pending_arena;
            defer arena.deinit();
            self.pending_arena = .init(self.allocator);
            var pending = self.pending;
            defer pending.deinit(self.allocator);
            self.pending = .empty;
            try es.sortRows(arena.allocator(), self.event_type, pending.items);
            for (pending.items) |row| {
                try self.assertCatchUpBudget();
                if (!(try self.deliverAndWait(row))) return .failure;
            }
        }
        self.state = .live;
        return .success;
    }

    fn catchUpCursor(self: *AgentSubscription, cursor: protocol.StreamCursor) !bool {
        var scratch = std.heap.ArenaAllocator.init(self.allocator);
        defer scratch.deinit();
        const a = scratch.allocator();
        const event_name = self.event_type.name();
        const key = try es.cursorKey(a, cursor.domain, cursor.address);
        if (self.positions.?.getPtr(key) == null) return fail("Missing subscription cursor", .{});
        const gas_payment = cursor.kind == .gas_payment;
        const label = if (gas_payment) "stream cursor" else "sequence";
        var after: i128 = undefined;
        var last: i128 = undefined;
        var legacy_max_id: i128 = 0;
        if (gas_payment) {
            const bounds = try self.store.gasPaymentCursorBounds(cursor);
            last = bounds.last_cursor;
            legacy_max_id = bounds.legacy_max_id;
            after = if (cursor.after) |value| value.value else last;
            if (after > last) return fail("Cursor {s} is ahead of current {s} cursor {d}", .{ cursor.after.?.text, event_name, last });
            self.positions.?.getPtr(key).?.legacy_max_id = legacy_max_id;
        } else {
            const bounds = try self.store.sequenceBounds(self.event_type, cursor);
            last = bounds.last;
            if (last < bounds.first) {
                if (cursor.after) |value| if (value.value != -1)
                    return fail("No {s} history for domain {d} address {s}", .{ event_name, cursor.domain, try protocol.displayAddress(a, cursor.address) });
                self.positions.?.getPtr(key).?.value = last;
                const frame = try frames.alloc(a, CaughtUp{ .cursor = cursor, .event_type = self.event_type, .sequence = last, .early = true }, CaughtUp.write);
                return self.io.send(self.io.ctx, frame);
            }
            after = if (cursor.after) |value| value.value else last;
            if (after > last and cursor.allow_replay != true)
                return fail("Sequence {s} is ahead of current {s} sequence {d}", .{ cursor.after.?.text, event_name, last });
            if (after > last) after = last;
        }
        self.positions.?.getPtr(key).?.value = after;
        var current = after;
        while (current < last) {
            if (!self.io.active(self.io.ctx)) return false;
            try self.assertCatchUpBudget();
            const legacy_phase = gas_payment and current < legacy_max_id;
            const through = if (legacy_phase) legacy_max_id else last;
            var page = std.heap.ArenaAllocator.init(self.allocator);
            defer page.deinit();
            const rows = if (cursor.kind == .sequence)
                try self.store.sequenceRows(page.allocator(), self.event_type, cursor, current, through)
            else
                try self.store.gasPaymentRows(page.allocator(), cursor, current, through, legacy_phase);
            self.catch_up_rows += rows.len;
            try self.assertCatchUpBudget();
            if (rows.len == 0) {
                if (!legacy_phase) return fail("Missing {s} {s} {d}", .{ event_name, label, current + 1 });
                self.positions.?.getPtr(key).?.value = through;
            }
            for (rows) |row| {
                try self.assertCatchUpBudget();
                if (!(try self.deliverAndWait(row)))
                    return fail("Gap in {s} {s} after {d}", .{ event_name, label, current });
            }
            current = self.positions.?.getPtr(key).?.value.?;
        }
        const frame = try frames.alloc(a, CaughtUp{
            .cursor = cursor,
            .event_type = self.event_type,
            .sequence = last,
            .legacy_max_id = if (gas_payment) legacy_max_id else null,
            .stream_cursor = current,
        }, CaughtUp.write);
        if (!self.io.send(self.io.ctx, frame)) return fail("Websocket closed during catch-up", .{});
        return true;
    }

    const CaughtUp = struct {
        cursor: protocol.StreamCursor,
        event_type: protocol.EventType,
        sequence: i128,
        /// Gas payment cursors (`legacyMaxStreamCursor` + `streamCursor`).
        legacy_max_id: ?i128 = null,
        stream_cursor: i128 = 0,
        /// The empty-history frame orders `sequence` before `type`.
        early: bool = false,

        fn write(self: CaughtUp, o: *frames.Object) std.Io.Writer.Error!void {
            var buf: [80]u8 = undefined;
            const body = if (std.mem.startsWith(u8, self.cursor.address, "\\x")) self.cursor.address[2..] else self.cursor.address;
            const display = std.fmt.bufPrint(&buf, "0x{s}", .{body}) catch unreachable;
            try o.string("address", display);
            try o.int("domain", self.cursor.domain);
            try o.string("eventType", self.event_type.name());
            if (self.early) {
                try o.bigString("sequence", self.sequence);
                try o.string("type", "caught_up");
                return;
            }
            try o.string("type", "caught_up");
            if (self.legacy_max_id) |legacy| {
                try o.bigString("legacyMaxStreamCursor", legacy);
                try o.bigString("streamCursor", self.stream_cursor);
            } else try o.bigString("sequence", self.sequence);
        }
    };

    fn deliverAndWait(self: *AgentSubscription, row: Value) !bool {
        _ = self.scratch.reset(.retain_capacity);
        const a = self.scratch.allocator();
        switch (try self.eventForDelivery(a, row)) {
            .gap => return false,
            .skip => return true,
            .deliver => |delivery| {
                // Positions are settled; encoding reads only this task's row, so
                // it runs outside the loop mutex (concurrent catch-ups overlap).
                self.loop.unlock();
                const encoded = eventFrame(a, self.event_type, row, delivery.domain, delivery.cursor, delivery.legacy_max_stream_cursor);
                self.loop.lock();
                const frame = try encoded;
                if (!self.io.send(self.io.ctx, frame)) return fail("Websocket closed during catch-up", .{});
                return true;
            },
        }
    }

    /// Position bookkeeping for one row; the frame is built by `eventFrame`.
    pub fn eventForDelivery(self: *AgentSubscription, arena: Allocator, row: Value) !Delivery {
        const domain = try es.rowDomain(row, es.domainColumn(self.event_type));
        const key = try es.rowCursorKey(arena, self.event_type, domain, row);
        if (!self.matches(domain, key)) return .skip;
        const cursor = try es.rowCursor(arena, self.event_type, row);
        const position = if (key) |k| if (self.positions) |*positions| positions.getPtr(k) else null else null;
        const legacy_max = if (position) |p| p.legacy_max_id else null;
        if (cursor) |c| if (position) |p| if (p.value) |current| {
            if (c.value <= current) return .skip;
            const contiguous = self.event_type != .gas_payment or (legacy_max != null and c.value > legacy_max.?);
            if (contiguous and c.value != current + 1) {
                var buf: [256]u8 = undefined;
                const label = if (self.event_type == .gas_payment) "stream cursor" else "sequence";
                const reason = std.fmt.bufPrint(&buf, "{s} {s} gap: expected {d}, received {d}", .{ self.event_type.name(), label, current + 1, c.value }) catch unreachable;
                self.io.close(self.io.ctx, reason);
                return .gap;
            }
            p.value = c.value;
        };
        return .{ .deliver = .{ .domain = domain, .cursor = cursor, .legacy_max_stream_cursor = legacy_max } };
    }

    fn assertCatchUpBudget(self: *AgentSubscription) !void {
        if (self.loop.now() - self.catch_up_started_at > @as(i64, @intCast(self.max_catch_up_ms)))
            return fail("Historical streaming time limit exceeded ({d}ms)", .{self.max_catch_up_ms});
    }
};

/// The `type: 'event'` frame from `eventForDelivery`.
pub fn eventFrame(arena: Allocator, event_type: protocol.EventType, row: Value, domain: u32, cursor: ?es.Cursor, legacy_max: ?i128) ![]const u8 {
    const data = try es.eventData(arena, event_type, row);
    const row_id: ?i128 = if (event_type == .gas_payment) try es.parseId(row.get("id")) else null;
    var out: std.Io.Writer.Allocating = .init(arena);
    var o = try frames.Object.begin(&out.writer);
    try o.val("data", data);
    try o.int("domain", domain);
    try o.string("eventType", event_type.name());
    try o.optBigString("legacyMaxStreamCursor", legacy_max);
    try o.optBigString("rowId", row_id);
    const value = if (cursor) |c| c.value else null;
    if (event_type == .gas_payment) try o.optBigString("streamCursor", value) else try o.optBigString("sequence", value);
    try o.string("type", "event");
    try o.end();
    return out.written();
}

fn copyRequest(a: Allocator, request: protocol.StreamRequest) Allocator.Error!protocol.StreamRequest {
    var copy = request;
    if (request.domains) |domains| copy.domains = try a.dupe(u32, domains);
    if (request.cursors) |cursors| {
        const out = try a.alloc(protocol.StreamCursor, cursors.len);
        for (cursors, out) |cursor, *dest| {
            dest.* = cursor;
            dest.address = try a.dupe(u8, cursor.address);
            if (cursor.after) |after| dest.after = .{ .value = after.value, .text = try a.dupe(u8, after.text) };
        }
        copy.cursors = out;
    }
    return copy;
}

/// Deep copy of a row value. Iterative (an explicit stack in the arena):
/// database JSON can nest as deep as its size allows.
pub fn clone(a: Allocator, value: Value) Allocator.Error!Value {
    const Work = struct { source: Value, dest: *Value };
    var root: Value = undefined;
    var stack: std.ArrayList(Work) = .empty;
    try stack.append(a, .{ .source = value, .dest = &root });
    while (stack.pop()) |work| {
        work.dest.* = switch (work.source) {
            .null, .bool, .number => work.source,
            .raw => |text| .{ .raw = try a.dupe(u8, text) },
            .string => |text| .{ .string = try a.dupe(u8, text) },
            .array => |items| blk: {
                const out = try a.alloc(Value, items.len);
                for (items, out) |item, *dest| try stack.append(a, .{ .source = item, .dest = dest });
                break :blk .{ .array = out };
            },
            .object => |members| blk: {
                const out = try a.alloc(json.Member, members.len);
                for (members, out) |member, *dest| {
                    dest.key = try a.dupe(u8, member.key);
                    try stack.append(a, .{ .source = member.value, .dest = &dest.value });
                }
                break :blk .{ .object = out };
            },
        };
    }
    return root;
}
