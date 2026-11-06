//! Explicit credential filesystem boundary. No environment or home discovery.
const std = @import("std");
const A = std.mem.Allocator;
pub const Reader = struct {
    context: ?*anyopaque = null,
    read_fn: *const fn (?*anyopaque, A, []const u8, usize) anyerror!?[]u8 = readFile,
    pub fn read(self: Reader, a: A, path: []const u8, maximum: usize) !?[]u8 {
        const bytes = try self.read_fn(self.context, a, path, maximum);
        if (bytes) |wire| if (wire.len > maximum) {
            std.crypto.secureZero(u8, wire);
            a.free(wire);
            return error.CredentialFileTooLarge;
        };
        return bytes;
    }
};
fn validPath(path: []const u8) !void {
    if (path.len == 0 or path.len > 4096 or std.mem.indexOfScalar(u8, path, 0) != null) return error.InvalidCredentialPath;
}
fn readFile(_: ?*anyopaque, a: A, path: []const u8, maximum: usize) !?[]u8 {
    try validPath(path);
    return std.fs.cwd().readFileAlloc(a, path, maximum) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
}
pub const Writer = struct {
    context: ?*anyopaque = null,
    write_fn: *const fn (?*anyopaque, A, []const u8, []const u8) anyerror!void = writeFile,
    pub fn write(self: Writer, a: A, path: []const u8, bytes: []const u8) !void {
        if (bytes.len > 64 * 1024) return error.CredentialFileTooLarge;
        return self.write_fn(self.context, a, path, bytes);
    }
};
fn writeFile(_: ?*anyopaque, _: A, path: []const u8, bytes: []const u8) !void {
    try validPath(path);
    const parent = std.fs.path.dirname(path) orelse ".";
    var dir = try std.fs.cwd().openDir(parent, .{ .iterate = true });
    defer dir.close();
    const basename = std.fs.path.basename(path);
    if (basename.len == 0 or std.mem.eql(u8, basename, ".") or std.mem.eql(u8, basename, "..")) return error.InvalidCredentialPath;
    var random: [16]u8 = undefined;
    std.crypto.random.bytes(&random);
    var name: [64]u8 = undefined;
    const temporary = try std.fmt.bufPrint(&name, ".zig-credentials-{s}.tmp", .{std.fmt.bytesToHex(random, .lower)});
    var file = try dir.createFile(temporary, .{ .exclusive = true, .mode = 0o600 });
    defer file.close();
    errdefer dir.deleteFile(temporary) catch {};
    try file.writeAll(bytes);
    try file.sync();
    try dir.rename(temporary, basename);
    try std.posix.fsync(dir.fd);
}
test "credential cache writes atomic private files and refuses missing parents" {
    const a = std.testing.allocator;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const base = try temporary.dir.realpathAlloc(a, ".");
    defer a.free(base);
    const path = try std.fs.path.join(a, &.{ base, "cache.json" });
    defer a.free(path);
    const writer: Writer = .{};
    try writer.write(a, path, "public fixture");
    const reader: Reader = .{};
    const bytes = (try reader.read(a, path, 64)).?;
    defer a.free(bytes);
    try std.testing.expectEqualStrings("public fixture", bytes);
    const stat = try temporary.dir.statFile("cache.json");
    try std.testing.expectEqual(@as(u32, 0o600), stat.mode & 0o777);
    try writer.write(a, path, "replacement");
    const missing = try std.fs.path.join(a, &.{ base, "missing", "cache.json" });
    defer a.free(missing);
    try std.testing.expectError(error.FileNotFound, writer.write(a, missing, "no creation"));
}
