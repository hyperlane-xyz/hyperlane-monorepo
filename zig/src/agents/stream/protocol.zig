//! Shared scraper-proxy wire schema, acknowledgement and freshness policy.
//! This is the scraper event protocol, not Ethereum eth_subscribe.
const std = @import("std");
const abi = @import("../../evm/codecs.zig");
const A = std.mem.Allocator;
pub const merkle_event_type = "merkle_tree_insertion";
pub const read_timeout_ns: u64 = 75 * std.time.ns_per_s;
pub const progress_check_ns: u64 = 30 * std.time.ns_per_s;
pub const progress_grace_ns: u64 = 300 * std.time.ns_per_s;
pub const rpc_probe_timeout_ns: u64 = 15 * std.time.ns_per_s;
pub const retry_delay_ns: u64 = 5 * std.time.ns_per_s;
pub const rejected_retry_delay_ns: u64 = 300 * std.time.ns_per_s;
pub const retry_jitter_ms: u32 = 5000;

pub const SequenceCursor = struct {
    address: []const u8,
    allow_replay: ?bool = null,
    after_sequence: ?[]const u8 = null,
    domain: u32,
};
pub const GasPaymentCursor = struct { address: []const u8, after_stream_cursor: ?[]const u8 = null, domain: u32 };
pub const StreamCursor = union(enum) { sequence: SequenceCursor, gas_payment: GasPaymentCursor };
pub const SubscribeStream = struct {
    confirmations: ?u32 = null,
    cursors: ?[]const StreamCursor = null,
    domains: ?[]const u32 = null,
    event_type: []const u8,
    stream_cursor_version: ?u32 = null,
};
pub const SubscribeMessage = struct { streams: []const SubscribeStream, message_type: []const u8 = "subscribe" };
pub const SubscribedCursor = struct {
    address: []const u8,
    after_stream_cursor: ?[]const u8 = null,
    after_sequence: ?[]const u8 = null,
    domain: u32,
};
pub const SubscribedStream = struct {
    confirmations: ?u32 = null,
    cursors: ?[]const SubscribedCursor = null,
    domains: ?[]const u32 = null,
    event_type: []const u8,
    stream_cursor_version: ?u32 = null,
};

fn putOptional(map: *std.json.ObjectMap, name: []const u8, value: ?std.json.Value) !void {
    if (value) |actual| try map.put(name, actual);
}
fn domainsValue(a: A, values: ?[]const u32) !?std.json.Value {
    const source = values orelse return null;
    var array = std.json.Array.init(a);
    for (source) |domain| try array.append(.{ .integer = domain });
    return .{ .array = array };
}
fn cursorValue(a: A, cursor: StreamCursor) !std.json.Value {
    var object = std.json.ObjectMap.init(a);
    switch (cursor) {
        .sequence => |value| {
            try object.put("address", .{ .string = value.address });
            try putOptional(&object, "allowReplay", if (value.allow_replay) |allowed| .{ .bool = allowed } else null);
            try putOptional(&object, "afterSequence", if (value.after_sequence) |text| .{ .string = text } else null);
            try object.put("domain", .{ .integer = value.domain });
        },
        .gas_payment => |value| {
            try object.put("address", .{ .string = value.address });
            try putOptional(&object, "afterStreamCursor", if (value.after_stream_cursor) |text| .{ .string = text } else null);
            try object.put("domain", .{ .integer = value.domain });
        },
    }
    return .{ .object = object };
}
fn streamValue(a: A, stream: SubscribeStream) !std.json.Value {
    var object = std.json.ObjectMap.init(a);
    try putOptional(&object, "confirmations", if (stream.confirmations) |n| .{ .integer = n } else null);
    if (stream.cursors) |cursors| {
        var array = std.json.Array.init(a);
        for (cursors) |cursor| try array.append(try cursorValue(a, cursor));
        try object.put("cursors", .{ .array = array });
    }
    if (try domainsValue(a, stream.domains)) |domains| try object.put("domains", domains);
    try object.put("eventType", .{ .string = stream.event_type });
    try putOptional(&object, "streamCursorVersion", if (stream.stream_cursor_version) |n| .{ .integer = n } else null);
    return .{ .object = object };
}
pub fn serializeSubscribe(a: A, message: SubscribeMessage) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const build = arena.allocator();
    var root = std.json.ObjectMap.init(build);
    var streams = std.json.Array.init(build);
    for (message.streams) |stream| try streams.append(try streamValue(build, stream));
    try root.put("streams", .{ .array = streams });
    try root.put("type", .{ .string = message.message_type });
    return std.json.Stringify.valueAlloc(a, std.json.Value{ .object = root }, .{});
}

fn freeSubscribedCursor(a: A, cursor: SubscribedCursor) void {
    if (cursor.address.len > 0) a.free(cursor.address);
    if (cursor.after_sequence) |value| a.free(value);
    if (cursor.after_stream_cursor) |value| a.free(value);
}
fn freeConfirmationFields(a: A, streams: []SubscribedStream) void {
    for (streams) |stream| {
        a.free(stream.event_type);
        if (stream.domains) |domains| a.free(domains);
        if (stream.cursors) |cursors| {
            for (cursors) |cursor| freeSubscribedCursor(a, cursor);
            a.free(cursors);
        }
    }
}
pub fn freeConfirmation(a: A, streams: []SubscribedStream) void {
    freeConfirmationFields(a, streams);
    a.free(streams);
}
pub fn confirmation(a: A, message: SubscribeMessage) ![]SubscribedStream {
    const result = try a.alloc(SubscribedStream, message.streams.len);
    var initialized: usize = 0;
    var succeeded = false;
    defer if (!succeeded) {
        freeConfirmationFields(a, result[0..initialized]);
        a.free(result);
    };
    for (message.streams, result) |source, *out| {
        out.* = .{ .confirmations = source.confirmations, .event_type = try a.dupe(u8, source.event_type), .stream_cursor_version = source.stream_cursor_version };
        initialized += 1;
        if (source.domains) |domains| out.domains = try a.dupe(u32, domains);
        if (source.cursors) |source_cursors| {
            const owned = try a.alloc(SubscribedCursor, source_cursors.len);
            for (owned) |*cursor_out| cursor_out.* = .{ .address = &.{}, .domain = 0 };
            out.cursors = owned;
            for (source_cursors, owned) |cursor, *cursor_out| {
                const address = switch (cursor) {
                    .sequence => |value| value.address,
                    .gas_payment => |value| value.address,
                };
                cursor_out.* = .{ .address = try a.dupe(u8, address), .domain = switch (cursor) {
                    .sequence => |value| value.domain,
                    .gas_payment => |value| value.domain,
                } };
                switch (cursor) {
                    .sequence => |value| {
                        if (value.after_sequence) |text| cursor_out.after_sequence = try a.dupe(u8, text);
                    },
                    .gas_payment => |value| {
                        if (value.after_stream_cursor) |text| cursor_out.after_stream_cursor = try a.dupe(u8, text);
                    },
                }
            }
        }
    }
    succeeded = true;
    return result;
}

fn optionalStringEqual(left: ?[]const u8, right: ?[]const u8) bool {
    if (left == null or right == null) return left == null and right == null;
    return std.mem.eql(u8, left.?, right.?);
}
fn domainsEqual(left: ?[]const u32, right: ?[]const u32) bool {
    if (left == null or right == null) return left == null and right == null;
    return std.mem.eql(u32, left.?, right.?);
}
fn cursorsEqual(left: ?[]const SubscribedCursor, right: ?[]const SubscribedCursor) bool {
    if (left == null or right == null) return left == null and right == null;
    if (left.?.len != right.?.len) return false;
    for (left.?, right.?) |a, b| if (!optionalStringEqual(a.address, b.address) or !optionalStringEqual(a.after_sequence, b.after_sequence) or !optionalStringEqual(a.after_stream_cursor, b.after_stream_cursor) or a.domain != b.domain) return false;
    return true;
}
fn streamsEqual(left: SubscribedStream, right: SubscribedStream) bool {
    return left.confirmations == right.confirmations and domainsEqual(left.domains, right.domains) and std.mem.eql(u8, left.event_type, right.event_type) and left.stream_cursor_version == right.stream_cursor_version and cursorsEqual(left.cursors, right.cursors);
}
pub fn validateSubscription(expected: []const SubscribedStream, actual: []const SubscribedStream) !void {
    if (expected.len != actual.len) return error.SubscriptionConfirmationMismatch;
    for (expected, actual) |left, right| if (!streamsEqual(left, right)) return error.SubscriptionConfirmationMismatch;
}

pub const StringOrNumber = union(enum) {
    string: []const u8,
    number: u64,
    pub fn asU64(self: StringOrNumber) !u64 {
        return switch (self) {
            .number => |value| value,
            .string => |text| std.fmt.parseInt(u64, text, 10) catch error.InvalidWireInteger,
        };
    }
    pub fn asU32(self: StringOrNumber) !u32 {
        return std.math.cast(u32, try self.asU64()) orelse error.WireIntegerOverflow;
    }
};
fn stringOrNumber(value: std.json.Value) !StringOrNumber {
    return switch (value) {
        .string => |text| .{ .string = text },
        .number_string => |text| .{ .string = text },
        .integer => |number| if (number >= 0) .{ .number = @intCast(number) } else error.InvalidWireInteger,
        else => error.InvalidWireInteger,
    };
}
fn field(value: std.json.Value, name: []const u8) !std.json.Value {
    if (value != .object) return error.InvalidWireObject;
    return value.object.get(name) orelse error.MissingWireField;
}
fn stringValue(value: std.json.Value) ![]const u8 {
    if (value != .string) return error.InvalidWireString;
    return value.string;
}
fn uint(value: std.json.Value) !u32 {
    if (value != .integer or value.integer < 0) return error.InvalidWireInteger;
    return std.math.cast(u32, value.integer) orelse error.WireIntegerOverflow;
}
fn optionalText(value: std.json.Value, name: []const u8) !?[]const u8 {
    const actual = value.object.get(name) orelse return null;
    if (actual == .null) return null;
    return try stringValue(actual);
}
fn optionalUint(value: std.json.Value, name: []const u8) !?u32 {
    const actual = value.object.get(name) orelse return null;
    if (actual == .null) return null;
    return try uint(actual);
}
fn optionalDomains(value: std.json.Value, a: A, name: []const u8) !?[]const u32 {
    const actual = value.object.get(name) orelse return null;
    if (actual == .null) return null;
    if (actual != .array) return error.InvalidWireDomains;
    const result = try a.alloc(u32, actual.array.items.len);
    for (actual.array.items, result) |item, *out| out.* = try uint(item);
    return result;
}

pub const Capability = struct { event_type: []const u8, version: u32 };
pub const Ready = struct { stream_cursor_versions: []const Capability = &.{} };
pub const CaughtUp = struct {
    address: []const u8,
    domain: u32,
    event_type: []const u8,
    legacy_max_stream_cursor: ?[]const u8 = null,
    row_id: ?[]const u8 = null,
    stream_cursor: ?[]const u8 = null,
    sequence: ?[]const u8 = null,
};
pub const EventMessage = struct {
    data: std.json.Value,
    domain: u32,
    event_type: []const u8,
    legacy_max_stream_cursor: ?[]const u8 = null,
    row_id: ?[]const u8 = null,
    stream_cursor: ?[]const u8 = null,
    sequence: ?[]const u8 = null,
};
pub const ServerMessage = union(enum) {
    ready: Ready,
    subscribed: []SubscribedStream,
    caught_up: CaughtUp,
    rollback,
    event: EventMessage,
    @"error": []const u8,
    other,
};
pub const Document = struct {
    parent: A,
    arena: *std.heap.ArenaAllocator,
    parsed: std.json.Parsed(std.json.Value),
    value: ServerMessage,
    pub fn deinit(self: *Document) void {
        self.parsed.deinit();
        self.arena.deinit();
        self.parent.destroy(self.arena);
        self.* = undefined;
    }
};

fn parseSubscribedCursor(value: std.json.Value) !SubscribedCursor {
    if (value != .object) return error.InvalidWireObject;
    const names = [_][]const u8{ "address", "afterStreamCursor", "afterSequence", "domain" };
    for (value.object.keys()) |name| {
        var allowed = false;
        for (names) |candidate| {
            if (std.mem.eql(u8, name, candidate)) allowed = true;
        }
        if (!allowed) return error.UnknownSubscribedCursorField;
    }
    return .{ .address = try stringValue(try field(value, "address")), .after_stream_cursor = try optionalText(value, "afterStreamCursor"), .after_sequence = try optionalText(value, "afterSequence"), .domain = try uint(try field(value, "domain")) };
}
fn parseSubscribedStream(a: A, value: std.json.Value) !SubscribedStream {
    if (value != .object) return error.InvalidWireObject;
    const names = [_][]const u8{ "confirmations", "cursors", "domains", "eventType", "streamCursorVersion" };
    for (value.object.keys()) |name| {
        var allowed = false;
        for (names) |candidate| {
            if (std.mem.eql(u8, name, candidate)) allowed = true;
        }
        if (!allowed) return error.UnknownSubscribedStreamField;
    }
    var cursors: ?[]SubscribedCursor = null;
    if (value.object.get("cursors")) |raw| {
        if (raw != .array) return error.InvalidWireCursors;
        const owned = try a.alloc(SubscribedCursor, raw.array.items.len);
        for (raw.array.items, owned) |item, *out| out.* = try parseSubscribedCursor(item);
        cursors = owned;
    }
    return .{ .confirmations = try optionalUint(value, "confirmations"), .cursors = cursors, .domains = try optionalDomains(value, a, "domains"), .event_type = try stringValue(try field(value, "eventType")), .stream_cursor_version = try optionalUint(value, "streamCursorVersion") };
}
pub fn parse(a: A, bytes: []const u8) !Document {
    const arena = try a.create(std.heap.ArenaAllocator);
    arena.* = std.heap.ArenaAllocator.init(a);
    errdefer {
        arena.deinit();
        a.destroy(arena);
    }
    const allocator = arena.allocator();
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{ .duplicate_field_behavior = .@"error", .max_value_len = 64 * 1024 * 1024 });
    errdefer parsed.deinit();
    const root = parsed.value;
    const kind = try stringValue(try field(root, "type"));
    var value: ServerMessage = undefined;
    if (std.mem.eql(u8, kind, "ready")) {
        var capabilities: []Capability = &.{};
        if (root.object.get("streamCursorVersions")) |versions| {
            if (versions != .object) return error.InvalidWireCapabilities;
            const owned = try allocator.alloc(Capability, versions.object.count());
            for (versions.object.keys(), owned) |name, *out| out.* = .{ .event_type = name, .version = try uint(versions.object.get(name).?) };
            capabilities = owned;
        }
        value = .{ .ready = .{ .stream_cursor_versions = capabilities } };
    } else if (std.mem.eql(u8, kind, "subscribed")) {
        const raw = try field(root, "streams");
        if (raw != .array) return error.InvalidWireStreams;
        const streams = try allocator.alloc(SubscribedStream, raw.array.items.len);
        for (raw.array.items, streams) |item, *out| out.* = try parseSubscribedStream(allocator, item);
        value = .{ .subscribed = streams };
    } else if (std.mem.eql(u8, kind, "caught_up")) {
        value = .{ .caught_up = .{ .address = try stringValue(try field(root, "address")), .domain = try uint(try field(root, "domain")), .event_type = try stringValue(try field(root, "eventType")), .legacy_max_stream_cursor = try optionalText(root, "legacyMaxStreamCursor"), .row_id = try optionalText(root, "rowId"), .stream_cursor = try optionalText(root, "streamCursor"), .sequence = try optionalText(root, "sequence") } };
    } else if (std.mem.eql(u8, kind, "rollback")) {
        value = .rollback;
    } else if (std.mem.eql(u8, kind, "event")) {
        value = .{ .event = .{ .data = try field(root, "data"), .domain = try uint(try field(root, "domain")), .event_type = try stringValue(try field(root, "eventType")), .legacy_max_stream_cursor = try optionalText(root, "legacyMaxStreamCursor"), .row_id = try optionalText(root, "rowId"), .stream_cursor = try optionalText(root, "streamCursor"), .sequence = try optionalText(root, "sequence") } };
    } else if (std.mem.eql(u8, kind, "error")) {
        value = .{ .@"error" = try stringValue(try field(root, "error")) };
    } else {
        value = .other;
    }
    return .{ .parent = a, .arena = arena, .parsed = parsed, .value = value };
}

pub const SubscriptionState = enum {
    awaiting_ready,
    awaiting_subscribed,
    subscribed,
    pub fn receiveReady(self: *SubscriptionState) !void {
        if (self.* != .awaiting_ready) return error.DuplicateReady;
        self.* = .awaiting_subscribed;
    }
    pub fn receiveSubscribed(self: *SubscriptionState) !void {
        if (self.* == .awaiting_ready) return error.SubscribedBeforeReady;
        if (self.* == .subscribed) return error.DuplicateSubscribed;
        self.* = .subscribed;
    }
    pub fn requireSubscribed(self: SubscriptionState) !void {
        if (self != .subscribed) return error.MessageBeforeSubscription;
    }
};

pub const StreamHealth = struct {
    lag_started_ns: ?u64 = null,
    grace_ns: u64 = progress_grace_ns,
    pub fn observe(self: *StreamHealth, count: u32, next: u32, authoritative: bool, now_ns: u64) !bool {
        if (authoritative and next > count) return error.StreamCursorAhead;
        if (count <= next) {
            self.lag_started_ns = null;
            return true;
        }
        const started = self.lag_started_ns orelse blk: {
            self.lag_started_ns = now_ns;
            break :blk now_ns;
        };
        if (now_ns -| started >= self.grace_ns) return error.StreamStale;
        return authoritative or count == next;
    }
    pub fn observeProbeFailure(self: *StreamHealth, now_ns: u64) bool {
        const started = self.lag_started_ns orelse blk: {
            self.lag_started_ns = now_ns;
            break :blk now_ns;
        };
        return now_ns -| started < self.grace_ns;
    }
    pub fn recordProgress(self: *StreamHealth, caught_up: bool) void {
        if (!caught_up) self.reset();
    }
    pub fn reset(self: *StreamHealth) void {
        self.lag_started_ns = null;
    }
};
pub fn validateCutoverFreshness(count: u32, next: u32) !bool {
    if (next > count) return error.StreamCursorAhead;
    return next == count;
}
pub fn streamRetryDelay(domain: u32, rejected: bool) u64 {
    return retry_delay_ns + @as(u64, domain % retry_jitter_ms) * std.time.ns_per_ms + if (rejected) rejected_retry_delay_ns else 0;
}
pub fn countSampleIsStale(sampled: u32, next: u32, count: u32) bool {
    return next > sampled and next > count;
}

pub fn formatAddress(a: A, address: [32]u8) ![]u8 {
    return if (std.mem.allEqual(u8, address[0..12], 0)) abi.hexAlloc(a, address[12..]) else abi.hexAlloc(a, &address);
}
pub fn parseAddress(a: A, value: []const u8) ![32]u8 {
    const raw = if (std.mem.startsWith(u8, value, "0x") or std.mem.startsWith(u8, value, "\\x")) value[2..] else value;
    if (raw.len != 40 and raw.len != 64) return error.InvalidWireAddress;
    var result: [32]u8 = .{0} ** 32;
    const bytes = try a.alloc(u8, raw.len / 2);
    defer a.free(bytes);
    _ = try std.fmt.hexToBytes(bytes, raw);
    @memcpy(result[32 - bytes.len ..], bytes);
    return result;
}
pub const MerkleInsertion = struct { leaf_index: u32, message_id: [32]u8 };
pub fn decodeMerkleData(a: A, value: std.json.Value, domain: u32, hook: [32]u8, sequence: u32) !struct { insertion: MerkleInsertion, block_number: u64 } {
    if (value != .object) return error.InvalidWireObject;
    const names = [_][]const u8{ "block_number", "domain", "leaf_index", "merkle_tree_hook", "message_id" };
    for (value.object.keys()) |name| {
        var allowed = false;
        for (names) |candidate| {
            if (std.mem.eql(u8, name, candidate)) allowed = true;
        }
        if (!allowed) return error.UnknownMerkleEventField;
    }
    if (try uint(try field(value, "domain")) != domain) return error.MerkleDomainMismatch;
    if (!std.mem.eql(u8, &try parseAddress(a, try stringValue(try field(value, "merkle_tree_hook"))), &hook)) return error.MerkleHookMismatch;
    const leaf_index = try (try stringOrNumber(try field(value, "leaf_index"))).asU32();
    if (leaf_index != sequence) return error.MerkleSequenceMismatch;
    const id_text = try stringValue(try field(value, "message_id"));
    const raw = if (std.mem.startsWith(u8, id_text, "0x") or std.mem.startsWith(u8, id_text, "\\x")) id_text[2..] else id_text;
    if (raw.len != 64) return error.InvalidMerkleMessageId;
    var id: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&id, raw);
    return .{ .insertion = .{ .leaf_index = leaf_index, .message_id = id }, .block_number = try (try stringOrNumber(try field(value, "block_number"))).asU64() };
}
