//! Typed Hyperlane component methods with exact Manifest argument and Scrypto
//! output schemas. Returned Merkle frontiers support local root verification.
const std = @import("std");
const sbor = @import("sbor.zig");
const provider = @import("provider.zig");
const protocol = @import("../protocol/root.zig");
pub const Multisig = struct { validators: [256][20]u8, len: usize, threshold: u8 };
pub const OwnedLocations = struct {
    arena: std.heap.ArenaAllocator,
    values: []const []const []const u8,
    pub fn deinit(self: *OwnedLocations) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub fn decodeTree(value: sbor.Value) !protocol.IncrementalMerkle {
    var fields: [2]sbor.Value = undefined;
    try sbor.fields(value, &fields);
    const count = try sbor.uint(fields[1], u64);
    if (count > std.math.maxInt(u32)) return error.RadixTreeOverflow;
    var branch = try sbor.elements(fields[0]);
    if (branch.remaining != 32) return error.WrongRadixTreeDepth;
    var tree = protocol.IncrementalMerkle.init();
    tree.count = @intCast(count);
    for (&tree.branch) |*hash| {
        const bytes = try sbor.byteArray((try branch.next()).?);
        if (bytes.len != 32) return error.InvalidRadixHash;
        hash.* = bytes[0..32].*;
    }
    return tree;
}
pub fn decodeMultisig(value: sbor.Value) !Multisig {
    var fields: [2]sbor.Value = undefined;
    try sbor.fields(value, &fields);
    const threshold = try sbor.uint(fields[1], u64);
    var validators = try sbor.elements(fields[0]);
    if (validators.remaining > 256 or threshold == 0 or threshold > 255 or threshold > validators.remaining) return error.InvalidThreshold;
    var result: Multisig = .{ .validators = undefined, .len = validators.remaining, .threshold = @intCast(threshold) };
    for (result.validators[0..result.len], 0..) |*out, i| {
        const raw = try sbor.byteArray((try validators.next()).?);
        if (raw.len != 20) return error.InvalidRadixValidator;
        out.* = raw[0..20].*;
        for (result.validators[0..i]) |previous| if (std.mem.eql(u8, &previous, out)) return error.DuplicateValidator;
    }
    return result;
}
pub fn decodeLocations(allocator: std.mem.Allocator, value: sbor.Value, expected_validators: usize) !OwnedLocations {
    var outer = try sbor.elements(value);
    if (outer.remaining != expected_validators or outer.remaining > 256) return error.InvalidValidatorLocations;
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const alloc = arena.allocator();
    const result = try alloc.alloc([]const []const u8, outer.remaining);
    for (result) |*locations| {
        var list = try sbor.elements((try outer.next()).?);
        if (list.remaining > 1024) return error.InvalidValidatorLocations;
        const entries = try alloc.alloc([]const u8, list.remaining);
        for (entries) |*out| out.* = try alloc.dupe(u8, try sbor.text((try list.next()).?));
        locations.* = entries;
    }
    return .{ .arena = arena, .values = result };
}
fn optionalComponent(value: sbor.Value) ![30]u8 {
    if (value.kind != 0x22 or value.body.len < 2) return error.WrongSborValueKind;
    if (value.body[0] == 0 and value.body.len == 2 and value.body[1] == 0) return error.MissingRadixIsm;
    if (value.body[0] != 1 or value.body[1] != 1) return error.WrongSborValueKind;
    var reader: sbor.Reader = .{ .input = value.body[2..], .flavor = value.flavor };
    return sbor.component(try reader.value());
}
fn argumentBytes(allocator: std.mem.Allocator, bytes: []const u8) ![]u8 {
    var writer: sbor.Writer = .{ .allocator = allocator };
    errdefer writer.deinit();
    try writer.byte(0x4d);
    try writer.bytes(bytes);
    return writer.owned();
}
pub const Client = struct {
    provider: provider.Client,
    mailbox: [30]u8,
    domain: u32,
    pub fn count(self: Client, state_version: u64) !u32 {
        var result = try self.provider.callMethod(self.mailbox, "count", &.{}, state_version);
        defer result.deinit();
        return sbor.uint(try result.value(), u32);
    }
    pub fn delivered(self: Client, id: [32]u8) !bool {
        return self.deliveredAt(id, null);
    }
    pub fn deliveredAt(self: Client, id: [32]u8, state_version: ?u64) !bool {
        const args = try argumentBytes(self.provider.allocator, &id);
        defer self.provider.allocator.free(args);
        var result = try self.provider.callMethod(self.mailbox, "delivered", &.{args}, state_version);
        defer result.deinit();
        return sbor.boolean(try result.value());
    }
    pub fn defaultIsm(self: Client) ![30]u8 {
        var result = try self.provider.callMethod(self.mailbox, "default_ism", &.{}, null);
        defer result.deinit();
        return optionalComponent(try result.value());
    }
    pub fn recipientIsm(self: Client, recipient: [30]u8) ![30]u8 {
        var writer: sbor.Writer = .{ .allocator = self.provider.allocator };
        defer writer.deinit();
        try writer.byte(0x4d);
        try writer.address(recipient);
        var result = try self.provider.callMethod(self.mailbox, "recipient_ism", &.{writer.list.items}, null);
        defer result.deinit();
        return optionalComponent(try result.value());
    }
    pub fn tree(self: Client, hook: [30]u8, state_version: u64) !protocol.IncrementalMerkle {
        var result = try self.provider.callMethod(hook, "tree", &.{}, state_version);
        defer result.deinit();
        return decodeTree(try result.value());
    }
    pub fn moduleType(self: Client, ism: [30]u8) !u8 {
        var result = try self.provider.callMethod(ism, "module_type", &.{}, null);
        defer result.deinit();
        const value = try result.value();
        if (value.kind != 0x22 or value.body.len != 2 or value.body[1] != 0 or value.body[0] > 7) return error.UnsupportedRadixIsm;
        return value.body[0];
    }
    pub fn validators(self: Client, ism: [30]u8, message: protocol.Message) !Multisig {
        const bytes = try message.encodeAlloc(self.provider.allocator);
        defer self.provider.allocator.free(bytes);
        const arg = try argumentBytes(self.provider.allocator, bytes);
        defer self.provider.allocator.free(arg);
        var result = try self.provider.callMethod(ism, "validators_and_threshold", &.{arg}, null);
        defer result.deinit();
        return decodeMultisig(try result.value());
    }
    pub fn route(self: Client, ism: [30]u8, message: protocol.Message) ![30]u8 {
        const bytes = try message.encodeAlloc(self.provider.allocator);
        defer self.provider.allocator.free(bytes);
        const arg = try argumentBytes(self.provider.allocator, bytes);
        defer self.provider.allocator.free(arg);
        var result = try self.provider.callMethod(ism, "route", &.{arg}, null);
        defer result.deinit();
        return sbor.component(try result.value());
    }
    pub fn locations(self: Client, announce: [30]u8, validators_: []const [20]u8) !OwnedLocations {
        return self.locationsAt(announce, validators_, null);
    }
    pub fn locationsAt(self: Client, announce: [30]u8, validators_: []const [20]u8, state_version: ?u64) !OwnedLocations {
        if (validators_.len > 256) return error.TooManyValidators;
        var writer: sbor.Writer = .{ .allocator = self.provider.allocator };
        defer writer.deinit();
        try writer.byte(0x4d);
        try writer.array(0x20, validators_.len);
        for (validators_) |validator| {
            try writer.byte(7);
            try writer.size(20);
            try writer.raw(&validator);
        }
        var result = try self.provider.callMethod(announce, "get_announced_storage_locations", &.{writer.list.items}, state_version);
        defer result.deinit();
        return decodeLocations(self.provider.allocator, try result.value(), validators_.len);
    }
};

test "Radix delivered state query pins and authenticates exact state version" {
    const http = @import("../cloud/http.zig");
    const Mock = struct {
        mismatch: bool = false,
        fn send(context: *anyopaque, a: std.mem.Allocator, request: http.Request) !http.Response {
            const self: *@This() = @ptrCast(@alignCast(context));
            const parsed = try std.json.parseFromSlice(std.json.Value, a, request.body orelse return error.MissingBody, .{});
            defer parsed.deinit();
            const at = parsed.value.object.get("at_ledger_state").?;
            try std.testing.expectEqual(@as(i64, 123), at.object.get("state_version").?.integer);
            try std.testing.expectEqualStrings("delivered", parsed.value.object.get("target").?.object.get("method_name").?.string);
            return .{ .allocator = a, .status = 200, .bytes = try std.fmt.allocPrint(a, "{{\"status\":\"Succeeded\",\"at_ledger_state\":{{\"state_version\":{d}}},\"output\":{{\"hex\":\"5c0101\"}}}}", .{if (self.mismatch) @as(u64, 122) else 123}) };
        }
    };
    var mock: Mock = .{};
    const client: Client = .{ .provider = .{ .allocator = std.testing.allocator, .transport = .{ .context = &mock, .send_fn = Mock.send }, .core = .{ .url = "https://fixture.invalid" }, .gateway = .{ .url = "https://fixture.invalid" }, .network = @import("address.zig").Network.simulator, .confirmations = 0 }, .mailbox = .{1} ** 30, .domain = 2 };
    try std.testing.expect(try client.deliveredAt(.{2} ** 32, 123));
    mock.mismatch = true;
    try std.testing.expectError(error.WrongRadixStateVersion, client.deliveredAt(.{2} ** 32, 123));
}

test "Radix announcement historical absence authenticates state version" {
    const http = @import("../cloud/http.zig");
    const Mock = struct {
        mismatch: bool = false,
        fn send(context: *anyopaque, a: std.mem.Allocator, request: http.Request) !http.Response {
            const self: *@This() = @ptrCast(@alignCast(context));
            const parsed = try std.json.parseFromSlice(std.json.Value, a, request.body orelse return error.MissingBody, .{});
            defer parsed.deinit();
            const at = parsed.value.object.get("at_ledger_state").?;
            try std.testing.expectEqual(@as(i64, 123), at.object.get("state_version").?.integer);
            try std.testing.expectEqualStrings("get_announced_storage_locations", parsed.value.object.get("target").?.object.get("method_name").?.string);
            return .{ .allocator = a, .status = 200, .bytes = try std.fmt.allocPrint(a, "{{\"status\":\"Succeeded\",\"at_ledger_state\":{{\"state_version\":{d}}},\"output\":{{\"hex\":\"5c202000\"}}}}", .{if (self.mismatch) @as(u64, 122) else 123}) };
        }
    };
    var mock: Mock = .{};
    const client: Client = .{ .provider = .{ .allocator = std.testing.allocator, .transport = .{ .context = &mock, .send_fn = Mock.send }, .core = .{ .url = "https://fixture.invalid" }, .gateway = .{ .url = "https://fixture.invalid" }, .network = @import("address.zig").Network.simulator, .confirmations = 0 }, .mailbox = .{1} ** 30, .domain = 2 };
    var result = try client.locationsAt(.{2} ** 30, &.{}, 123);
    defer result.deinit();
    try std.testing.expectEqual(@as(usize, 0), result.values.len);
    mock.mismatch = true;
    try std.testing.expectError(error.WrongRadixStateVersion, client.locationsAt(.{2} ** 30, &.{}, 123));
}
