//! Runtime denylist parser, immutable active snapshot, and atomic refresh.
//! Constructors never fetch; callers inject clock, transport, sleep, and cache path.
const std = @import("std");
const matching = @import("matching.zig");
const regex = @import("regex.zig");
const settings = @import("../settings/types.zig");
const settings_root = @import("../settings/root.zig");
const value_view = @import("../settings/value.zig").View;
pub const max_file_bytes: usize = 4 * 1024 * 1024;
pub const fetch_timeout_ms: u32 = 10_000;
pub const initial_fetch_attempts: u32 = 3;
pub const initial_fetch_backoff_ms: u64 = 2_000;
pub const Config = struct {
    url: []const u8,
    poll_interval_ms: u64,
    cache_path: []const u8,
};
pub const Summary = struct {
    version: u64,
    message_rules: usize,
    address_rules: usize,
};
pub const Fetched = struct {
    allocator: std.mem.Allocator,
    bytes: []u8,
    status: u16,
    pub fn deinit(self: *Fetched) void {
        self.allocator.free(self.bytes);
        self.* = undefined;
    }
};
pub const Transport = struct {
    context: *anyopaque,
    fetch: *const fn (context: *anyopaque, allocator: std.mem.Allocator, url: []const u8, max_bytes: usize) anyerror!Fetched,
};
pub const Clock = struct {
    context: *anyopaque,
    now_unix: *const fn (context: *anyopaque) i64,
    now_ns: ?*const fn (context: *anyopaque) i128 = null,
    fn nanos(self: Clock) i128 {
        return if (self.now_ns) |read| read(self.context) else @as(i128, self.now_unix(self.context)) * std.time.ns_per_s;
    }
};
pub const Sleeper = struct {
    context: *anyopaque,
    sleep_ms: *const fn (context: *anyopaque, milliseconds: u64) void,
};
const MessageRule = struct {
    matcher: matching.Matcher,
    reason: []const u8,
    expires_at: ?i128,
    canonical: []const u8,
};
const AddressRule = struct {
    address: [32]u8,
    reason: []const u8,
    expires_at: ?i128,
    canonical: []const u8,
};
pub const ActiveRules = struct {
    arena: std.heap.ArenaAllocator,
    messages: []MessageRule,
    addresses: []AddressRule,
    fingerprint: []const []const u8,
    pub fn deinit(self: *ActiveRules) void {
        for (self.messages) |*rule| rule.matcher.deinit();
        self.arena.deinit();
        self.* = undefined;
    }
    pub fn isEmpty(self: *const ActiveRules) bool {
        return self.messages.len == 0 and self.addresses.len == 0;
    }
    pub fn find(self: *const ActiveRules, info: matching.MatchInfo, sender: []const u8, recipient: []const u8, body: []const u8) !?[]const u8 {
        for (self.messages) |rule| {
            if (try rule.matcher.infoMatches(info, false)) return rule.reason;
        }
        for (self.addresses) |rule| {
            if (std.mem.eql(u8, &rule.address, sender)) return rule.reason;
            if (std.mem.eql(u8, &rule.address, recipient)) return rule.reason;
            if (body.len >= 32 and std.mem.eql(u8, &rule.address, body[0..32])) return rule.reason;
        }
        return null;
    }
};
pub const ParseResult = struct {
    rules: ActiveRules,
    /// Fresh parse always discards expired rules after validating them.
    discarded_expired: usize,
};
pub fn parse(allocator: std.mem.Allocator, bytes: []const u8, now_unix: i64, engine: ?*regex.Engine) !ParseResult {
    return parseAtNanos(allocator, bytes, @as(i128, now_unix) * std.time.ns_per_s, engine);
}
fn parseAtNanos(allocator: std.mem.Allocator, bytes: []const u8, now_ns: i128, engine: ?*regex.Engine) !ParseResult {
    if (bytes.len > max_file_bytes) return error.DenylistFileTooLarge;
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{ .duplicate_field_behavior = .@"error", .max_value_len = max_file_bytes });
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidDenylistJson;
    const root = parsed.value.object;
    if (root.count() != 1 or !root.contains("rules")) return error.InvalidDenylistJson;
    const raw_rules = root.get("rules") orelse return error.InvalidDenylistJson;
    if (raw_rules != .array) return error.InvalidDenylistJson;
    var result: ParseResult = .{ .rules = .{ .arena = std.heap.ArenaAllocator.init(allocator), .messages = &.{}, .addresses = &.{}, .fingerprint = &.{} }, .discarded_expired = 0 };
    errdefer result.rules.deinit();
    const a = result.rules.arena.allocator();
    var messages: std.array_list.Managed(MessageRule) = .init(a);
    errdefer {
        for (messages.items) |*rule| rule.matcher.deinit();
        messages.deinit();
    }
    var addresses: std.array_list.Managed(AddressRule) = .init(a);
    errdefer addresses.deinit();
    var fingerprints: std.array_list.Managed([]const u8) = .init(a);
    errdefer fingerprints.deinit();
    for (raw_rules.array.items, 0..) |raw, index| {
        _ = index;
        if (raw != .object) return error.InvalidDenylistRule;
        var key_it = raw.object.iterator();
        while (key_it.next()) |entry| {
            const allowed = for ([_][]const u8{ "reason", "addedBy", "expiresAt", "match", "address" }) |name| {
                if (std.mem.eql(u8, entry.key_ptr.*, name)) break true;
            } else false;
            if (!allowed) return error.UnknownDenylistField;
        }
        const canonical = try std.json.Stringify.valueAlloc(a, try sortedValue(a, raw), .{});
        const reason_value = requiredString(raw.object, "reason") orelse return error.MissingReason;
        const added_value = requiredString(raw.object, "addedBy") orelse return error.MissingAddedBy;
        if (std.mem.trim(u8, reason_value, " \t\r\n").len == 0) return error.EmptyReason;
        if (std.mem.trim(u8, added_value, " \t\r\n").len == 0) return error.EmptyAddedBy;
        const expires = if (nonnull(raw.object.get("expiresAt"))) |value| try expiryNanos(if (value == .string) value.string else return error.InvalidRfc3339) else null;
        const match_value = nonnull(raw.object.get("match"));
        const address_value = nonnull(raw.object.get("address"));
        if ((match_value == null and address_value == null) or (match_value != null and address_value != null)) return error.MatchOrAddressRequired;
        const reason = try std.fmt.allocPrint(a, "{s} (added by {s})", .{ std.mem.trim(u8, reason_value, " \t\r\n"), std.mem.trim(u8, added_value, " \t\r\n") });
        if (expires != null and expires.? <= now_ns) result.discarded_expired += 1;
        if (match_value) |source| {
            if (source != .object) return error.InvalidMatch;
            const list = try normalizeMatch(a, source.object, engine);
            var matcher = try matching.Matcher.init(allocator, list, engine);
            errdefer matcher.deinit();
            try messages.append(.{ .matcher = matcher, .reason = reason, .expires_at = expires, .canonical = canonical });
            if (expires != null and expires.? <= now_ns) {
                var removed = messages.pop().?;
                removed.matcher.deinit();
            }
        } else {
            const text = address_value.?;
            if (text != .string) return error.InvalidAddress;
            const source = std.mem.trim(u8, text.string, " \t\r\n");
            const address = try settings_root.address(a, source);
            try verifyTron(a, source, address);
            if (std.mem.allEqual(u8, &address, 0)) return error.ZeroAddress;
            try addresses.append(.{ .address = address, .reason = reason, .expires_at = expires, .canonical = canonical });
            if (expires != null and expires.? <= now_ns) _ = addresses.pop();
        }
        if (expires == null or expires.? > now_ns) try fingerprints.append(canonical);
    }
    std.mem.sort([]const u8, fingerprints.items, {}, lessString);
    result.rules.messages = try messages.toOwnedSlice();
    result.rules.addresses = try addresses.toOwnedSlice();
    result.rules.fingerprint = try fingerprints.toOwnedSlice();
    return result;
}
fn nonnull(value: ?std.json.Value) ?std.json.Value {
    return if (value != null and value.? != .null) value else null;
}
fn sortedValue(a: std.mem.Allocator, value: std.json.Value) anyerror!std.json.Value {
    switch (value) {
        .object => |object| {
            const keys = try a.dupe([]const u8, object.keys());
            std.mem.sort([]const u8, keys, {}, lessString);
            var sorted = std.json.ObjectMap.init(a);
            for (keys) |key| try sorted.put(key, try sortedValue(a, object.get(key).?));
            return .{ .object = sorted };
        },
        .array => |array| {
            var sorted = try std.json.Array.initCapacity(a, array.items.len);
            for (array.items) |item| sorted.appendAssumeCapacity(try sortedValue(a, item));
            return .{ .array = sorted };
        },
        else => return value,
    }
}
fn verifyTron(a: std.mem.Allocator, text: []const u8, parsed: [32]u8) !void {
    const bytes = @import("../altvm/base58.zig").decode(a, text) catch |err| {
        if (err == error.OutOfMemory) return err;
        return;
    };
    defer a.free(bytes);
    if (bytes.len == 25 and std.mem.eql(u8, parsed[12..], bytes[1..21])) _ = try @import("../altvm/tron.zig").decodeAddress(a, text);
}
fn verifyMatchAddress(a: std.mem.Allocator, value: std.json.Value) !void {
    if (value == .array) {
        for (value.array.items) |item| try verifyMatchAddress(a, item);
    } else if (value == .string and !std.mem.eql(u8, value.string, "*")) {
        const parsed = settings_root.address(a, value.string) catch |err| {
            if (err == error.OutOfMemory) return err;
            return; // Shared strict parser below reports malformed addresses.
        };
        try verifyTron(a, value.string, parsed);
    }
}
fn lessString(_: void, left: []const u8, right: []const u8) bool {
    return std.mem.lessThan(u8, left, right);
}
fn requiredString(object: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = object.get(key) orelse return null;
    return if (value == .string) value.string else null;
}
fn normalizeMatch(a: std.mem.Allocator, source: std.json.ObjectMap, engine: ?*regex.Engine) !settings.MatchingList {
    var normalized = std.json.ObjectMap.init(a);
    var it = source.iterator();
    while (it.next()) |entry| {
        const key = try std.ascii.allocLowerString(a, entry.key_ptr.*);
        if (std.mem.eql(u8, key, "senderaddress") or std.mem.eql(u8, key, "recipientaddress")) try verifyMatchAddress(a, entry.value_ptr.*);
        if (normalized.get(key)) |existing| {
            if (!jsonValueEql(existing, entry.value_ptr.*)) return error.ConflictingMatchAlias;
            continue;
        }
        try normalized.put(key, entry.value_ptr.*);
    }
    var one = std.json.Array.init(a);
    errdefer one.deinit();
    try one.append(.{ .object = normalized });
    const list = try settings_root.parseMatching(a, value_view{ .value = .{ .array = one } });
    if (list.len != 1) return error.InvalidMatch;
    const rule = list[0];
    if (hasEmptyFilter(rule)) return error.EmptyMatchFilter;
    if (!constrainsExactField(rule)) return error.UnconstrainedMatch;
    // Compile even when expired, matching Rust's validate-before-discard order.
    var probe = try matching.Matcher.init(a, list, engine);
    probe.deinit();
    return list;
}
fn hasEmptyFilter(rule: settings.Rule) bool {
    const filters = .{ rule.message_id, rule.origin_domain, rule.sender_address, rule.destination_domain, rule.recipient_address };
    inline for (filters) |filter| {
        if (filter == .values and filter.values.len == 0) return true;
    }
    return false;
}
fn constrainsExactField(rule: settings.Rule) bool {
    const filters = .{ rule.message_id, rule.origin_domain, rule.sender_address, rule.destination_domain, rule.recipient_address };
    inline for (filters) |filter| if (filter == .values) return true;
    return false;
}
pub fn parseRfc3339(text: []const u8) !i64 {
    if (text.len < 20) return error.InvalidRfc3339;
    if (text[4] != '-' or text[7] != '-' or (text[10] != 'T' and text[10] != 't' and text[10] != ' ') or text[13] != ':' or text[16] != ':') return error.InvalidRfc3339;
    for (text[0..19], 0..) |byte, i| if (i != 4 and i != 7 and i != 10 and i != 13 and i != 16 and !std.ascii.isDigit(byte)) return error.InvalidRfc3339;
    const year = try std.fmt.parseInt(u16, text[0..4], 10);
    const month = try std.fmt.parseInt(u8, text[5..7], 10);
    const day = try std.fmt.parseInt(u8, text[8..10], 10);
    if (month < 1 or month > 12 or day < 1 or day > daysInMonth(year, month)) return error.InvalidRfc3339;
    const hour = try std.fmt.parseInt(u8, text[11..13], 10);
    const minute = try std.fmt.parseInt(u8, text[14..16], 10);
    const second = try std.fmt.parseInt(u8, text[17..19], 10);
    if (hour > 23 or minute > 59 or second > 60) return error.InvalidRfc3339;
    var index: usize = 19;
    if (index < text.len and text[index] == '.') {
        index += 1;
        const start = index;
        while (index < text.len and std.ascii.isDigit(text[index])) index += 1;
        if (index == start) return error.InvalidRfc3339;
    }
    var offset_seconds: i64 = 0;
    if (index >= text.len) return error.InvalidRfc3339;
    if (text[index] == 'Z' or text[index] == 'z') {
        index += 1;
    } else if (text[index] == '+' or text[index] == '-') {
        index += 1;
        if (index + 5 > text.len or text[index + 2] != ':') return error.InvalidRfc3339;
        const oh = try std.fmt.parseInt(u8, text[index .. index + 2], 10);
        const om = try std.fmt.parseInt(u8, text[index + 3 .. index + 5], 10);
        for (text[index .. index + 2]) |byte| if (!std.ascii.isDigit(byte)) return error.InvalidRfc3339;
        for (text[index + 3 .. index + 5]) |byte| if (!std.ascii.isDigit(byte)) return error.InvalidRfc3339;
        if (oh > 23 or om > 59) return error.InvalidRfc3339;
        offset_seconds = @as(i64, oh) * 3600 + @as(i64, om) * 60;
        if (text[index - 1] == '-') offset_seconds = -offset_seconds;
        index += 5;
    } else return error.InvalidRfc3339;
    if (index != text.len) return error.InvalidRfc3339;
    const days = daysSinceEpoch(year, month, day);
    const local_seconds: i64 = @as(i64, days) * 86400 + @as(i64, hour) * 3600 + @as(i64, minute) * 60 + second;
    return local_seconds - offset_seconds;
}
fn expiryNanos(text: []const u8) !i128 {
    const seconds = try parseRfc3339(text);
    var fraction: u32 = 0;
    if (text[19] == '.') {
        var digits: usize = 0;
        for (text[20..]) |byte| {
            if (!std.ascii.isDigit(byte)) break;
            if (digits < 9) fraction = fraction * 10 + byte - '0';
            digits += 1;
        }
        while (digits < 9) : (digits += 1) fraction *= 10;
    }
    return @as(i128, seconds) * std.time.ns_per_s + fraction;
}
fn isLeap(year: u16) bool {
    return @mod(year, 4) == 0 and (@mod(year, 100) != 0 or @mod(year, 400) == 0);
}
fn daysInMonth(year: u16, month: u8) u8 {
    const days = [_]u8{ 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    return if (month == 2 and isLeap(year)) 29 else days[month - 1];
}
fn daysSinceEpoch(year: u16, month: u8, day: u8) i64 {
    const year_days: i64 = 365 * (@as(i64, year) - 1970) + @divFloor(@as(i64, year) - 1, 4) - @divFloor(@as(i64, year) - 1, 100) + @divFloor(@as(i64, year) - 1, 400) - 477;
    var prior: i64 = 0;
    for (1..month) |m| prior += daysInMonth(year, @intCast(m));
    return year_days + prior + day - 1;
}
pub const RefreshFailureKind = enum { fetch, status, parse, cache_write };
pub const Observer = struct {
    context: ?*anyopaque = null,
    on_rules_changed: ?*const fn (context: ?*anyopaque, summary: Summary) void = null,
    on_refresh_success: ?*const fn (context: ?*anyopaque, unix_seconds: i64) void = null,
    on_refresh_failure: ?*const fn (context: ?*anyopaque, kind: RefreshFailureKind) void = null,
    on_cache_write_failure: ?*const fn (context: ?*anyopaque) void = null,
};
pub const RuntimeDenylist = struct {
    pub const Retired = struct {
        rules: *ActiveRules,
        refs: usize,
    };
    allocator: std.mem.Allocator,
    engine: ?*regex.Engine,
    config: ?Config,
    transport: ?Transport = null,
    observer: Observer = .{},
    mutex: std.Thread.Mutex = .{},
    refresh_mutex: std.Thread.Mutex = .{},
    active: *ActiveRules,
    active_refs: usize = 0,
    retired: std.array_list.Managed(*Retired),
    version: std.atomic.Value(u64) = std.atomic.Value(u64).init(0),
    pub fn init(allocator: std.mem.Allocator, engine: ?*regex.Engine) !RuntimeDenylist {
        const rules = try allocator.create(ActiveRules);
        errdefer allocator.destroy(rules);
        rules.* = .{ .arena = std.heap.ArenaAllocator.init(allocator), .messages = &.{}, .addresses = &.{}, .fingerprint = &.{} };
        var retired: std.array_list.Managed(*Retired) = .init(allocator);
        errdefer retired.deinit();
        return .{ .allocator = allocator, .engine = engine, .config = null, .active = rules, .retired = retired };
    }
    pub fn deinit(self: *RuntimeDenylist) void {
        self.collect();
        self.mutex.lock();
        const clean = self.active_refs == 0 and self.retired.items.len == 0;
        self.mutex.unlock();
        if (!clean) @panic("runtime denylist snapshots must drain before deinit");
        self.active.deinit();
        self.allocator.destroy(self.active);
        self.retired.deinit();
        self.* = undefined;
    }
    pub const Snapshot = struct {
        denylist: *RuntimeDenylist,
        rules: *const ActiveRules,
        pub fn deinit(self: *Snapshot) void {
            self.denylist.mutex.lock();
            if (self.rules == self.denylist.active) {
                self.denylist.active_refs -= 1;
            } else {
                var found = false;
                for (self.denylist.retired.items) |node| {
                    if (node.rules == self.rules) {
                        node.refs -= 1;
                        found = true;
                        break;
                    }
                }
                if (!found) @panic("runtime denylist snapshot generation is invalid");
            }
            self.denylist.mutex.unlock();
            self.denylist.collect();
            self.* = undefined;
        }
        pub fn denyReason(self: *const Snapshot, info: matching.MatchInfo, sender: []const u8, recipient: []const u8, body: []const u8) !?[]const u8 {
            return self.rules.find(info, sender, recipient, body);
        }
    };
    pub fn snapshot(self: *RuntimeDenylist) Snapshot {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.active_refs += 1;
        return .{ .denylist = self, .rules = self.active };
    }
    pub fn summary(self: *RuntimeDenylist) Summary {
        self.mutex.lock();
        defer self.mutex.unlock();
        return .{ .version = self.version.load(.acquire), .message_rules = self.active.messages.len, .address_rules = self.active.addresses.len };
    }
    pub fn hasAddressRules(self: *RuntimeDenylist) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.active.addresses.len != 0;
    }
    /// Returned reason is owned by the caller, independent of later refreshes.
    pub fn denyReasonForMessage(self: *RuntimeDenylist, message: @import("../protocol/root.zig").Message) !?[]u8 {
        var snap = self.snapshot();
        defer snap.deinit();
        if (snap.rules.isEmpty()) return null;
        const body = try matching.lowerHexAlloc(self.allocator, message.body);
        defer self.allocator.free(body);
        const reason = (try snap.denyReason(.{ .src_msg_id = message.id(), .src_domain = message.origin, .src_addr = &message.sender, .dst_domain = message.destination, .dst_addr = &message.recipient, .body_hex = body }, &message.sender, &message.recipient, message.body)) orelse return null;
        return try self.allocator.dupe(u8, reason);
    }
    /// Fetch failure never mutates active rules. Parse failure likewise retains
    /// the previous snapshot; only successful full-file parse can replace it.
    pub fn refresh(self: *RuntimeDenylist, clock: Clock) !Summary {
        self.refresh_mutex.lock();
        defer self.refresh_mutex.unlock();
        const config = self.config orelse return error.DenylistUrlNotConfigured;
        const transport = self.transport orelse return error.DenylistTransportNotConfigured;
        var fetched = self.fetch(config.url, transport) catch |err| {
            self.notifyFailure(.fetch);
            return err;
        };
        defer fetched.deinit();
        if (fetched.status < 200 or fetched.status >= 300) {
            self.notifyFailure(.status);
            return error.DenylistHttpStatus;
        }
        const parsed = parseAtNanos(self.allocator, fetched.bytes, clock.nanos(), self.engine) catch |err| {
            self.notifyFailure(.parse);
            return err;
        };
        try self.install(parsed.rules);
        writeCache(config.cache_path, fetched.bytes) catch {
            // Rust logs this warning but treats the network refresh as successful.
            if (self.observer.on_cache_write_failure) |callback| callback(self.observer.context);
        };
        const now = clock.now_unix(clock.context);
        if (self.observer.on_refresh_success) |callback| callback(self.observer.context, now);
        return self.summary();
    }
    pub fn initialLoad(self: *RuntimeDenylist, clock: Clock, sleeper: ?Sleeper) !void {
        const config = self.config orelse return;
        var attempt: u32 = 1;
        while (true) : (attempt += 1) {
            if (self.refresh(clock)) |_| return else |_| {}
            if (attempt >= initial_fetch_attempts) break;
            if (sleeper) |worker| worker.sleep_ms(worker.context, initial_fetch_backoff_ms);
        }
        const bytes = std.fs.cwd().readFileAlloc(self.allocator, config.cache_path, max_file_bytes) catch return;
        defer self.allocator.free(bytes);
        const parsed = parseAtNanos(self.allocator, bytes, clock.nanos(), self.engine) catch return;
        self.install(parsed.rules) catch return;
    }
    /// Polling prunes expiries even when fetching fails, matching the source's
    /// poll loop. Administrative refresh alone retains its existing contract.
    pub fn pollOnce(self: *RuntimeDenylist, clock: Clock) !Summary {
        _ = self.refresh(clock) catch |err| {
            try self.pruneExpired(clock);
            return err;
        };
        try self.pruneExpired(clock);
        return self.summary();
    }
    pub fn pruneExpired(self: *RuntimeDenylist, clock: Clock) !void {
        self.refresh_mutex.lock();
        defer self.refresh_mutex.unlock();
        var snap = self.snapshot();
        defer snap.deinit();
        const now = clock.nanos();
        var expired = false;
        for (snap.rules.messages) |rule| if (rule.expires_at != null and rule.expires_at.? <= now) {
            expired = true;
            break;
        };
        if (!expired) for (snap.rules.addresses) |rule| if (rule.expires_at != null and rule.expires_at.? <= now) {
            expired = true;
            break;
        };
        if (!expired) return;
        var output = std.Io.Writer.Allocating.init(self.allocator);
        defer output.deinit();
        try output.writer.writeAll("{\"rules\":[");
        for (snap.rules.fingerprint, 0..) |canonical, i| {
            if (i != 0) try output.writer.writeByte(',');
            try output.writer.writeAll(canonical);
        }
        try output.writer.writeAll("]}");
        const parsed = try parseAtNanos(self.allocator, output.written(), now, self.engine);
        try self.install(parsed.rules);
    }
    /// Consumes parsed rules on success and failure.
    fn install(self: *RuntimeDenylist, incoming: ActiveRules) !void {
        var owned = incoming;
        const rules = self.allocator.create(ActiveRules) catch |err| {
            owned.deinit();
            return err;
        };
        rules.* = owned;
        self.replaceParsed(rules) catch |err| {
            rules.deinit();
            self.allocator.destroy(rules);
            return err;
        };
    }
    fn replaceParsed(self: *RuntimeDenylist, rules: *ActiveRules) !void {
        self.mutex.lock();
        const changed = !sameFingerprint(self.active.fingerprint, rules.fingerprint);
        if (!changed) {
            self.mutex.unlock();
            rules.deinit();
            self.allocator.destroy(rules);
            return;
        }
        const node = self.allocator.create(Retired) catch |err| {
            self.mutex.unlock();
            return err;
        };
        node.* = .{ .rules = self.active, .refs = self.active_refs };
        self.retired.append(node) catch |err| {
            self.allocator.destroy(node);
            self.mutex.unlock();
            return err;
        };
        self.active = rules;
        self.active_refs = 0;
        _ = self.version.fetchAdd(1, .acq_rel);
        const changed_summary = Summary{ .version = self.version.load(.acquire), .message_rules = rules.messages.len, .address_rules = rules.addresses.len };
        self.mutex.unlock();
        self.collect();
        if (self.observer.on_rules_changed) |callback| callback(self.observer.context, changed_summary);
    }
    pub fn collect(self: *RuntimeDenylist) void {
        while (true) {
            const node = blk: {
                self.mutex.lock();
                defer self.mutex.unlock();
                for (self.retired.items, 0..) |node, i| if (node.refs == 0) break :blk self.retired.swapRemove(i);
                return;
            };
            node.rules.deinit();
            self.allocator.destroy(node.rules);
            self.allocator.destroy(node);
        }
    }
    fn notifyFailure(self: *RuntimeDenylist, kind: RefreshFailureKind) void {
        if (self.observer.on_refresh_failure) |callback| callback(self.observer.context, kind);
    }
    fn fetch(self: *RuntimeDenylist, url: []const u8, transport: Transport) !Fetched {
        const uri = try std.Uri.parse(url);
        if (std.mem.eql(u8, uri.scheme, "file")) {
            if (uri.host != null and !std.mem.eql(u8, uri.host.?.percent_encoded, "localhost")) return error.NonlocalDenylistFile;
            const encoded = uri.path.percent_encoded;
            const storage = try self.allocator.alloc(u8, encoded.len);
            defer self.allocator.free(storage);
            const path = std.Uri.percentDecodeBackwards(storage, encoded);
            const bytes = try std.fs.cwd().readFileAlloc(self.allocator, path, max_file_bytes);
            errdefer self.allocator.free(bytes);
            if (bytes.len > max_file_bytes) return error.DenylistTooLarge;
            return .{ .allocator = self.allocator, .bytes = bytes, .status = 200 };
        }
        if (!std.mem.eql(u8, uri.scheme, "http") and !std.mem.eql(u8, uri.scheme, "https")) return error.UnsupportedDenylistScheme;
        var result = try transport.fetch(transport.context, self.allocator, url, max_file_bytes);
        errdefer result.deinit();
        if (result.bytes.len > max_file_bytes) return error.DenylistTooLarge;
        return result;
    }
};
fn sameFingerprint(left: []const []const u8, right: []const []const u8) bool {
    if (left.len != right.len) return false;
    for (left, right) |a, b| if (!std.mem.eql(u8, a, b)) return false;
    return true;
}
fn writeCache(path: []const u8, bytes: []const u8) !void {
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    if (path.len + 4 >= buffer.len) return error.CachePathTooLong;
    @memcpy(buffer[0..path.len], path);
    @memcpy(buffer[path.len .. path.len + 4], ".tmp");
    const temporary = buffer[0 .. path.len + 4];
    try std.fs.cwd().writeFile(.{ .sub_path = temporary, .data = bytes });
    try std.fs.cwd().rename(temporary, path);
}
fn jsonValueEql(left: std.json.Value, right: std.json.Value) bool {
    if (@as(std.meta.Tag(std.json.Value), left) != @as(std.meta.Tag(std.json.Value), right)) return false;
    return switch (left) {
        .null => true,
        .bool => |v| v == right.bool,
        .integer => |v| v == right.integer,
        .float => |v| v == right.float,
        .number_string => |v| std.mem.eql(u8, v, right.number_string),
        .string => |v| std.mem.eql(u8, v, right.string),
        .array => |v| v.items.len == right.array.items.len and blk: {
            for (v.items, right.array.items) |a, b| if (!jsonValueEql(a, b)) break :blk false;
            break :blk true;
        },
        .object => |v| v.count() == right.object.count() and blk: {
            var it = v.iterator();
            while (it.next()) |entry| {
                const other = right.object.get(entry.key_ptr.*) orelse break :blk false;
                if (!jsonValueEql(entry.value_ptr.*, other)) break :blk false;
            }
            break :blk true;
        },
    };
}
const testing = std.testing;
test "runtime denylist validates constraints and rejects dangerous aliases" {
    const valid =
        \\{"rules":[{"reason":"bad","addedBy":"ops","match":{"originDomain":1}}]}
    ;
    var parsed = try parse(testing.allocator, valid, 0, null);
    defer parsed.rules.deinit();
    try testing.expectEqual(@as(usize, 1), parsed.rules.messages.len);
    const invalid = [_][]const u8{
        \\{"rules":[{"reason":"bad","addedBy":"ops","match":{"bodyRegex":".*"}}]}
        ,
        \\{"rules":[{"reason":"bad","addedBy":"ops","match":{"messageId":[]}}]}
        ,
        \\{"rules":[{"reason":"bad","addedBy":"ops","match":{"originDomain":1,"origindomain":2}}]}
        ,
        \\{"rules":[{"reason":"bad","addedBy":"ops","extra":1}]}
        ,
    };
    for (invalid) |bytes| {
        if (parse(testing.allocator, bytes, 0, null)) |_| return testing.expect(false) catch {} else |_| {}
    }
}
test "runtime denylist parses exact addresses and prunes expired rules" {
    const text =
        \\{"rules":[{"reason":" recipient ","addedBy":" ops ","expiresAt":"2026-01-01T00:00:01Z","address":"0x0102030405060708090a0b0c0d0e0f1011121314"}]}
    ;
    var parsed = try parse(testing.allocator, text, 1_767_225_601, null);
    defer parsed.rules.deinit();
    try testing.expectEqual(@as(usize, 0), parsed.rules.addresses.len);
    try testing.expectEqual(@as(usize, 1), parsed.discarded_expired);
}
test "runtime denylist keeps active snapshot after fetch and parse failures" {
    const Mode = enum { valid, status, invalid };
    const Context = struct {
        mode: Mode,
        fn fetch(context: *anyopaque, allocator: std.mem.Allocator, _: []const u8, _: usize) anyerror!Fetched {
            const self: *@This() = @ptrCast(@alignCast(context));
            const body: []const u8 = switch (self.mode) {
                .valid => "{\"rules\":[{\"reason\":\"bad\",\"addedBy\":\"ops\",\"match\":{\"originDomain\":1}}]}",
                .status => "unavailable",
                .invalid => "{\"rules\":[{\"reason\":\"bad\",\"addedBy\":\"ops\",\"match\":{\"bodyRegex\":\".*\"}}]}",
            };
            return .{ .allocator = allocator, .bytes = try allocator.dupe(u8, body), .status = if (self.mode == .status) 503 else 200 };
        }
    };
    const FixedClock = struct {
        fn now(_: *anyopaque) i64 {
            return 1;
        }
    };
    var failures: usize = 0;
    var context = Context{ .mode = .valid };
    var clock_context: u8 = 0;
    var denylist = try RuntimeDenylist.init(testing.allocator, null);
    defer denylist.deinit();
    denylist.config = .{ .url = "http://denylist.invalid/rules", .poll_interval_ms = 60_000, .cache_path = "/tmp/ziggy-ops-denylist-cache.json" };
    denylist.transport = .{ .context = &context, .fetch = Context.fetch };
    denylist.observer.on_refresh_failure = struct {
        fn callback(_: ?*anyopaque, _: RefreshFailureKind) void {}
    }.callback;
    const clock = Clock{ .context = &clock_context, .now_unix = FixedClock.now };
    var first = try denylist.refresh(clock);
    try testing.expectEqual(@as(u64, 1), first.version);
    try testing.expectEqual(@as(usize, 1), first.message_rules);
    context.mode = .status;
    try testing.expectError(error.DenylistHttpStatus, denylist.refresh(clock));
    context.mode = .invalid;
    try testing.expectError(error.UnconstrainedMatch, denylist.refresh(clock));
    first = denylist.summary();
    try testing.expectEqual(@as(u64, 1), first.version);
    try testing.expectEqual(@as(usize, 1), first.message_rules);
    std.fs.cwd().deleteFile("/tmp/ziggy-ops-denylist-cache.json") catch {};
    failures = 0;
}

const precise_rule = "{\"rules\":[{\"reason\":\"deny\",\"addedBy\":\"ops\",\"expiresAt\":\"1970-01-01T00:00:01.000000001Z\",\"match\":{\"originDomain\":1}}]}";
test "runtime expiry retains nanoseconds prunes during outage and owns returned reason" {
    const Context = struct {
        ns: i128 = std.time.ns_per_s,
        fn seconds(context: *anyopaque) i64 {
            const self: *@This() = @ptrCast(@alignCast(context));
            return @intCast(@divFloor(self.ns, std.time.ns_per_s));
        }
        fn nanos(context: *anyopaque) i128 {
            const self: *@This() = @ptrCast(@alignCast(context));
            return self.ns;
        }
    };
    var context: Context = .{};
    const clock: Clock = .{ .context = &context, .now_unix = Context.seconds, .now_ns = Context.nanos };
    var denylist = try RuntimeDenylist.init(testing.allocator, null);
    defer denylist.deinit();
    const parsed = try parse(testing.allocator, precise_rule, 1, null);
    try denylist.install(parsed.rules);
    try testing.expectEqual(@as(usize, 1), denylist.summary().message_rules);
    const reason = (try denylist.denyReasonForMessage(.{ .origin = 1 })).?;
    defer testing.allocator.free(reason);
    try denylist.pruneExpired(clock);
    try testing.expectEqual(@as(u64, 1), denylist.summary().version);
    context.ns += 1;
    try denylist.pruneExpired(clock);
    try testing.expectEqual(@as(u64, 2), denylist.summary().version);
    try testing.expectEqual(@as(usize, 0), denylist.summary().message_rules);
    try testing.expectEqualStrings("deny (added by ops)", reason);
    try testing.expectEqual(@as(i64, -1), try parseRfc3339("1969-12-31T23:59:59Z"));
    try testing.expectEqual(@as(i64, -62167219200), try parseRfc3339("0000-01-01T00:00:00Z"));
    try testing.expect((try denylist.denyReasonForMessage(.{ .origin = 1 })) == null);
    for ([_][]const u8{ "1970-01-01T00x00:01Z", "1970-01-01T00:00x01Z", "1970-+1-01T00:00:01Z" }) |invalid| try testing.expectError(error.InvalidRfc3339, parseRfc3339(invalid));
}
test "runtime canonical fingerprints ignore object order and exclude expired rules" {
    const first = "{\"rules\":[{\"reason\":\"deny\",\"addedBy\":\"ops\",\"address\":null,\"expiresAt\":null,\"match\":{\"originDomain\":1,\"bodyRegex\":null}}]}";
    const reordered = "{\"rules\":[{\"match\":{\"bodyRegex\":null,\"originDomain\":1},\"expiresAt\":null,\"address\":null,\"addedBy\":\"ops\",\"reason\":\"deny\"}]}";
    var one = try parse(testing.allocator, first, 1, null);
    defer one.rules.deinit();
    var two = try parse(testing.allocator, reordered, 1, null);
    defer two.rules.deinit();
    try testing.expect(sameFingerprint(one.rules.fingerprint, two.rules.fingerprint));
    var expired = try parse(testing.allocator, precise_rule, 2, null);
    defer expired.rules.deinit();
    try testing.expectEqual(@as(usize, 0), expired.rules.fingerprint.len);
}
test "runtime Tron rules reject checksum typos in scalar address and matching arrays" {
    const tron = @import("../altvm/tron.zig");
    const encoded = try tron.encodeAddress(testing.allocator, tron.fromEthereumAddress(@splat(1)));
    defer testing.allocator.free(encoded);
    for (0..2) |alter| {
        if (alter == 1) encoded[encoded.len - 1] = if (encoded[encoded.len - 1] == '1') '2' else '1';
        const cases = [_][]const u8{
            try std.json.Stringify.valueAlloc(testing.allocator, .{ .rules = .{.{ .reason = "deny", .addedBy = "ops", .address = encoded }} }, .{}),
            try std.json.Stringify.valueAlloc(testing.allocator, .{ .rules = .{.{ .reason = "deny", .addedBy = "ops", .match = .{ .senderAddress = .{encoded} } }} }, .{}),
        };
        defer for (cases) |wire| testing.allocator.free(wire);
        for (cases) |wire| {
            if (alter == 0) {
                var parsed = try parse(testing.allocator, wire, 0, null);
                parsed.rules.deinit();
            } else try testing.expectError(error.InvalidTronChecksum, parse(testing.allocator, wire, 0, null));
        }
    }
}
fn denylistAllocations(a: std.mem.Allocator) !void {
    var denylist = try RuntimeDenylist.init(a, null);
    defer denylist.deinit();
    const old = try parse(a, "{\"rules\":[{\"reason\":\"a\",\"addedBy\":\"ops\",\"match\":{\"originDomain\":1}},{\"reason\":\"b\",\"addedBy\":\"ops\",\"match\":{\"destinationDomain\":2}}]}", 0, null);
    try denylist.install(old.rules);
    var retained = denylist.snapshot();
    defer retained.deinit();
    const next = try parse(a, precise_rule, 0, null);
    try denylist.install(next.rules);
    const reason = try denylist.denyReasonForMessage(.{ .origin = 1 });
    if (reason) |owned| a.free(owned);
}
test "runtime allocation failure releases partially parsed rules and failed hot replacements" {
    try testing.checkAllAllocationFailures(testing.allocator, denylistAllocations, .{});
    const invalid = "{\"rules\":[{\"reason\":\"a\",\"addedBy\":\"ops\",\"match\":{\"originDomain\":1}},{\"reason\":\"b\",\"addedBy\":\"ops\",\"match\":{\"destinationDomain\":2}},false]}";
    try testing.expectError(error.InvalidDenylistRule, parse(testing.allocator, invalid, 0, null));
}

test "206 unchanged production Rust denylist parser cases including canonical fingerprints and expiry" {
    const Expected = struct { accepted: bool, messages: usize = 0, addresses: usize = 0, fingerprint: []const []const []const u8 = &.{} };
    const Case = struct { name: []const u8, wire: []const []const u8, now: i64, nanos: u32, requires_regex: bool, intentional_duplicate_rejection: bool, expected: Expected };
    const Corpus = struct { cases: []const Case };
    var corpus = try @import("../testing/fixture.zig").parse(Corpus, testing.allocator, @embedFile("testing/denylist.json.gz"), .{ .ignore_unknown_fields = true });
    defer corpus.deinit();
    const library = std.posix.getenv("ZIGGY_REGEX_LIBRARY");
    var engine: ?regex.Engine = if (library) |path| try regex.Engine.init(testing.allocator, path) else null;
    defer if (engine) |*native| native.deinit();
    for (corpus.value.cases) |case| {
        if (case.requires_regex and engine == null) continue;
        const wire = try std.mem.concat(testing.allocator, u8, case.wire);
        defer testing.allocator.free(wire);
        var actual = parseAtNanos(testing.allocator, wire, @as(i128, case.now) * std.time.ns_per_s + case.nanos, if (engine) |*native| native else null) catch |err| {
            if (case.expected.accepted and !case.intentional_duplicate_rejection) {
                std.debug.print("Rust accepted {s}; Zig rejected {s}\n", .{ case.name, @errorName(err) });
                return err;
            }
            continue;
        };
        defer actual.rules.deinit();
        if (!case.expected.accepted or case.intentional_duplicate_rejection) {
            std.debug.print("Rust rejected {s}; Zig accepted\n", .{case.name});
            return error.AcceptedInvalidDenylist;
        }
        try testing.expectEqual(case.expected.messages, actual.rules.messages.len);
        try testing.expectEqual(case.expected.addresses, actual.rules.addresses.len);
        try testing.expectEqual(case.expected.fingerprint.len, actual.rules.fingerprint.len);
        for (case.expected.fingerprint, actual.rules.fingerprint) |chunks, observed| {
            const expected = try std.mem.concat(testing.allocator, u8, chunks);
            defer testing.allocator.free(expected);
            try testing.expectEqualStrings(expected, observed);
        }
    }
    try testing.expectEqual(@as(usize, 206), corpus.value.cases.len);
}
