//! Hand-ordered JSON frame writing with `JSON.stringify` bytes (field order
//! follows the TS object literals; `undefined` fields are simply not written).
const std = @import("std");
const core = @import("core");
const json = core.json;
const Writer = std.Io.Writer;

pub const Object = struct {
    w: *Writer,
    first: bool = true,

    pub fn begin(w: *Writer) Writer.Error!Object {
        try w.writeByte('{');
        return .{ .w = w };
    }

    pub fn end(self: *Object) Writer.Error!void {
        try self.w.writeByte('}');
    }

    pub fn key(self: *Object, name: []const u8) Writer.Error!void {
        if (!self.first) try self.w.writeByte(',');
        self.first = false;
        try json.writeString(self.w, name);
        try self.w.writeByte(':');
    }

    pub fn string(self: *Object, name: []const u8, value: []const u8) Writer.Error!void {
        try self.key(name);
        try json.writeString(self.w, value);
    }

    pub fn optString(self: *Object, name: []const u8, value: ?[]const u8) Writer.Error!void {
        if (value) |text| try self.string(name, text);
    }

    /// An integer JS number (safe range), e.g. a domain or confirmations.
    pub fn int(self: *Object, name: []const u8, value: anytype) Writer.Error!void {
        try self.key(name);
        try self.w.print("{d}", .{value});
    }

    /// A bigint rendered as a decimal string (`String(bigint)`).
    pub fn bigString(self: *Object, name: []const u8, value: i128) Writer.Error!void {
        try self.key(name);
        try self.w.print("\"{d}\"", .{value});
    }

    pub fn optBigString(self: *Object, name: []const u8, value: ?i128) Writer.Error!void {
        if (value) |v| try self.bigString(name, v);
    }

    pub fn boolean(self: *Object, name: []const u8, value: bool) Writer.Error!void {
        try self.key(name);
        try self.w.writeAll(if (value) "true" else "false");
    }

    pub fn val(self: *Object, name: []const u8, v: json.Value) Writer.Error!void {
        try self.key(name);
        try json.stringify(self.w, v);
    }

    pub fn raw(self: *Object, name: []const u8, text: []const u8) Writer.Error!void {
        try self.key(name);
        try self.w.writeAll(text);
    }

    pub fn ints(self: *Object, name: []const u8, values: []const u32) Writer.Error!void {
        try self.key(name);
        try writeInts(self.w, values);
    }

    pub fn strings(self: *Object, name: []const u8, values: []const []const u8) Writer.Error!void {
        try self.key(name);
        try writeStrings(self.w, values);
    }
};

pub fn writeInts(w: *Writer, values: []const u32) Writer.Error!void {
    try w.writeByte('[');
    for (values, 0..) |item, index| {
        if (index > 0) try w.writeByte(',');
        try w.print("{d}", .{item});
    }
    try w.writeByte(']');
}

pub fn writeStrings(w: *Writer, values: []const []const u8) Writer.Error!void {
    try w.writeByte('[');
    for (values, 0..) |item, index| {
        if (index > 0) try w.writeByte(',');
        try json.writeString(w, item);
    }
    try w.writeByte(']');
}

/// Serialize with `build(ctx, *Object)` into an allocated slice.
pub fn alloc(allocator: std.mem.Allocator, ctx: anytype, comptime build: fn (@TypeOf(ctx), *Object) Writer.Error!void) std.mem.Allocator.Error![]u8 {
    var out: Writer.Allocating = .init(allocator);
    errdefer out.deinit();
    var object = Object.begin(&out.writer) catch return error.OutOfMemory;
    build(ctx, &object) catch return error.OutOfMemory;
    object.end() catch return error.OutOfMemory;
    return out.toOwnedSlice();
}
