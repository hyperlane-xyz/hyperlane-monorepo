//! JavaScript-faithful JSON values for the diagnostics reducer.
//!
//! The TypeScript reducer builds its output by spreading and assigning object
//! keys, so the bytes `JSON.stringify` produces depend on insertion history:
//! assigning `undefined` reserves a key slot that a later assignment reuses,
//! and canonical array-index keys ("0", "7") always sort first. `Object`
//! reproduces those rules; `undefined` is a real value that serialization
//! skips. Everything lives in a caller-provided arena; nothing is freed
//! individually.
const std = @import("std");
const core = @import("core");
const Allocator = std.mem.Allocator;

pub const Value = union(enum) {
    undefined,
    null,
    bool: bool,
    number: f64,
    string: []const u8,
    array: *Array,
    object: *Object,

    pub fn str(self: Value) ?[]const u8 {
        return if (self == .string) self.string else null;
    }

    /// JavaScript truthiness for the values the reducer tests (`x && …`).
    pub fn isNullish(self: Value) bool {
        return self == .undefined or self == .null;
    }
};

pub const Array = std.ArrayList(Value);

pub fn newArray(arena: Allocator, items: []const Value) Allocator.Error!*Array {
    const array = try arena.create(Array);
    array.* = .empty;
    try array.appendSlice(arena, items);
    return array;
}

pub fn newObject(arena: Allocator) Allocator.Error!*Object {
    const object = try arena.create(Object);
    object.* = .{};
    return object;
}

pub const Object = struct {
    entries: std.ArrayList(Entry) = .empty,

    pub const Entry = struct { key: []const u8, value: Value };

    fn find(self: *const Object, key: []const u8) ?usize {
        for (self.entries.items, 0..) |entry, i| {
            if (std.mem.eql(u8, entry.key, key)) return i;
        }
        return null;
    }

    /// `obj[key]`: `.undefined` when absent (as in JavaScript).
    pub fn get(self: *const Object, key: []const u8) Value {
        const i = self.find(key) orelse return .undefined;
        return self.entries.items[i].value;
    }

    /// `key in obj`.
    pub fn has(self: *const Object, key: []const u8) bool {
        return self.find(key) != null;
    }

    /// `obj[key] = value`: existing keys keep their slot; new array-index keys
    /// join the ascending index prefix; other new keys append.
    pub fn put(self: *Object, arena: Allocator, key: []const u8, value: Value) Allocator.Error!void {
        if (self.find(key)) |i| {
            self.entries.items[i].value = value;
            return;
        }
        try self.entries.insert(arena, self.insertionIndex(key), .{ .key = key, .value = value });
    }

    fn insertionIndex(self: *const Object, key: []const u8) usize {
        const index = arrayIndex(key) orelse return self.entries.items.len;
        for (self.entries.items, 0..) |entry, i| {
            const other = arrayIndex(entry.key) orelse return i;
            if (other > index) return i;
        }
        return self.entries.items.len;
    }

    /// `{...obj}`: a shallow copy with the same key order.
    pub fn clone(self: *const Object, arena: Allocator) Allocator.Error!*Object {
        const copy = try newObject(arena);
        try copy.entries.appendSlice(arena, self.entries.items);
        return copy;
    }
};

/// ECMAScript array index: canonical decimal uint32 below 2^32 - 1.
pub fn arrayIndex(key: []const u8) ?u32 {
    if (key.len == 0 or key.len > 10) return null;
    if (key.len > 1 and key[0] == '0') return null;
    var value: u64 = 0;
    for (key) |c| {
        if (c < '0' or c > '9') return null;
        value = value * 10 + (c - '0');
    }
    if (value >= std.math.maxInt(u32)) return null;
    return @intCast(value);
}

/// `a === b` over JSON-shaped values (objects/arrays compare by identity).
pub fn strictEqual(a: Value, b: Value) bool {
    return switch (a) {
        .undefined => b == .undefined,
        .null => b == .null,
        .bool => |x| b == .bool and b.bool == x,
        .number => |x| b == .number and b.number == x,
        .string => |x| b == .string and std.mem.eql(u8, x, b.string),
        .array => |x| b == .array and b.array == x,
        .object => |x| b == .object and b.object == x,
    };
}

pub fn isSafeInteger(value: f64) bool {
    return std.math.isFinite(value) and @floor(value) == value and @abs(value) <= 9007199254740991.0;
}

// ---------------------------------------------------------------- parsing

pub const ParseError = error{ InvalidJson, OutOfMemory };

/// `JSON.parse` (core.json does the JavaScript duplicate-key handling).
pub fn parse(arena: Allocator, text: []const u8) ParseError!Value {
    const value = core.json.parse(arena, text, .{}) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidJson,
    };
    return fromCore(arena, value);
}

/// Converts a `core.json.Value` (e.g. a database row) into a mutable value.
/// Strings are borrowed; `.raw` fragments are parsed.
pub fn fromCore(arena: Allocator, value: core.json.Value) ParseError!Value {
    return switch (value) {
        .null => .null,
        .bool => |b| .{ .bool = b },
        .number => |n| .{ .number = n },
        .string => |s| .{ .string = s },
        .raw => |text| parse(arena, text),
        .array => |items| blk: {
            const array = try newArray(arena, &.{});
            try array.ensureTotalCapacity(arena, items.len);
            for (items) |item| array.appendAssumeCapacity(try fromCore(arena, item));
            break :blk .{ .array = array };
        },
        .object => |members| blk: {
            const object = try newObject(arena);
            try object.entries.ensureTotalCapacity(arena, members.len);
            for (members) |member| try object.put(arena, member.key, try fromCore(arena, member.value));
            break :blk .{ .object = object };
        },
    };
}

/// Converts to `core.json.Value`, dropping `undefined` members (array holes
/// become null, as JSON.stringify prints them).
pub fn toCore(arena: Allocator, value: Value) Allocator.Error!core.json.Value {
    return switch (value) {
        .undefined, .null => .null,
        .bool => |b| .{ .bool = b },
        .number => |n| .{ .number = n },
        .string => |s| .{ .string = s },
        .array => |array| blk: {
            const items = try arena.alloc(core.json.Value, array.items.len);
            for (array.items, items) |item, *out| out.* = try toCore(arena, item);
            break :blk .{ .array = items };
        },
        .object => |object| blk: {
            var members: std.ArrayList(core.json.Member) = .empty;
            try members.ensureTotalCapacity(arena, object.entries.items.len);
            for (object.entries.items) |entry| {
                if (entry.value == .undefined) continue;
                members.appendAssumeCapacity(.{ .key = entry.key, .value = try toCore(arena, entry.value) });
            }
            break :blk .{ .object = members.items };
        },
    };
}

// ---------------------------------------------------------- serialization

pub fn stringifyAlloc(gpa: Allocator, value: Value) Allocator.Error![]u8 {
    var out: std.Io.Writer.Allocating = .init(gpa);
    errdefer out.deinit();
    stringify(&out.writer, value) catch return error.OutOfMemory;
    return out.toOwnedSlice();
}

/// `JSON.stringify(value)`; `undefined` members are skipped, array holes print null.
pub fn stringify(w: *std.Io.Writer, value: Value) std.Io.Writer.Error!void {
    switch (value) {
        .undefined, .null => try w.writeAll("null"),
        .bool => |b| try w.writeAll(if (b) "true" else "false"),
        .number => |n| try writeNumber(w, n),
        .string => |s| try writeString(w, s),
        .array => |array| {
            try w.writeByte('[');
            for (array.items, 0..) |item, i| {
                if (i > 0) try w.writeByte(',');
                try stringify(w, item);
            }
            try w.writeByte(']');
        },
        .object => |object| {
            try w.writeByte('{');
            var first = true;
            for (object.entries.items) |entry| {
                if (entry.value == .undefined) continue;
                if (!first) try w.writeByte(',');
                first = false;
                try writeString(w, entry.key);
                try w.writeByte(':');
                try stringify(w, entry.value);
            }
            try w.writeByte('}');
        },
    }
}

pub const writeNumber = core.json.writeNumber;
pub const writeString = core.json.writeString;

test "parse hoists array-index keys and keeps the first slot for duplicates" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const value = try parse(arena, "{\"b\":1,\"4294967294\":2,\"4294967295\":3,\"01\":4,\"1\":5,\"b\":6}");
    const text = try stringifyAlloc(arena, value);
    try std.testing.expectEqualStrings("{\"1\":5,\"4294967294\":2,\"b\":6,\"4294967295\":3,\"01\":4}", text);
}

test "numbers and strings print like JSON.stringify" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const value = try parse(arena, "[-0.0,1.0,1e21,1e-7,0.000001,1.5e300,123456789012345680000,\"a\\u0001\\n\\\"\\u2028\"]");
    try std.testing.expectEqualStrings(
        "[0,1,1e+21,1e-7,0.000001,1.5e+300,123456789012345680000,\"a\\u0001\\n\\\"\u{2028}\"]",
        try stringifyAlloc(arena, value),
    );
}

test "undefined keeps its slot but is omitted" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const object = try newObject(arena);
    try object.put(arena, "a", .{ .number = 1 });
    try object.put(arena, "retry", .undefined);
    try object.put(arena, "failure", .null);
    try object.put(arena, "retry", .{ .bool = true });
    try object.put(arena, "3", .{ .number = 3 });
    try std.testing.expectEqualStrings("{\"3\":3,\"a\":1,\"retry\":true,\"failure\":null}", try stringifyAlloc(arena, .{ .object = object }));
}
