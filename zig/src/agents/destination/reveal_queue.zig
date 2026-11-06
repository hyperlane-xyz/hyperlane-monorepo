//! Durable UR workflow rows and fair per-origin/per-destination scheduling.
//! Native transaction bytes stay in the separate pinned Kind.reveal Actor.
const std = @import("std");
const reveal = @import("reveal.zig");
const types = @import("types.zig");
const protocol = @import("../../protocol/root.zig");
const Store = @import("../store.zig").Store;
const abi = @import("../../evm/codecs.zig");
const A = std.mem.Allocator;
const Hash = [32]u8;
const rows = "zig_ur_reveal_v1/";
const pending = "zig_ur_reveal_pending_v1/";
const cursor = "zig_ur_reveal_cursor_v1/";
pub const Mode = enum { reveal, duplicate_close };
pub const Phase = enum { pda_wait, tokens, prepare, transaction, done, exhausted };
pub const Record = struct {
    version: u8 = 1,
    context_hex: []const u8,
    boot_hex: []const u8,
    message_hex: []const u8,
    operation_hex: []const u8,
    cycle: u64 = 0,
    mode: Mode,
    phase: Phase,
    signature_hex: ?[]const u8 = null,
    followup_hex: ?[]const u8 = null,
    request_close: bool = false,
    wait_count: u32 = 0,
    token_count: u32 = 0,
    failures: u32 = 0,
    send_attempts: u32 = 0,
    confirm_polls: u32 = 0,
    ccs_wait_count: u32 = 0,
    minimum_slot: u64 = 0,
    next_unix_ms: u64 = 0,
    delay_ms: u64 = 0,
};
pub fn routeId(destination: u32, commit: reveal.Commit) !Hash {
    var state = std.crypto.hash.sha2.Sha256.init(.{});
    state.update("HYPERLANE_UR_REVEAL_ROUTE_V1");
    var domain: [4]u8 = undefined;
    std.mem.writeInt(u32, &domain, destination, .big);
    state.update(&domain);
    state.update(&commit.program);
    state.update(&(try commit.pending()).key);
    var result: Hash = undefined;
    state.final(&result);
    return result;
}
pub fn operationId(route: Hash, cycle: u64, message_id: Hash) Hash {
    var state = std.crypto.hash.sha2.Sha256.init(.{});
    state.update("HYPERLANE_UR_REVEAL_OPERATION_V1");
    state.update(&route);
    var generation: [8]u8 = undefined;
    std.mem.writeInt(u64, &generation, cycle, .big);
    state.update(&generation);
    state.update(&message_id);
    var result: Hash = undefined;
    state.final(&result);
    return result;
}
pub const Loaded = struct {
    allocator: A,
    store: *Store,
    route: Hash,
    destination: u32,
    bytes: []u8,
    document: std.json.Parsed(Record),
    pub fn value(self: *Loaded) *Record {
        return &self.document.value;
    }
    pub fn message(self: *Loaded) !Message {
        const data = try decode(self.allocator, self.document.value.message_hex, protocol.Message.prefix_len + 96);
        errdefer self.allocator.free(data);
        return .{ .allocator = self.allocator, .bytes = data, .value = try protocol.Message.decode(data) };
    }
    pub fn ownedText(self: *Loaded, text: []const u8) ![]const u8 {
        return self.document.arena.allocator().dupe(u8, text);
    }
    pub fn setSignature(self: *Loaded, signature: [65]u8) !void {
        self.document.value.signature_hex = try abi.hexAlloc(self.document.arena.allocator(), &signature);
    }
    pub fn schedule(self: *Loaded, unix_ms: u64, delay_ms: u64) void {
        self.document.value.next_unix_ms = unix_ms +| delay_ms;
        self.document.value.delay_ms = delay_ms;
    }
    pub fn due(self: *Loaded, unix_ms: u64) bool {
        return unix_ms >= self.document.value.next_unix_ms;
    }
    pub fn save(self: *Loaded) !void {
        const encoded = try std.json.Stringify.valueAlloc(self.allocator, self.document.value, .{});
        errdefer {
            std.crypto.secureZero(u8, encoded);
            self.allocator.free(encoded);
        }
        if (encoded.len > 65536) return error.RevealQueueRowTooLarge;
        self.store.mutex.lock();
        defer self.store.mutex.unlock();
        const current = try self.store.typed.get(self.allocator, rows, &self.route);
        defer if (current) |bytes| self.allocator.free(bytes);
        if (current == null or !std.mem.eql(u8, current.?, self.bytes)) return error.StaleRevealQueueRow;
        try write(self.allocator, self.store, self.route, self.destination, self.document.value.phase, encoded);
        std.crypto.secureZero(u8, self.bytes);
        self.allocator.free(self.bytes);
        self.bytes = encoded;
    }
    pub fn deinit(self: *Loaded) void {
        if (self.document.value.signature_hex) |signature| std.crypto.secureZero(u8, @constCast(signature));
        self.document.deinit();
        std.crypto.secureZero(u8, self.bytes);
        self.allocator.free(self.bytes);
    }
};
pub const Message = struct {
    allocator: A,
    bytes: []u8,
    value: protocol.Message,
    pub fn deinit(self: *Message) void {
        self.allocator.free(self.bytes);
    }
};
fn decode(a: A, text: []const u8, maximum: usize) ![]u8 {
    if (!std.mem.startsWith(u8, text, "0x") or text.len % 2 != 0 or text.len / 2 - 1 > maximum) return error.InvalidRevealQueueHex;
    const bytes = try a.alloc(u8, text.len / 2 - 1);
    errdefer a.free(bytes);
    _ = try abi.decodeHex(bytes, text);
    return bytes;
}
fn write(a: A, store: *Store, route: Hash, destination: u32, phase: Phase, bytes: []const u8) !void {
    var key: [36]u8 = undefined;
    std.mem.writeInt(u32, key[0..4], destination, .big);
    key[4..36].* = route;
    var batch = try store.typed.batch(a);
    defer batch.deinit();
    try batch.put(rows, &route, bytes);
    if (phase == .done) try batch.delete(pending, &key) else try batch.put(pending, &key, &.{1});
    try batch.commitSync();
}
pub fn enqueue(a: A, store: *Store, context: Hash, boot: Hash, value: protocol.Message, commit: reveal.Commit, mode: Mode) !bool {
    const actual = reveal.Commit.message(commit.program, value) orelse return error.RevealCommitmentContext;
    if (!std.meta.eql(actual, commit)) return error.RevealCommitmentContext;
    const route = try routeId(value.destination, commit);
    const raw = try value.encodeAlloc(a);
    defer a.free(raw);
    const message_hex = try abi.hexAlloc(a, raw);
    defer a.free(message_hex);
    const context_hex = try abi.hexAlloc(a, &context);
    defer a.free(context_hex);
    const boot_hex = try abi.hexAlloc(a, &boot);
    defer a.free(boot_hex);
    store.mutex.lock();
    defer store.mutex.unlock();
    const old_bytes = try store.typed.get(a, rows, &route);
    defer if (old_bytes) |bytes| {
        std.crypto.secureZero(u8, bytes);
        a.free(bytes);
    };
    var old: ?std.json.Parsed(Record) = null;
    defer if (old) |*document| document.deinit();
    var record: Record = .{ .context_hex = context_hex, .boot_hex = boot_hex, .message_hex = message_hex, .operation_hex = "", .mode = mode, .phase = if (mode == .reveal) .pda_wait else .prepare };
    if (old_bytes) |bytes| {
        if (bytes.len > 65536) return error.RevealQueueRowTooLarge;
        old = try std.json.parseFromSlice(Record, a, bytes, .{ .duplicate_field_behavior = .@"error", .allocate = .alloc_always });
        const previous = old.?.value;
        if (previous.version != 1 or !std.mem.eql(u8, previous.context_hex, context_hex)) return error.RevealContextChanged;
        if (previous.phase != .done and previous.phase != .exhausted) {
            record = previous;
            if (mode == .duplicate_close and previous.mode == .reveal) {
                if (previous.request_close) return false;
                record.request_close = true;
            } else if (mode == .reveal and previous.mode == .duplicate_close) {
                if (previous.followup_hex != null) return false;
                record.followup_hex = message_hex;
            } else return false;
        } else {
            if (std.mem.eql(u8, previous.message_hex, message_hex) and previous.mode == mode) return false;
            record.cycle = try std.math.add(u64, previous.cycle, 1);
            record.signature_hex = previous.signature_hex;
        }
    }
    const op = operationId(route, record.cycle, value.id());
    const operation_hex = try abi.hexAlloc(a, &op);
    defer a.free(operation_hex);
    if (record.operation_hex.len == 0) record.operation_hex = operation_hex;
    const encoded = try std.json.Stringify.valueAlloc(a, record, .{});
    defer {
        std.crypto.secureZero(u8, encoded);
        a.free(encoded);
    }
    try write(a, store, route, value.destination, record.phase, encoded);
    return true;
}
pub fn next(a: A, store: *Store, destination: u32) !?Loaded {
    var domain: [4]u8 = undefined;
    std.mem.writeInt(u32, &domain, destination, .big);
    store.mutex.lock();
    defer store.mutex.unlock();
    const prior = try store.typed.get(a, cursor, &domain);
    defer if (prior) |bytes| a.free(bytes);
    var seek: [36]u8 = .{0} ** 36;
    seek[0..4].* = domain;
    if (prior) |bytes| {
        if (bytes.len != 32) return error.InvalidRevealCursor;
        seek[4..36].* = bytes[0..32].*;
        var index: usize = seek.len;
        while (index > 4) {
            index -= 1;
            seek[index] +%= 1;
            if (seek[index] != 0) break;
        }
    }
    var entry = try store.typed.atOrAfter(a, pending, &seek);
    if (entry == null or entry.?.key.len != 36 or !std.mem.eql(u8, entry.?.key[0..4], &domain)) {
        if (entry) |*old| old.deinit();
        @memset(seek[4..36], 0);
        entry = try store.typed.atOrAfter(a, pending, &seek);
    }
    if (entry == null) return null;
    defer entry.?.deinit();
    if (entry.?.key.len != 36 or !std.mem.eql(u8, entry.?.key[0..4], &domain)) return null;
    if (entry.?.value.len != 1 or entry.?.value[0] != 1) return error.InvalidRevealQueueIndex;
    const route = entry.?.key[4..36].*;
    const bytes = try store.typed.get(a, rows, &route) orelse return error.OrphanedRevealQueue;
    errdefer a.free(bytes);
    if (bytes.len > 65536) return error.RevealQueueRowTooLarge;
    var document = try std.json.parseFromSlice(Record, a, bytes, .{ .duplicate_field_behavior = .@"error", .allocate = .alloc_always });
    errdefer document.deinit();
    if (document.value.version != 1 or document.value.phase == .done) return error.InvalidRevealQueueRow;
    // Cursor is a scheduling hint only. Losing this unsynced write repeats a
    // bounded scan; effect rows and native signatures use synchronous commits.
    try store.typed.put(a, cursor, &domain, &route);
    return .{ .allocator = a, .store = store, .route = route, .destination = destination, .bytes = bytes, .document = document };
}
