const std = @import("std");
pub const V = std.json.Value;
pub const View = struct {
    value: V,
    pub fn get(self: View, key: []const u8) ?View {
        if (self.value != .object) return null;
        const v = self.value.object.get(key) orelse return null;
        return .{ .value = v };
    }
    pub fn need(self: View, key: []const u8) !View {
        return self.get(key) orelse error.MissingConfiguration;
    }
    pub fn text(self: View) ![]const u8 {
        return if (self.value == .string) self.value.string else error.InvalidConfigString;
    }
    pub fn str(self: View, key: []const u8, default: []const u8) ![]const u8 {
        return if (self.get(key)) |v| v.text() else default;
    }
    pub fn optional(self: View, key: []const u8) !?[]const u8 {
        return if (self.get(key)) |v| try v.text() else null;
    }
    pub fn int(self: View, comptime T: type) !T {
        return switch (self.value) {
            .integer => |v| std.math.cast(T, v) orelse error.InvalidConfigInteger,
            .string => |v| decimalInt(T, v),
            .number_string => |v| std.fmt.parseInt(T, v, 10) catch error.InvalidConfigInteger,
            else => error.InvalidConfigInteger,
        };
    }
    pub fn num(self: View, comptime T: type, key: []const u8, default: T) !T {
        return if (self.get(key)) |v| v.int(T) else default;
    }
    pub fn optNum(self: View, comptime T: type, key: []const u8) !?T {
        return if (self.get(key)) |v| try v.int(T) else null;
    }
    pub fn boolean(self: View) !bool {
        return switch (self.value) {
            .bool => |b| b,
            .string => |s| if (std.ascii.eqlIgnoreCase(s, "true")) true else if (std.ascii.eqlIgnoreCase(s, "false")) false else error.InvalidConfigBoolean,
            else => error.InvalidConfigBoolean,
        };
    }
    pub fn flag(self: View, key: []const u8, default: bool) !bool {
        return if (self.get(key)) |v| v.boolean() else default;
    }
    pub fn float(self: View) !f64 {
        const n: f64 = switch (self.value) {
            .float => |v| v,
            .integer => |v| @floatFromInt(v),
            .string, .number_string => |v| std.fmt.parseFloat(f64, v) catch return error.InvalidConfigFloat,
            else => return error.InvalidConfigFloat,
        };
        if (!std.math.isFinite(n)) return error.InvalidConfigFloat;
        return n;
    }
    pub fn decimal(self: View, key: []const u8, default: f64) !f64 {
        return if (self.get(key)) |v| v.float() else default;
    }
    pub fn array(self: View, a: std.mem.Allocator) ![]const V {
        if (self.value == .array) return self.value.array.items;
        if (self.value != .object) return error.InvalidConfigArray;
        const result = try a.alloc(V, self.value.object.count());
        for (result, 0..) |*slot, i| {
            const key = try std.fmt.allocPrint(a, "{d}", .{i});
            slot.* = self.value.object.get(key) orelse return error.InvalidConfigArray;
        }
        return result;
    }
};
pub fn csv(a: std.mem.Allocator, text: []const u8) ![]const []const u8 {
    var list: std.array_list.Managed([]const u8) = .init(a);
    var parts = std.mem.splitScalar(u8, text, ',');
    while (parts.next()) |p| try list.append(p);
    return list.toOwnedSlice();
}

pub fn decimalInt(comptime T: type, text: []const u8) !T {
    if (text.len == 0) return error.InvalidConfigInteger;
    const start: usize = if (text[0] == '+' or text[0] == '-') 1 else 0;
    if (start == text.len) return error.InvalidConfigInteger;
    for (text[start..]) |c| {
        if (c < '0' or c > '9') return error.InvalidConfigInteger;
    }
    return std.fmt.parseInt(T, text, 10) catch error.InvalidConfigInteger;
}
