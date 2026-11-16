//! Diagnostics only: `HYPERLANE_DB_SYNC_STATS=<file>` attributes every RocksDB
//! write to its Zig call stack (frame-pointer walk from the commit) and, when
//! the database closes, appends one JSON line per site: write count, synced
//! count and the symbolized frames. Off (one relaxed load per write) unless
//! the variable is set when the first database opens.
const std = @import("std");
const builtin = @import("builtin");

const depth = 8;
const capacity = 512;
const Site = struct { frames: [depth]usize, writes: u64 = 0, synced: u64 = 0, wal_syncs: u64 = 0 };

var state: enum(u8) { unknown, off, on } = .unknown;
var mutex: std.Thread.Mutex = .{};
var sites: [capacity]Site = undefined;
var used: usize = 0;
var dropped: u64 = 0;
var path_buffer: [std.fs.max_path_bytes]u8 = undefined;
var path: []const u8 = "";

/// Database.open: decide once per process.
pub fn configure() void {
    if (builtin.is_test) return;
    mutex.lock();
    defer mutex.unlock();
    if (state != .unknown) return;
    state = .off;
    if (builtin.os.tag == .windows) return;
    const value = std.posix.getenv("HYPERLANE_DB_SYNC_STATS") orelse return;
    if (value.len == 0 or value.len > path_buffer.len) return;
    @memcpy(path_buffer[0..value.len], value);
    path = path_buffer[0..value.len];
    state = .on;
}

pub const Kind = enum { write, synced_write, wal_sync };

/// `first` is the commit function's return address (its caller's frame).
pub fn record(kind: Kind, first: usize) void {
    if (@atomicLoad(@TypeOf(state), &state, .monotonic) != .on) return;
    var frames: [depth]usize = @splat(0);
    var iterator = std.debug.StackIterator.init(first, null);
    defer iterator.deinit();
    var count: usize = 0;
    while (count < depth) : (count += 1) frames[count] = iterator.next() orelse break;
    mutex.lock();
    defer mutex.unlock();
    const site = for (sites[0..used]) |*site| {
        if (std.mem.eql(usize, &site.frames, &frames)) break site;
    } else blk: {
        if (used == capacity) {
            dropped += 1;
            return;
        }
        sites[used] = .{ .frames = frames };
        used += 1;
        break :blk &sites[used - 1];
    };
    switch (kind) {
        .write => site.writes += 1,
        .synced_write => {
            site.writes += 1;
            site.synced += 1;
        },
        .wal_sync => site.wal_syncs += 1,
    }
}

/// Database.deinit: append the per-site lines (best effort) and reset.
pub fn dump() void {
    if (@atomicLoad(@TypeOf(state), &state, .monotonic) != .on) return;
    mutex.lock();
    defer mutex.unlock();
    if (used == 0) return;
    const file = std.fs.cwd().createFile(path, .{ .truncate = false }) catch return;
    defer file.close();
    file.seekFromEnd(0) catch return;
    var buffer: [4096]u8 = undefined;
    var file_writer = file.writer(&buffer);
    const out = &file_writer.interface;
    const info = std.debug.getSelfDebugInfo() catch null;
    for (sites[0..used]) |*site| {
        out.print("{{\"writes\":{d},\"synced\":{d},\"wal_syncs\":{d},\"frames\":[", .{ site.writes, site.synced, site.wal_syncs }) catch return;
        for (site.frames, 0..) |address, i| {
            if (address == 0) break;
            if (i != 0) out.writeAll(",") catch return;
            out.writeAll("\"") catch return;
            symbol(info, out, address);
            out.writeAll("\"") catch return;
        }
        out.writeAll("]}\n") catch return;
    }
    if (dropped != 0) out.print("{{\"dropped\":{d}}}\n", .{dropped}) catch return;
    out.flush() catch return;
    used = 0;
    dropped = 0;
}

fn symbol(info: ?*std.debug.SelfInfo, out: *std.Io.Writer, address: usize) void {
    const self_info = info orelse return out.print("0x{x}", .{address}) catch {};
    const module = self_info.getModuleForAddress(address) catch return out.print("0x{x}", .{address}) catch {};
    const value = module.getSymbolAtAddress(self_info.allocator, address) catch return out.print("0x{x}", .{address}) catch {};
    defer if (value.source_location) |location| self_info.allocator.free(location.file_name);
    if (value.source_location) |location| {
        out.print("{s} {s}:{d}", .{ value.name, std.fs.path.basename(location.file_name), location.line }) catch {};
    } else out.print("{s} 0x{x}", .{ value.name, address }) catch {};
}
