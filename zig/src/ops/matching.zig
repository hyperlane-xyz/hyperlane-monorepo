//! Hyperlane matching-list parity on typed settings rules.
//! Regex-bearing lists explicitly require the pinned native Rust regex ABI.
const std = @import("std");
const protocol = @import("../protocol/root.zig");
const settings = @import("../settings/types.zig");
const regex = @import("regex.zig");
pub const MatchInfo = struct {
    src_msg_id: [32]u8,
    src_domain: u32,
    src_addr: []const u8,
    dst_domain: u32,
    dst_addr: []const u8,
    /// Already-encoded lowercase hexadecimal, without `0x`, matching Rust `MatchInfo`.
    body_hex: []const u8,
};
pub const Matcher = struct {
    arena: std.heap.ArenaAllocator,
    rules: []settings.Rule,
    regexes: []?regex.Regex,
    pub fn init(backing: std.mem.Allocator, list: settings.MatchingList, engine: ?*regex.Engine) !Matcher {
        var self: Matcher = .{ .arena = std.heap.ArenaAllocator.init(backing), .rules = &.{}, .regexes = &.{} };
        errdefer self.deinit();
        const a = self.arena.allocator();
        self.rules = try a.alloc(settings.Rule, list.len);
        self.regexes = try a.alloc(?regex.Regex, list.len);
        @memset(self.regexes, null);
        for (list, 0..) |source, i| {
            self.rules[i] = .{
                .message_id = try cloneFilter(a, [32]u8, source.message_id),
                .origin_domain = try cloneFilter(a, u32, source.origin_domain),
                .sender_address = try cloneFilter(a, [32]u8, source.sender_address),
                .destination_domain = try cloneFilter(a, u32, source.destination_domain),
                .recipient_address = try cloneFilter(a, [32]u8, source.recipient_address),
                .body_regex = null,
            };
            self.regexes[i] = null;
            if (source.body_regex) |pattern| {
                const owned = try a.dupe(u8, pattern);
                self.rules[i].body_regex = owned;
                const required = engine orelse return error.RegexEngineRequired;
                self.regexes[i] = try required.compile(owned);
            }
        }
        return self;
    }
    pub fn deinit(self: *Matcher) void {
        for (self.regexes) |compiled| {
            if (compiled) |handle| {
                var value = handle;
                value.deinit();
            }
        }
        self.arena.deinit();
        self.* = undefined;
    }
    /// Rust `MatchingList::msg_matches`: empty list is absent and returns
    /// `default`; hashing and body hex encoding happen only when a rule needs them.
    pub fn messageMatches(self: *const Matcher, message: protocol.Message, default: bool) !bool {
        if (self.rules.len == 0) return default;
        var id: ?[32]u8 = null;
        var body: ?[]u8 = null;
        defer if (body) |owned| self.arena.child_allocator.free(owned);
        for (self.rules, self.regexes) |rule, compiled| {
            if (!routeMatches(rule, message.origin, &message.sender, message.destination, &message.recipient)) continue;
            switch (rule.message_id) {
                .wildcard => {},
                .values => |ids| {
                    if (ids.len == 0) continue;
                    if (id == null) id = message.id();
                    var found = false;
                    for (ids) |candidate| {
                        if (std.mem.eql(u8, &candidate, &id.?)) found = true;
                    }
                    if (!found) continue;
                },
            }
            const pattern = compiled orelse return true;
            if (body == null) body = try lowerHexAlloc(self.arena.child_allocator, message.body);
            if (!try pattern.isMatch(body.?)) continue;
            return true;
        }
        return false;
    }
    pub fn infoMatches(self: *const Matcher, info: MatchInfo, default: bool) !bool {
        if (self.rules.len == 0) return default;
        for (self.rules, self.regexes) |rule, compiled| {
            if (!filterHas([32]u8, rule.message_id, &info.src_msg_id)) continue;
            if (!routeMatches(rule, info.src_domain, info.src_addr, info.dst_domain, info.dst_addr)) continue;
            if (compiled) |pattern| {
                if (!try pattern.isMatch(info.body_hex)) continue;
            }
            return true;
        }
        return false;
    }
};
fn cloneFilter(a: std.mem.Allocator, comptime T: type, source: settings.Filter(T)) !settings.Filter(T) {
    return switch (source) {
        .wildcard => .wildcard,
        .values => |values| .{ .values = try a.dupe(T, values) },
    };
}
fn filterHas(comptime T: type, filter: settings.Filter(T), value: *const T) bool {
    return switch (filter) {
        .wildcard => true,
        .values => |values| blk: {
            for (values) |candidate| if (std.meta.eql(candidate, value.*)) break :blk true;
            break :blk false;
        },
    };
}
fn routeMatches(rule: settings.Rule, src_domain: u32, src_addr: []const u8, dst_domain: u32, dst_addr: []const u8) bool {
    return filterHas(u32, rule.origin_domain, &src_domain) and
        filterHasAddress(rule.sender_address, src_addr) and
        filterHas(u32, rule.destination_domain, &dst_domain) and
        filterHasAddress(rule.recipient_address, dst_addr);
}
fn filterHasAddress(filter: settings.Filter([32]u8), value: []const u8) bool {
    if (value.len != 32) return false;
    const fixed: *const [32]u8 = @ptrCast(value.ptr);
    return filterHas([32]u8, filter, fixed);
}
pub fn lowerHexAlloc(allocator: std.mem.Allocator, bytes: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, bytes.len * 2);
    errdefer allocator.free(out);
    for (bytes, 0..) |byte, i| {
        _ = std.fmt.bufPrint(out[i * 2 ..][0..2], "{x:0>2}", .{byte}) catch unreachable;
    }
    return out;
}
/// Immutable current matcher plus drain-before-free hot swap.
pub const HotMatcher = struct {
    pub const Retired = struct {
        matcher: *Matcher,
        refs: usize,
    };
    allocator: std.mem.Allocator,
    mutex: std.Thread.Mutex = .{},
    current: *Matcher,
    current_refs: usize = 0,
    retired: std.array_list.Managed(*Retired),
    pub fn init(allocator: std.mem.Allocator, list: settings.MatchingList, engine: ?*regex.Engine) !HotMatcher {
        const matcher = try allocator.create(Matcher);
        errdefer allocator.destroy(matcher);
        matcher.* = try Matcher.init(allocator, list, engine);
        var retired: std.array_list.Managed(*Retired) = .init(allocator);
        errdefer retired.deinit();
        return .{ .allocator = allocator, .current = matcher, .retired = retired };
    }
    pub const Snapshot = struct {
        hot: *HotMatcher,
        matcher: *const Matcher,
        pub fn deinit(self: *Snapshot) void {
            self.hot.mutex.lock();
            if (self.matcher == self.hot.current) {
                self.hot.current_refs -= 1;
            } else {
                var found = false;
                for (self.hot.retired.items) |node| {
                    if (node.matcher == self.matcher) {
                        node.refs -= 1;
                        found = true;
                        break;
                    }
                }
                if (!found) @panic("matching snapshot generation is invalid");
            }
            self.hot.mutex.unlock();
            self.hot.collect();
            self.* = undefined;
        }
    };
    pub fn snapshot(self: *HotMatcher) Snapshot {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.current_refs += 1;
        return .{ .hot = self, .matcher = self.current };
    }
    /// Install a new immutable matcher without blocking HTTP/runtime readers.
    /// The old matcher is retained until every snapshot that acquired it drains.
    /// Ownership transfers only on success. OOM leaves the active rules intact.
    pub fn update(self: *HotMatcher, matcher: *Matcher) !void {
        const node = try self.allocator.create(Retired);
        errdefer self.allocator.destroy(node);
        {
            self.mutex.lock();
            defer self.mutex.unlock();
            try self.retired.append(node);
            node.* = .{ .matcher = self.current, .refs = self.current_refs };
            self.current = matcher;
            self.current_refs = 0;
        }
        self.collect();
    }
    /// Frees only fully drained generations. It never invalidates live snapshots.
    pub fn collect(self: *HotMatcher) void {
        while (true) {
            const node = blk: {
                self.mutex.lock();
                defer self.mutex.unlock();
                for (self.retired.items, 0..) |node, i| if (node.refs == 0) break :blk self.retired.swapRemove(i);
                return;
            };
            node.matcher.deinit();
            self.allocator.destroy(node.matcher);
            self.allocator.destroy(node);
        }
    }
    pub fn deinit(self: *HotMatcher) void {
        self.collect();
        self.mutex.lock();
        const clean = self.current_refs == 0 and self.retired.items.len == 0;
        self.mutex.unlock();
        if (!clean) @panic("HotMatcher snapshots must drain before deinit");
        self.current.deinit();
        self.allocator.destroy(self.current);
        self.retired.deinit();
        self.* = undefined;
    }
};

test "matching list preserves empty defaults and exact ID semantics" {
    const message: protocol.Message = .{ .origin = 1, .destination = 2, .sender = .{3} ** 32, .recipient = .{4} ** 32, .body = &.{ 0x00, 0xab, 0xff } };
    var empty = try Matcher.init(std.testing.allocator, &.{}, null);
    defer empty.deinit();
    try std.testing.expect(try empty.messageMatches(message, true));
    try std.testing.expect(!try empty.messageMatches(message, false));
    const empty_id: settings.MatchingList = &.{.{ .message_id = .{ .values = &.{} } }};
    var matcher = try Matcher.init(std.testing.allocator, empty_id, null);
    defer matcher.deinit();
    try std.testing.expect(!try matcher.messageMatches(message, true));
    const exact: settings.MatchingList = &.{.{ .message_id = .{ .values = &.{message.id()} } }};
    var exact_matcher = try Matcher.init(std.testing.allocator, exact, null);
    defer exact_matcher.deinit();
    try std.testing.expect(try exact_matcher.messageMatches(message, false));
}
test "hot matcher keeps borrowed old snapshot alive across update" {
    const old_list: settings.MatchingList = &.{.{ .origin_domain = .{ .values = &.{1} } }};
    const new_list: settings.MatchingList = &.{.{ .destination_domain = .{ .values = &.{2} } }};
    var hot = try HotMatcher.init(std.testing.allocator, old_list, null);
    defer hot.deinit();
    var old_snapshot = hot.snapshot();
    const replacement = try std.testing.allocator.create(Matcher);
    replacement.* = try Matcher.init(std.testing.allocator, new_list, null);
    try hot.update(replacement);
    try std.testing.expectEqual(@as(usize, 1), old_snapshot.matcher.rules[0].origin_domain.values.len);
    var new_snapshot = hot.snapshot();
    defer new_snapshot.deinit();
    try std.testing.expectEqual(@as(usize, 1), new_snapshot.matcher.rules[0].destination_domain.values.len);
    old_snapshot.deinit();
    hot.collect();
}
test "body uses lowercase hex without prefix when native regex is available" {
    const path = std.posix.getenv("ZIGGY_REGEX_LIBRARY") orelse return error.SkipZigTest;
    var engine = try regex.Engine.init(std.testing.allocator, path);
    defer engine.deinit();
    const list: settings.MatchingList = &.{.{ .origin_domain = .{ .values = &.{1} }, .body_regex = "^00abff$" }};
    var matcher = try Matcher.init(std.testing.allocator, list, &engine);
    defer matcher.deinit();
    const message: protocol.Message = .{ .origin = 1, .body = &.{ 0x00, 0xab, 0xff } };
    try std.testing.expect(try matcher.messageMatches(message, false));
}
test "lower hex encoding is lowercase unprefixed and bounded" {
    const encoded = try lowerHexAlloc(std.testing.allocator, &.{ 0x00, 0xab, 0xff, 0x10 });
    defer std.testing.allocator.free(encoded);
    try std.testing.expectEqualStrings("00abff10", encoded);
}

fn allocationFailure(a: std.mem.Allocator) !void {
    const rules = [_]settings.Rule{
        .{ .origin_domain = .{ .values = &.{ 1, 2 } }, .message_id = .{ .values = &.{@splat(3)} } },
        .{ .sender_address = .{ .values = &.{ @splat(4), @splat(5) } } },
        .{},
    };
    var matcher = try Matcher.init(a, &rules, null);
    defer matcher.deinit();
    _ = try matcher.messageMatches(.{ .origin = 1 }, false);
}
test "matching list allocation failure cleans only initialized native handles" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationFailure, .{});
}
