//! Guarded public-fixture executable for the actual two-descriptor validator.
const std = @import("std");
const settings = @import("settings/root.zig");
const Task = @import("agents/validator_task.zig").Task;
const scheduler = @import("runtime/supervisor.zig");
const a = std.heap.smp_allocator;
comptime {
    _ = @import("db/bzip2_glue.zig");
}
const Fixture = struct { marker: []const u8, config_dir: []const u8, db_path: []const u8, curl_library: []const u8, url_library: []const u8, run_ms: u64 = 10000 };
fn loopback(url: []const u8) !void {
    const uri = try std.Uri.parse(url);
    var buffer: [std.Uri.host_name_max]u8 = undefined;
    const host = try uri.getHost(&buffer);
    if (!std.mem.eql(u8, host, "127.0.0.1") and !std.mem.eql(u8, host, "::1")) return error.ExpectedLoopbackFixture;
}
pub fn main() !void {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const scratch = arena.allocator();
    const args = try std.process.argsAlloc(scratch);
    if (args.len != 2) return error.ExpectedPublicFixture;
    const parsed = try std.json.parseFromSlice(Fixture, scratch, try std.fs.cwd().readFileAlloc(scratch, args[1], 1024 * 1024), .{});
    const fixture = parsed.value;
    if (!std.mem.eql(u8, fixture.marker, "ziggy-public-validator-tasks-v1") or fixture.run_ms == 0 or fixture.run_ms > 60000) return error.ExpectedPublicFixture;
    var configured = try settings.Settings.load(a, .validator, .{ .defaults_dir = fixture.config_dir });
    defer configured.deinit();
    if (configured.role.validator.signer != .hex_key or !std.mem.allEqual(u8, &configured.role.validator.signer.hex_key, 0x11)) return error.ExpectedPublicFixture;
    configured.role.validator.db = fixture.db_path;
    const chain = &configured.chains[0];
    if (chain.protocol != .tron) return error.ExpectedTronFixture;
    for (chain.rpc_urls) |url| try loopback(url);
    for (chain.connection.tron.wallet_urls) |url| try loopback(url);
    for (chain.connection.tron.wallet_solidity_urls) |url| try loopback(url);
    const task = try Task.init(a, &configured, .{ .curl_library = fixture.curl_library, .url_library = fixture.url_library, .request_timeout_ms = 20000, .allow_insecure_loopback = true }, null, null);
    defer task.deinit();
    if (task.database_owner.value != null or task.native != null or task.announcement.native != null or task.metadata_url != null) return error.ConstructorPerformedIo;
    const descriptors = task.descriptors();
    const owner = try scheduler.Supervisor.start(a, &descriptors);
    defer owner.deinit();
    var timer = try std.time.Timer.start();
    while (timer.read() / std.time.ns_per_ms < fixture.run_ms) {
        const now = std.time.milliTimestamp();
        if (now < 0) return error.InvalidClock;
        _ = try owner.tick(.{ .unix_ms = @intCast(now), .monotonic_ms = timer.read() / std.time.ns_per_ms });
        if (owner.failureReason()) |err| return err;
        std.Thread.sleep(10 * std.time.ns_per_ms);
    }
    owner.stop();
    const stop_at = timer.read();
    while (!owner.drained()) {
        std.Thread.sleep(10 * std.time.ns_per_ms);
    }
    const shutdown_ms = (timer.read() - stop_at) / std.time.ns_per_ms;
    const output = try std.json.Stringify.valueAlloc(scratch, .{ .passed = true, .checkpoint = try owner.health(0), .announcement = try owner.health(1), .shutdown_ms = shutdown_ms }, .{});
    try std.fs.File.stdout().writeAll(output);
    try std.fs.File.stdout().writeAll("\n");
}
