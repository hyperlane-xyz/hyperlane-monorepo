//! Port of `src/live/protocol.ts`: client message, notification and query
//! parameter validation with the exact TS error strings.
const std = @import("std");
const core = @import("core");
const json = core.json;

pub const EventType = enum {
    dispatch,
    delivery,
    gas_payment,
    merkle_tree_insertion,

    pub const all = [_]EventType{ .dispatch, .delivery, .gas_payment, .merkle_tree_insertion };

    pub fn name(self: EventType) []const u8 {
        return @tagName(self);
    }

    pub fn parse(value: []const u8) ?EventType {
        inline for (all) |eventType| {
            if (std.mem.eql(u8, value, @tagName(eventType))) return eventType;
        }
        return null;
    }
};

/// `SUBSCRIPTION_TYPES`: event types plus `blocks`.
pub const SUBSCRIPTION_TYPES = [_][]const u8{ "dispatch", "delivery", "gas_payment", "merkle_tree_insertion", "blocks" };
/// TS `LiveStartBoundary`: a healthy confirmed checkpoint and the contract
/// each event type streams from. A value type (fixed buffers): heights are
/// bigint text (at most 20 digits), hashes and addresses `0x` + 40 or 64
/// lowercase hex digits.
pub const LiveStartBoundary = struct {
    height_buf: [20]u8 = undefined,
    height_len: u8 = 0,
    hash_buf: [66]u8 = undefined,
    /// mailbox (dispatch, delivery), merkle tree hook, gas paymaster.
    address_buf: [3][66]u8 = undefined,
    address_len: [3]u8 = .{ 0, 0, 0 },

    pub fn height(self: *const LiveStartBoundary) []const u8 {
        return self.height_buf[0..self.height_len];
    }

    pub fn hash(self: *const LiveStartBoundary) []const u8 {
        return &self.hash_buf;
    }

    /// `contracts[eventType]`.
    pub fn contract(self: *const LiveStartBoundary, event_type: EventType) []const u8 {
        const index: usize = switch (event_type) {
            .dispatch, .delivery => 0,
            .merkle_tree_insertion => 1,
            .gas_payment => 2,
        };
        return self.address_buf[index][0..self.address_len[index]];
    }
};

pub const StreamKind = enum {
    dispatch,
    delivery,
    gas_payment,
    merkle_tree_insertion,
    blocks,

    pub fn eventType(self: StreamKind) ?EventType {
        return switch (self) {
            .blocks => null,
            inline else => |tag| @field(EventType, @tagName(tag)),
        };
    }
};

pub const StreamRequest = struct {
    kind: StreamKind,
    include_zero_confirmations: ?bool = null,
    confirmations: ?u64 = null,
    /// JS `Set` order: first occurrence.
    domains: ?[]const u32 = null,

    pub fn hasDomain(self: *const StreamRequest, domain: u32) bool {
        const domains = self.domains orelse return true;
        return std.mem.indexOfScalar(u32, domains, domain) != null;
    }
};

/// One `confirmationsByDomain` entry.
pub const DomainConfirmations = struct { domain: u32, confirmations: u64 };

pub const Subscribe = struct {
    streams: []const StreamRequest,
    /// `confirmationsByDomain`: null when absent (an empty map is kept and
    /// echoed). `Map` order, i.e. `Object.entries`: domains ascending.
    confirmations_by_domain: ?[]const DomainConfirmations = null,

    /// `confirmationsByDomain?.get(domain)`.
    pub fn override(self: *const Subscribe, domain: u32) ?u64 {
        for (self.confirmations_by_domain orelse return null) |entry| {
            if (entry.domain == domain) return entry.confirmations;
        }
        return null;
    }
};

pub const ClientMessage = union(enum) {
    ping,
    subscribe: Subscribe,
};

pub const EventNotification = struct {
    domain: u32,
    event_type: EventType,
    id: i128,
};

pub const HeadNotification = struct {
    confirmed_height: i128,
    domain: u32,
    previous_confirmed_height: ?i128 = null,
    head_height: ?i128 = null,
    indexed_height: ?i128 = null,
    /// `0x` + lowercase hex.
    indexed_hash: ?[]const u8 = null,
    previous_indexed_height: ?i128 = null,
};

pub const ExplorerConfirmations = struct {
    confirmations: u64,
    domains: []const u32,
};

/// Validation failure; the message is the TS `Error#message`.
pub const Failure = error{Invalid};
pub const Error = Failure || std.mem.Allocator.Error;

pub const Diag = struct {
    message: []const u8 = "",

    pub fn fail(self: *Diag, message: []const u8) Failure {
        self.message = message;
        return error.Invalid;
    }
};

// ---------------------------------------------------------------------------
// Client messages

/// `parseClientMessage`. Allocations go to `arena`; the input must already be
/// decoded like `Buffer#toString('utf8')` (see `utf8Lossy`).
pub fn parseClientMessage(arena: std.mem.Allocator, raw: []const u8, diag: *Diag) Error!ClientMessage {
    const object = json.parse(arena, raw, .{}) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.SyntaxError => return diag.fail("Invalid JSON message"),
    };
    if (object != .object) return diag.fail("Invalid client message");
    if (isString(object.get("type"), "ping")) return .ping;
    const streams_value = object.get("streams");
    if (!isString(object.get("type"), "subscribe") or streams_value == null or streams_value.? != .array)
        return diag.fail("Unsupported client message type");
    const items = streams_value.?.array;
    if (items.len == 0 or items.len > SUBSCRIPTION_TYPES.len)
        return diag.fail(std.fmt.comptimePrint("Subscribe to between 1 and {d} streams", .{SUBSCRIPTION_TYPES.len}));
    const streams = try arena.alloc(StreamRequest, items.len);
    for (items, streams) |item, *stream| stream.* = try parseStream(arena, item, diag);
    for (streams, 0..) |stream, index| {
        for (streams[0..index]) |previous| {
            if (previous.kind == stream.kind) return diag.fail("Duplicate eventType subscription");
        }
    }
    const by_domain = try parseDomainConfirmations(arena, object.get("confirmationsByDomain"), diag);
    if (by_domain) |entries| if (entries.len > 0) {
        for (streams) |stream| {
            if (stream.kind != .blocks and stream.domains == null)
                return diag.fail("confirmationsByDomain requires explicit event stream domains");
        }
        for (entries) |entry| {
            const used = for (streams) |stream| {
                if (stream.kind != .blocks and std.mem.indexOfScalar(u32, stream.domains.?, entry.domain) != null) break true;
            } else false;
            if (!used) return diag.fail(try std.fmt.allocPrint(arena, "Unused confirmationsByDomain domain {d}", .{entry.domain}));
        }
    };
    return .{ .subscribe = .{ .streams = streams, .confirmations_by_domain = by_domain } };
}

/// `parseDomainConfirmations`. Members are checked in `Object.entries`
/// order: array-index keys ascending, then the other keys as written (the
/// parser keeps one member per key, last value). Index keys are canonical
/// uint32 below 2^32-1, so they can only fail on their counts.
fn parseDomainConfirmations(arena: std.mem.Allocator, value: ?json.Value, diag: *Diag) Error!?[]const DomainConfirmations {
    const present = value orelse return null;
    if (present != .object) return diag.fail("confirmationsByDomain must be a domain-to-confirmations object");
    const members = present.object;
    var entries: std.ArrayList(DomainConfirmations) = .empty;
    // Index phase, ascending.
    var previous: ?u32 = null;
    while (true) {
        var selected: ?usize = null;
        var smallest: u32 = std.math.maxInt(u32);
        for (members, 0..) |member, i| {
            const index = arrayIndex(member.key) orelse continue;
            if ((previous == null or index > previous.?) and index < smallest) {
                smallest = index;
                selected = i;
            }
        }
        const i = selected orelse break;
        previous = smallest;
        try entries.append(arena, .{ .domain = smallest, .confirmations = try parseConfirmationCount(members[i].value, diag) });
    }
    for (members) |member| {
        if (arrayIndex(member.key) != null) continue;
        // `String(Number(key)) === key` with `isDomain`: only 4294967295 is
        // left outside the index range.
        if (!std.mem.eql(u8, member.key, "4294967295"))
            return diag.fail("confirmationsByDomain keys must be uint32 domain IDs");
        try entries.append(arena, .{ .domain = std.math.maxInt(u32), .confirmations = try parseConfirmationCount(member.value, diag) });
    }
    return entries.items;
}

/// JS array index: canonical decimal (no sign, no leading zero) below 2^32-1.
fn arrayIndex(key: []const u8) ?u32 {
    if (key.len == 0 or key.len > 10 or !isDigits(key)) return null;
    if (key.len > 1 and key[0] == '0') return null;
    const number = std.fmt.parseInt(u64, key, 10) catch return null;
    if (number >= std.math.maxInt(u32)) return null;
    return @intCast(number);
}

/// `parseConfirmationCount`.
fn parseConfirmationCount(value: json.Value, diag: *Diag) Failure!u64 {
    const number = asNumber(value) orelse return diag.fail("confirmations must be a non-negative safe integer");
    if (!isSafeInteger(number) or number < 0)
        return diag.fail("confirmations must be a non-negative safe integer");
    return @intFromFloat(number);
}

fn sameCount(a: ?u64, b: ?u64) bool {
    if (a == null or b == null) return a == null and b == null;
    return a.? == b.?;
}

/// `splitConfirmationStreams`: one request per effective count, in the order
/// each count's first domain appears; the parse guarantees explicit domains
/// whenever the map is non-empty.
pub fn splitConfirmationStreams(arena: std.mem.Allocator, request: StreamRequest, by_domain: ?[]const DomainConfirmations) std.mem.Allocator.Error![]const StreamRequest {
    const entries = by_domain orelse &.{};
    if (entries.len == 0) return arena.dupe(StreamRequest, &.{request});
    const subscribe: Subscribe = .{ .streams = &.{}, .confirmations_by_domain = entries };
    var counts: std.ArrayList(?u64) = .empty;
    var groups: std.ArrayList(std.ArrayList(u32)) = .empty;
    for (request.domains.?) |domain| {
        const confirmations = subscribe.override(domain) orelse request.confirmations;
        const index = for (counts.items, 0..) |count, i| {
            if (sameCount(count, confirmations)) break i;
        } else blk: {
            try counts.append(arena, confirmations);
            try groups.append(arena, .empty);
            break :blk counts.items.len - 1;
        };
        try groups.items[index].append(arena, domain);
    }
    const out = try arena.alloc(StreamRequest, counts.items.len);
    for (out, counts.items, groups.items) |*group, confirmations, domains| {
        group.* = request;
        group.confirmations = confirmations;
        group.domains = domains.items;
    }
    return out;
}

/// Keys of the removed replay protocol; any of them rejects the stream.
const REPLAY_KEYS = [_][]const u8{ "cursors", "streamCursorVersion", "afterId", "afterSequence", "afterStreamCursor", "allowReplay" };

fn parseStream(arena: std.mem.Allocator, value: json.Value, diag: *Diag) Error!StreamRequest {
    if (value != .object) return diag.fail("Invalid eventType");
    const object = value;
    const kind = streamKind(object.get("eventType")) orelse return diag.fail("Invalid eventType");
    for (REPLAY_KEYS) |key| if (has(object, key))
        return diag.fail("Agent streams are live-only; replay cursors are unsupported. Recover history through RPC.");
    const domains = try parseDomains(arena, object.get("domains"), diag);
    if (kind == .blocks) {
        if (has(object, "includeZeroConfirmations") or has(object, "confirmations"))
            return diag.fail("blocks supports live heads only, without confirmations");
        return .{ .kind = .blocks, .domains = domains };
    }
    var include_zero_confirmations: ?bool = null;
    if (object.get("includeZeroConfirmations")) |flag| {
        if (flag != .bool) return diag.fail("includeZeroConfirmations must be a boolean");
        include_zero_confirmations = flag.bool;
        if (flag.bool and domains == null)
            return diag.fail("includeZeroConfirmations requires explicit domains");
    }
    return .{
        .kind = kind,
        .include_zero_confirmations = include_zero_confirmations,
        .confirmations = try parseConfirmations(object.get("confirmations"), domains, diag),
        .domains = domains,
    };
}

/// `parseConfirmations`; `value == null` means `undefined`.
pub fn parseConfirmations(value: ?json.Value, domains: ?[]const u32, diag: *Diag) Failure!?u64 {
    const present = value orelse return null;
    const number = asNumber(present) orelse return diag.fail("confirmations must be a non-negative safe integer");
    return try confirmationsNumber(number, domains, diag);
}

fn confirmationsNumber(number: f64, domains: ?[]const u32, diag: *Diag) Failure!u64 {
    if (!isSafeInteger(number) or number < 0)
        return diag.fail("confirmations must be a non-negative safe integer");
    if (domains == null or domains.?.len == 0) return diag.fail("confirmations requires explicit domains");
    return @intFromFloat(number);
}

fn parseDomains(arena: std.mem.Allocator, value: ?json.Value, diag: *Diag) Error!?[]const u32 {
    const present = value orelse return null;
    if (present != .array or present.array.len == 0)
        return diag.fail("domains must contain valid domain IDs");
    var domains: std.ArrayList(u32) = .empty;
    for (present.array) |item| {
        const domain = asDomain(item) orelse return diag.fail("domains must contain valid domain IDs");
        if (std.mem.indexOfScalar(u32, domains.items, domain) == null) try domains.append(arena, domain);
    }
    return domains.items;
}

/// `parseId` for notification payloads (trusted database bigint values).
/// Values beyond i128 are rejected (unreachable from int8 columns).
pub fn parseId(value: json.Value, diag: *Diag) Failure!i128 {
    const message = "id must be a non-negative integer string";
    if (asNumber(value)) |number| {
        if (isSafeInteger(number) and number >= 0) return @intFromFloat(number);
        return diag.fail(message);
    }
    if (value != .string or !isDigits(value.string)) return diag.fail(message);
    return std.fmt.parseInt(i128, value.string, 10) catch diag.fail(message);
}

/// `parseId` for a raw text value (node-pg int8 strings).
pub fn parseIdText(text: []const u8) ?i128 {
    if (!isDigits(text)) return null;
    return std.fmt.parseInt(i128, text, 10) catch null;
}

// ---------------------------------------------------------------------------
// Database notifications

pub fn parseEventNotification(arena: std.mem.Allocator, payload: ?[]const u8, diag: *Diag) Error!EventNotification {
    const object = try parseNotification(arena, payload, "event", diag);
    const event_type = blk: {
        const value = object.get("eventType") orelse break :blk null;
        if (value != .string) break :blk null;
        break :blk EventType.parse(value.string);
    } orelse return diag.fail("Invalid scraper event notification");
    return .{
        .domain = try parseDatabaseDomain(object.get("domain"), "Invalid scraper event notification", diag),
        .event_type = event_type,
        .id = try parseId(object.get("id") orelse .null, diag),
    };
}

/// Returns the normalized `\x` message id.
pub fn parseExplorerNotification(arena: std.mem.Allocator, payload: ?[]const u8, diag: *Diag) Error![]const u8 {
    const object = try parseNotification(arena, payload, "Explorer", diag);
    const value = object.get("messageId") orelse return diag.fail("Invalid scraper Explorer notification");
    if (value != .string or !isHex(value.string, 64)) return diag.fail("Invalid scraper Explorer notification");
    return normalizeAddress(arena, value.string);
}

pub fn parseHeadNotification(arena: std.mem.Allocator, payload: ?[]const u8, diag: *Diag) Error!HeadNotification {
    const object = try parseNotification(arena, payload, "head", diag);
    const confirmed = try parseId(object.get("confirmedHeight") orelse .null, diag);
    const domain = try parseDatabaseDomain(object.get("domain"), "Invalid scraper head notification", diag);
    return .{
        .confirmed_height = confirmed,
        .domain = domain,
        .previous_confirmed_height = try optionalId(object.get("previousConfirmedHeight"), diag),
        .head_height = try optionalId(object.get("headHeight"), diag),
        .indexed_height = try optionalId(object.get("indexedHeight"), diag),
        .indexed_hash = try parseOptionalBlockHash(arena, object.get("indexedHash")),
        .previous_indexed_height = try optionalId(object.get("previousIndexedHeight"), diag),
    };
}

fn optionalId(value: ?json.Value, diag: *Diag) Failure!?i128 {
    const present = value orelse return null;
    if (present == .null) return null;
    return try parseId(present, diag);
}

fn parseNotification(arena: std.mem.Allocator, payload: ?[]const u8, comptime kind: []const u8, diag: *Diag) Error!json.Value {
    const text = payload orelse return diag.fail("Missing scraper " ++ kind ++ " notification payload");
    if (text.len == 0) return diag.fail("Missing scraper " ++ kind ++ " notification payload");
    const value = json.parse(arena, text, .{}) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.SyntaxError => return diag.fail("Invalid scraper " ++ kind ++ " notification JSON"),
    };
    if (value != .object) return diag.fail("Invalid scraper " ++ kind ++ " notification");
    return value;
}

/// `parseDatabaseDomain`: signed int4 storage or unsigned domain, as number or
/// signed decimal string.
pub fn parseDatabaseDomain(value: ?json.Value, message: []const u8, diag: *Diag) Failure!u32 {
    const present = value orelse return diag.fail(message);
    const number: f64 = switch (present) {
        .string => |text| if (isSignedDigits(text))
            std.fmt.parseFloat(f64, text) catch return diag.fail(message)
        else
            return diag.fail(message),
        else => asNumber(present) orelse return diag.fail(message),
    };
    return storedNumberDomain(number) orelse diag.fail(message);
}

/// Domain from a stored number (int4 or unsigned), or null when invalid.
pub fn storedNumberDomain(number: f64) ?u32 {
    if (!std.math.isFinite(number) or @floor(number) != number) return null;
    if (number < -0x8000_0000 or number > 0xffff_ffff) return null;
    const integer: i64 = @intFromFloat(number);
    return @intCast(if (integer < 0) integer + 0x1_0000_0000 else integer);
}

/// `storedDomain`: unsigned domain to the signed int4 column encoding.
pub fn storedDomain(domain: u32) i32 {
    return @bitCast(domain);
}

pub fn parseOptionalBlockHash(arena: std.mem.Allocator, value: ?json.Value) std.mem.Allocator.Error!?[]const u8 {
    const present = value orelse return null;
    if (present != .string) return null;
    return try blockHashText(arena, present.string);
}

pub fn blockHashText(arena: std.mem.Allocator, text: []const u8) std.mem.Allocator.Error!?[]const u8 {
    if (!isHex(text, 64)) return null;
    const out = try arena.alloc(u8, 66);
    out[0] = '0';
    out[1] = 'x';
    for (text, out[2..]) |char, *dest| dest.* = std.ascii.toLower(char);
    return out;
}

// ---------------------------------------------------------------------------
// Explorer (`/messages`) query parameters

pub fn parseExplorerConfirmations(arena: std.mem.Allocator, params: *const QueryParams, diag: *Diag) Error!?ExplorerConfirmations {
    if (!params.has("confirmations") and !params.has("domains")) return null;
    const count = params.get("confirmations");
    const domain_list = params.get("domains");
    if (count == null or count.?.len == 0 or !isDigits(count.?) or
        domain_list == null or domain_list.?.len == 0 or !isDomainList(domain_list.?))
        return diag.fail("Expected confirmations=N&domains=domain,...");
    var domains: std.ArrayList(u32) = .empty;
    var parts = std.mem.splitScalar(u8, domain_list.?, ',');
    var valid = true;
    while (parts.next()) |part| {
        const number = std.fmt.parseFloat(f64, part) catch unreachable;
        if (number > 0xffff_ffff) {
            valid = false;
            continue;
        }
        const domain: u32 = @intFromFloat(number);
        if (std.mem.indexOfScalar(u32, domains.items, domain) == null) try domains.append(arena, domain);
    }
    if (!valid) return diag.fail("Invalid domains");
    const number = std.fmt.parseFloat(f64, count.?) catch unreachable;
    const confirmations = try confirmationsNumber(number, domains.items, diag);
    return .{ .confirmations = confirmations, .domains = domains.items };
}

pub fn parseMessageId(arena: std.mem.Allocator, value: []const u8, diag: *Diag) Error![]const u8 {
    const hex = stripAddressPrefix(value);
    if (!isHex(hex, 64)) return diag.fail("Expected a 32-byte message ID");
    return normalizeAddress(arena, value);
}

/// Absent = global feed (null); empty = block/rollback updates only.
pub fn parseExplorerMessageIds(arena: std.mem.Allocator, params: *const QueryParams, diag: *Diag) Error!?[]const []const u8 {
    const value = params.get("messageIds") orelse return null;
    if (value.len == 0) return &.{};
    if (std.mem.count(u8, value, ",") + 1 > 50)
        return diag.fail("messageIds must contain at most 50 valid message IDs");
    var ids: std.ArrayList([]const u8) = .empty;
    var parts = std.mem.splitScalar(u8, value, ',');
    while (parts.next()) |part| {
        const id = try parseMessageId(arena, part, diag);
        if (!containsString(ids.items, id)) try ids.append(arena, id);
    }
    return ids.items;
}

pub fn parseExplorerDiagnostics(params: *const QueryParams, ids: ?[]const []const u8, diag: *Diag) Failure!bool {
    const flag = params.get("diagnostics") orelse return false;
    if (std.mem.eql(u8, flag, "false")) return false;
    if (!std.mem.eql(u8, flag, "true") or ids == null or ids.?.len == 0)
        return diag.fail("Expected diagnostics=true with explicit messageIds");
    return true;
}

pub fn parseExplorerBlocks(params: *const QueryParams, diag: *Diag) Failure!bool {
    const value = params.get("blocks") orelse return false;
    if (std.mem.eql(u8, value, "false")) return false;
    if (!std.mem.eql(u8, value, "true")) return diag.fail("Expected blocks=true");
    return true;
}

// ---------------------------------------------------------------------------
// Validator (`/validators`) negotiation

pub const ValidatorSubscription = struct {
    domain: u32,
    confirmations: ?u64 = null,
};

/// `parseValidatorSubscription`. The upgrade answers any failure with a bare
/// 400, so failures carry no message.
pub fn parseValidatorSubscription(params: *const QueryParams) ?ValidatorSubscription {
    for (params.entries) |entry| {
        if (!std.mem.eql(u8, entry.name, "domain") and !std.mem.eql(u8, entry.name, "confirmations")) return null;
        var count: usize = 0;
        for (params.entries) |other| {
            if (std.mem.eql(u8, other.name, entry.name)) count += 1;
        }
        if (count != 1) return null;
    }
    const raw_domain = params.get("domain") orelse return null;
    // `UNSIGNED_INTEGER_REGEX` then `isDomain(Number(raw))`.
    const domain = digitsValue(raw_domain, std.math.maxInt(u32)) orelse return null;
    const raw_count = params.get("confirmations") orelse return .{ .domain = @intCast(domain) };
    // `Number(count)` then `parseConfirmationCount`: values past 2^53-1 are
    // unsafe (rounding never lands below 2^53).
    const confirmations = digitsValue(raw_count, 9007199254740991) orelse return null;
    return .{ .domain = @intCast(domain), .confirmations = confirmations };
}

/// `/^\d+$/` text whose value is at most `max` (leading zeros allowed).
fn digitsValue(text: []const u8, max: u64) ?u64 {
    if (!isDigits(text)) return null;
    const trimmed = std.mem.trimLeft(u8, text, "0");
    if (trimmed.len > 20) return null;
    const value = if (trimmed.len == 0) 0 else std.fmt.parseInt(u64, trimmed, 10) catch return null;
    return if (value <= max) value else null;
}

pub const VALIDATOR_PING_ERROR = "Only ping is allowed; reconnect to change the subscription";

/// `parseValidatorPing` after a successful `JSON.parse`: exactly
/// `{"type":"ping"}`. Returns false for any other value.
pub fn isValidatorPing(value: json.Value) bool {
    return value == .object and value.object.len == 1 and isString(value.get("type"), "ping");
}

/// WHATWG `URLSearchParams` over the query of `new URL(request.url, base)`.
pub const QueryParams = struct {
    entries: []const Entry,

    pub const Entry = struct { name: []const u8, value: []const u8 };

    pub fn fromUrl(arena: std.mem.Allocator, url: []const u8) std.mem.Allocator.Error!QueryParams {
        const without_fragment = url[0 .. std.mem.indexOfScalar(u8, url, '#') orelse url.len];
        const start = std.mem.indexOfScalar(u8, without_fragment, '?') orelse return .{ .entries = &.{} };
        return parse(arena, without_fragment[start + 1 ..]);
    }

    pub fn parse(arena: std.mem.Allocator, query: []const u8) std.mem.Allocator.Error!QueryParams {
        var entries: std.ArrayList(Entry) = .empty;
        var pairs = std.mem.splitScalar(u8, query, '&');
        while (pairs.next()) |pair| {
            if (pair.len == 0) continue;
            const eq = std.mem.indexOfScalar(u8, pair, '=');
            const raw_name = if (eq) |index| pair[0..index] else pair;
            const raw_value = if (eq) |index| pair[index + 1 ..] else "";
            try entries.append(arena, .{
                .name = try formDecode(arena, raw_name),
                .value = try formDecode(arena, raw_value),
            });
        }
        return .{ .entries = entries.items };
    }

    pub fn get(self: *const QueryParams, name: []const u8) ?[]const u8 {
        for (self.entries) |entry| {
            if (std.mem.eql(u8, entry.name, name)) return entry.value;
        }
        return null;
    }

    pub fn has(self: *const QueryParams, name: []const u8) bool {
        return self.get(name) != null;
    }
};

/// application/x-www-form-urlencoded byte decoding, then UTF-8 decode without BOM.
fn formDecode(arena: std.mem.Allocator, input: []const u8) std.mem.Allocator.Error![]const u8 {
    var bytes = try arena.alloc(u8, input.len);
    var len: usize = 0;
    var index: usize = 0;
    while (index < input.len) : (index += 1) {
        const char = input[index];
        if (char == '+') {
            bytes[len] = ' ';
        } else if (char == '%' and index + 2 < input.len and
            std.ascii.isHex(input[index + 1]) and std.ascii.isHex(input[index + 2]))
        {
            bytes[len] = std.fmt.parseInt(u8, input[index + 1 .. index + 3], 16) catch unreachable;
            index += 2;
        } else {
            bytes[len] = char;
        }
        len += 1;
    }
    return utf8Lossy(arena, bytes[0..len]);
}

/// `Buffer#toString('utf8')` / WHATWG UTF-8 decode: invalid sequences become
/// U+FFFD per maximal subpart. Returns `input` when already valid.
pub fn utf8Lossy(arena: std.mem.Allocator, input: []const u8) std.mem.Allocator.Error![]const u8 {
    if (std.unicode.utf8ValidateSlice(input)) return input;
    var out: std.ArrayList(u8) = .empty;
    var index: usize = 0;
    while (index < input.len) {
        const first = input[index];
        if (first < 0x80) {
            try out.append(arena, first);
            index += 1;
            continue;
        }
        const needed: usize, var lower: u8, var upper: u8 = switch (first) {
            0xC2...0xDF => .{ 1, 0x80, 0xBF },
            0xE0 => .{ 2, 0xA0, 0xBF },
            0xE1...0xEC, 0xEE...0xEF => .{ 2, 0x80, 0xBF },
            0xED => .{ 2, 0x80, 0x9F },
            0xF0 => .{ 3, 0x90, 0xBF },
            0xF1...0xF3 => .{ 3, 0x80, 0xBF },
            0xF4 => .{ 3, 0x80, 0x8F },
            else => {
                try out.appendSlice(arena, "\u{FFFD}");
                index += 1;
                continue;
            },
        };
        var seen: usize = 0;
        while (seen < needed) : (seen += 1) {
            const at = index + 1 + seen;
            if (at >= input.len or input[at] < lower or input[at] > upper) break;
            lower = 0x80;
            upper = 0xBF;
        }
        if (seen == needed) {
            try out.appendSlice(arena, input[index .. index + 1 + needed]);
        } else {
            try out.appendSlice(arena, "\u{FFFD}");
        }
        index += 1 + seen;
    }
    return out.items;
}

/// Node `net.isIP(value) !== 0`.
pub fn isIp(value: []const u8) bool {
    return isIpv4(value) or isIpv6(value);
}

pub fn isIpv4(value: []const u8) bool {
    var parts = std.mem.splitScalar(u8, value, '.');
    var count: usize = 0;
    while (parts.next()) |part| {
        count += 1;
        if (count > 4 or part.len == 0 or part.len > 3 or !isDigits(part)) return false;
        if (part.len > 1 and part[0] == '0') return false;
        if ((std.fmt.parseInt(u16, part, 10) catch return false) > 255) return false;
    }
    return count == 4;
}

pub fn isIpv6(input: []const u8) bool {
    var value = input;
    if (std.mem.indexOfScalar(u8, value, '%')) |zone| {
        const id = value[zone + 1 ..];
        if (id.len == 0) return false;
        for (id) |char| {
            if (!std.ascii.isAlphanumeric(char) and char != '-' and char != '.' and char != ':') return false;
        }
        value = value[0..zone];
    }
    const compressed = std.mem.indexOf(u8, value, "::");
    if (compressed) |at| {
        if (std.mem.indexOf(u8, value[at + 1 ..], "::") != null) return false;
        const left = value[0..at];
        const right = value[at + 2 ..];
        const left_groups = countGroups(left, right.len == 0) orelse return false;
        const right_groups = countGroups(right, true) orelse return false;
        return left_groups + right_groups <= 7;
    }
    return (countGroups(value, true) orelse return false) == 8;
}

/// Colon-separated hex groups; the final group may be an IPv4 address
/// (counted as two) when `allow_ipv4`. Empty input counts zero groups.
fn countGroups(value: []const u8, allow_ipv4: bool) ?usize {
    if (value.len == 0) return 0;
    var groups: usize = 0;
    var parts = std.mem.splitScalar(u8, value, ':');
    while (parts.next()) |part| {
        if (parts.peek() == null and allow_ipv4 and std.mem.indexOfScalar(u8, part, '.') != null) {
            if (!isIpv4(part)) return null;
            groups += 2;
            continue;
        }
        if (part.len == 0 or part.len > 4) return null;
        for (part) |char| if (!std.ascii.isHex(char)) return null;
        groups += 1;
    }
    return groups;
}

// ---------------------------------------------------------------------------
// Addresses

fn stripAddressPrefix(value: []const u8) []const u8 {
    if (std.mem.startsWith(u8, value, "0x") or std.mem.startsWith(u8, value, "\\x")) return value[2..];
    return value;
}

/// `normalizeAddress`: `\x` + lowercase, without a `0x`/`\x` prefix.
pub fn normalizeAddress(arena: std.mem.Allocator, value: []const u8) std.mem.Allocator.Error![]const u8 {
    const body = stripAddressPrefix(value);
    const out = try arena.alloc(u8, body.len + 2);
    out[0] = '\\';
    out[1] = 'x';
    for (body, out[2..]) |char, *dest| dest.* = std.ascii.toLower(char);
    return out;
}

/// `displayAddress`: `0x` + normalized body.
pub fn displayAddress(arena: std.mem.Allocator, value: []const u8) std.mem.Allocator.Error![]const u8 {
    const normalized = try normalizeAddress(arena, value);
    @constCast(normalized)[0] = '0';
    return normalized;
}

// ---------------------------------------------------------------------------
// Value helpers

fn streamKind(value: ?json.Value) ?StreamKind {
    const present = value orelse return null;
    if (present != .string) return null;
    return std.meta.stringToEnum(StreamKind, present.string);
}

fn isString(value: ?json.Value, expected: []const u8) bool {
    const present = value orelse return false;
    return present == .string and std.mem.eql(u8, present.string, expected);
}

/// JS number value of a parsed JSON number, or null for non-numbers.
pub fn asNumber(value: json.Value) ?f64 {
    return switch (value) {
        .number => |number| number,
        .raw => |text| std.fmt.parseFloat(f64, text) catch null,
        else => null,
    };
}

pub fn isSafeInteger(number: f64) bool {
    return std.math.isFinite(number) and @floor(number) == number and @abs(number) <= 9007199254740991;
}

/// `isDomain`: integer number in [0, 2^32).
fn asDomain(value: json.Value) ?u32 {
    const number = asNumber(value) orelse return null;
    if (!std.math.isFinite(number) or @floor(number) != number or number < 0 or number > 0xffff_ffff) return null;
    return @intFromFloat(number);
}

pub fn isDigits(text: []const u8) bool {
    if (text.len == 0) return false;
    for (text) |char| if (!std.ascii.isDigit(char)) return false;
    return true;
}

fn isSignedDigits(text: []const u8) bool {
    return isDigits(if (text.len > 0 and text[0] == '-') text[1..] else text);
}

fn isDomainList(text: []const u8) bool {
    var parts = std.mem.splitScalar(u8, text, ',');
    while (parts.next()) |part| if (!isDigits(part)) return false;
    return true;
}

fn isHex(text: []const u8, len: usize) bool {
    if (text.len != len) return false;
    for (text) |char| if (!std.ascii.isHex(char)) return false;
    return true;
}

pub fn containsString(items: []const []const u8, needle: []const u8) bool {
    for (items) |item| if (std.mem.eql(u8, item, needle)) return true;
    return false;
}

fn has(object: json.Value, key: []const u8) bool {
    return object.get(key) != null;
}
