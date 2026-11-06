//! Layered agent configuration. Values may contain credentials: no formatter or
//! diagnostics in this module include source values or environment contents.
const std = @import("std");
const Value = std.json.Value;
pub const EnvironmentEntry = struct { key: []const u8, value: []const u8 };
pub const Sources = struct {
    defaults: []const []const u8 = &.{},
    files: []const []const u8 = &.{},
    environment: []const EnvironmentEntry = &.{},
    arguments: []const []const u8 = &.{},
};

pub const Config = struct {
    arena: std.heap.ArenaAllocator,
    root: Value,

    pub fn load(backing: std.mem.Allocator, sources: Sources) !Config {
        var arena = std.heap.ArenaAllocator.init(backing);
        errdefer arena.deinit();
        const allocator = arena.allocator();
        var root: Value = .{ .object = std.json.ObjectMap.init(allocator) };
        for (sources.defaults) |file| try mergeFile(allocator, &root, file);
        for (sources.files) |file| try mergeFile(allocator, &root, file);
        for (sources.environment) |entry| {
            if (!std.mem.startsWith(u8, entry.key, "HYP_")) continue;
            const path = try allocator.dupe(u8, entry.key[4..]);
            for (path) |*byte| if (byte.* == '_') {
                byte.* = '.';
            };
            try setPath(allocator, &root, path, .{ .string = try allocator.dupe(u8, entry.value) }, 0);
        }
        var i: usize = 0;
        while (i < sources.arguments.len) : (i += 1) {
            const argument = sources.arguments[i];
            if (!std.mem.startsWith(u8, argument, "--") or argument.len == 2) return error.InvalidConfigArgument;
            const body = argument[2..];
            const equal = std.mem.indexOfScalar(u8, body, '=');
            const path = if (equal) |index| body[0..index] else body;
            const text = if (equal) |index| blk: {
                const value = body[index + 1 ..];
                if (value.len > 0 and (value[0] == '"' or value[0] == 39)) {
                    if (value.len < 2 or value[value.len - 1] != value[0]) return error.UnmatchedConfigQuote;
                    break :blk value[1 .. value.len - 1];
                }
                break :blk value;
            } else blk: {
                if (i + 1 >= sources.arguments.len) break :blk "";
                const next = sources.arguments[i + 1];
                if (next.len == 0 or next[0] == '-') break :blk "";
                i += 1;
                break :blk next;
            };
            try setPath(allocator, &root, path, .{ .string = try allocator.dupe(u8, text) }, 0);
        }
        return .{ .arena = arena, .root = root };
    }

    pub fn deinit(self: *Config) void {
        self.arena.deinit();
        self.* = undefined;
    }

    pub fn get(self: *const Config, path: []const u8) !?Value {
        var current = self.root;
        var parts = std.mem.splitScalar(u8, path, '.');
        var buffer: [256]u8 = undefined;
        while (parts.next()) |part| {
            const key = try normalizedInto(&buffer, part);
            if (current == .object) {
                current = current.object.get(key) orelse return null;
            } else if (current == .array) {
                const index = std.fmt.parseInt(usize, key, 10) catch return error.InvalidConfigPath;
                if (index >= current.array.items.len) return null;
                current = current.array.items[index];
            } else return error.ConfigPathTypeMismatch;
        }
        return current;
    }

    pub fn string(self: *const Config, path: []const u8) ![]const u8 {
        const value = try self.get(path) orelse return error.MissingConfiguration;
        if (value != .string) return error.InvalidConfigString;
        return value.string;
    }

    pub fn integer(self: *const Config, comptime T: type, path: []const u8) !T {
        const value = try self.get(path) orelse return error.MissingConfiguration;
        return switch (value) {
            .integer => |number| std.math.cast(T, number) orelse error.InvalidConfigInteger,
            .number_string => |text| std.fmt.parseInt(T, text, 10) catch error.InvalidConfigInteger,
            .string => |text| @import("settings/value.zig").decimalInt(T, text),
            else => error.InvalidConfigInteger,
        };
    }

    pub fn boolean(self: *const Config, path: []const u8) !bool {
        const value = try self.get(path) orelse return error.MissingConfiguration;
        return switch (value) {
            .bool => |boolean_value| boolean_value,
            .string => |text| if (std.ascii.eqlIgnoreCase(text, "true")) true else if (std.ascii.eqlIgnoreCase(text, "false")) false else error.InvalidConfigBoolean,
            else => error.InvalidConfigBoolean,
        };
    }
};

fn normalizedInto(out: []u8, text: []const u8) ![]const u8 {
    var length: usize = 0;
    for (text) |byte| {
        if (byte == '_' or byte == '-' or byte == ' ') continue;
        if (!std.ascii.isAlphanumeric(byte)) return error.InvalidConfigKey;
        if (length == out.len) return error.ConfigKeyTooLong;
        out[length] = std.ascii.toLower(byte);
        length += 1;
    }
    if (length == 0) return error.InvalidConfigKey;
    return out[0..length];
}

fn normalize(allocator: std.mem.Allocator, value: Value, depth: usize) anyerror!Value {
    if (depth > 32) return error.ConfigTooDeep;
    switch (value) {
        .object => |object| {
            var result = std.json.ObjectMap.init(allocator);
            var iterator = object.iterator();
            var buffer: [256]u8 = undefined;
            while (iterator.next()) |entry| {
                const key = try normalizedInto(&buffer, entry.key_ptr.*);
                if (result.contains(key)) return error.AmbiguousConfigKey;
                try result.put(try allocator.dupe(u8, key), try normalize(allocator, entry.value_ptr.*, depth + 1));
            }
            return .{ .object = result };
        },
        .array => |array| {
            var result = std.array_list.Managed(Value).init(allocator);
            for (array.items) |entry| try result.append(try normalize(allocator, entry, depth + 1));
            return .{ .array = result };
        },
        else => return value,
    }
}

fn merge(target: *Value, update: Value) anyerror!void {
    if (target.* == .object and update == .object) {
        var entries = update.object.iterator();
        while (entries.next()) |entry| {
            if (target.object.getPtr(entry.key_ptr.*)) |previous| {
                try merge(previous, entry.value_ptr.*);
            } else try target.object.put(entry.key_ptr.*, entry.value_ptr.*);
        }
    } else target.* = update;
}

fn mergeFile(allocator: std.mem.Allocator, target: *Value, file: []const u8) !void {
    if (!std.mem.endsWith(u8, file, ".json")) return error.UnsupportedConfigFile;
    const bytes = try std.fs.cwd().readFileAlloc(allocator, file, 16 * 1024 * 1024);
    const parsed = try std.json.parseFromSlice(Value, allocator, bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
    if (parsed.value != .object) return error.InvalidConfigRoot;
    try merge(target, try normalize(allocator, parsed.value, 0));
}

fn setPath(allocator: std.mem.Allocator, target: *Value, path: []const u8, value: Value, depth: usize) anyerror!void {
    if (depth > 32) return error.ConfigTooDeep;
    const dot = std.mem.indexOfScalar(u8, path, '.');
    var buffer: [256]u8 = undefined;
    const key = try normalizedInto(&buffer, if (dot) |index| path[0..index] else path);
    // config 0.13 dotted paths create tables, including numeric components.
    // A table replacing an array/scalar discards that prior value.
    if (target.* != .object) target.* = .{ .object = std.json.ObjectMap.init(allocator) };
    const entry = try target.object.getOrPut(try allocator.dupe(u8, key));
    if (!entry.found_existing) entry.value_ptr.* = .null;
    if (dot) |index| {
        try setPath(allocator, entry.value_ptr, path[index + 1 ..], value, depth + 1);
    } else entry.value_ptr.* = value;
}

test "environment and CLI layer over JSON; empty and false remain explicit" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    try temp.dir.writeFile(.{ .sub_path = "base.json", .data = "{\"chains\":{\"Ethereum\":{\"chainId\":1,\"rpcUrls\":[{\"http\":\"https://example.com\"}]}},\"maxRetries\":66,\"flag\":true}" });
    const path = try temp.dir.realpathAlloc(std.testing.allocator, "base.json");
    defer std.testing.allocator.free(path);
    var config = try Config.load(std.testing.allocator, .{
        .defaults = &.{path},
        .environment = &.{ .{ .key = "HYP_MAXRETRIES", .value = "0" }, .{ .key = "HYP_FLAG", .value = "false" }, .{ .key = "HYP_EMPTY", .value = "" }, .{ .key = "OTHER", .value = "ignored" }, .{ .key = "HYP_CHAINS_ETHEREUM_RPCURLS_0_HTTP", .value = "https://override.example" } },
        .arguments = &.{ "--chains.ethereum.chainId=2", "--maxRetries", "12" },
    });
    defer config.deinit();
    try std.testing.expectEqual(@as(u64, 2), try config.integer(u64, "chains.ethereum.chainId"));
    try std.testing.expectEqual(@as(u32, 12), try config.integer(u32, "max_retries"));
    try std.testing.expect(!try config.boolean("flag"));
    try std.testing.expectEqualStrings("", try config.string("empty"));
    try std.testing.expectEqualStrings("https://override.example", try config.string("chains.ethereum.rpcUrls.0.http"));
    try std.testing.expectEqual(@as(?Value, null), try config.get("other"));
}

test "invalid scalar types, ambiguous keys and huge integers fail" {
    var config = try Config.load(std.testing.allocator, .{ .environment = &.{ .{ .key = "HYP_NUMBER", .value = "4294967296" }, .{ .key = "HYP_FLAG", .value = "1" } } });
    defer config.deinit();
    try std.testing.expectError(error.InvalidConfigInteger, config.integer(u32, "number"));
    try std.testing.expectError(error.InvalidConfigBoolean, config.boolean("flag"));
    try std.testing.expectError(error.MissingConfiguration, config.string("missing"));
}

/// Recase stringified JSON array values using the same flatcase layer rules.
pub fn normalizedValue(allocator: std.mem.Allocator, value: Value) !Value {
    return normalize(allocator, value, 0);
}
