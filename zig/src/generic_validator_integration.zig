//! Disposable local-chain validator role integration, public test key only.
const std = @import("std");
const settings = @import("settings/root.zig");
const factory = @import("agents/validator/config.zig");
const generic = @import("agents/validator/generic.zig");
const validator = @import("agents/validator.zig");
const rocks = @import("db/rocks.zig");
const cloud = @import("cloud/root.zig");
const Curl = @import("net/curl.zig");
const a = std.heap.smp_allocator;
comptime {
    _ = @import("db/bzip2_glue.zig");
}
const Fixture = struct { marker: []const u8, config_dir: []const u8, db_path: []const u8, curl_library: []const u8, steps: usize = 6, rpc_timeout_ms: u32 = 1000, expect_halt: bool = false, allow_retries: bool = false };
const Owner = struct {
    data: ?[]u8 = null,
    fn submit(ctx: *anyopaque, signed: @import("storage/objects.zig").SignedAnnouncement) !void {
        const data = try signed.toJson(a);
        defer a.free(data);
        const self: *Owner = @ptrCast(@alignCast(ctx));
        if (self.data) |old| a.free(old);
        self.data = try a.dupe(u8, data);
    }
};
const Tracked = struct {
    base: validator.Signer,
    checkpoints: usize = 0,
    fn sign(ctx: *anyopaque, c: validator.Checkpoint) !@import("storage/objects.zig").SignedCheckpoint {
        const self: *Tracked = @ptrCast(@alignCast(ctx));
        self.checkpoints += 1;
        return self.base.sign(self.base.context, c);
    }
    fn digest(ctx: *anyopaque, h: [32]u8) ![65]u8 {
        const self: *Tracked = @ptrCast(@alignCast(ctx));
        return self.base.digest(h);
    }
    fn interface(self: *Tracked) validator.Signer {
        return .{ .context = self, .sign = sign, .sign_digest = digest };
    }
};
fn chunks(bytes: []const u8) ![]const []const u8 {
    const hex = try @import("evm/codecs.zig").hexAlloc(a, bytes);
    const out = try a.alloc([]const u8, (hex.len + 31) / 32);
    for (out, 0..) |*part, i| part.* = hex[i * 32 .. @min(hex.len, i * 32 + 32)];
    return out;
}
pub fn main() !void {
    const args = try std.process.argsAlloc(a);
    defer std.process.argsFree(a, args);
    if (args.len != 2) return error.ExpectedPublicFixture;
    const bytes = try std.fs.cwd().readFileAlloc(a, args[1], 1024 * 1024);
    defer a.free(bytes);
    const parsed = try std.json.parseFromSlice(Fixture, a, bytes, .{ .allocate = .alloc_always });
    defer parsed.deinit();
    const f = parsed.value;
    if (!std.mem.eql(u8, f.marker, "ziggy-public-generic-validator-integration-v1") or f.steps > 32) return error.ExpectedPublicFixture;
    var s = try settings.Settings.load(a, .validator, .{ .defaults_dir = f.config_dir });
    defer s.deinit();
    if (s.role.validator.signer != .hex_key or !std.mem.allEqual(u8, &s.role.validator.signer.hex_key, 0x11)) return error.ExpectedPublicFixture;
    for (s.chains[0].rpc_urls) |url| {
        const uri = try std.Uri.parse(url);
        var buf: [std.Uri.host_name_max]u8 = undefined;
        const host = try uri.getHost(&buf);
        if (!std.mem.eql(u8, host, "127.0.0.1") and !std.mem.eql(u8, host, "::1")) return error.ExpectedLoopbackFixture;
    }
    var native = try Curl.Client.init(a, f.curl_library);
    defer native.deinit();
    var http = cloud.http.HttpTransport.init(a);
    defer http.deinit();
    http.native_curl = &native;
    http.allow_insecure_loopback = true;
    const resources = try factory.Resources.open(a, &s, .{ .transport = http.interface(), .amz_date = "20261105T120000Z" });
    defer resources.deinit();
    var tracked: Tracked = .{ .base = resources.signer() };
    var owner: Owner = .{};
    defer if (owner.data) |data| a.free(data);
    var db = try rocks.Database.open(a, f.db_path, .{});
    defer db.deinit();
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const role = try generic.Role.open(a, &s, &environment, &db, .{ .clients = .{ .curl_library = f.curl_library, .request_timeout_ms = f.rpc_timeout_ms, .allow_insecure_loopback = true }, .signer = tracked.interface(), .signer_address = resources.signer_address, .publisher = resources.publisher(), .storage_location = resources.storage_location, .announcer = .{ .context = &owner, .submit = Owner.submit } });
    defer role.deinit();
    var published: usize = 0;
    var unavailable: usize = 0;
    var pending = false;
    var repaired: usize = 0;
    var recoveries: usize = 0;
    var halted = false;
    for (0..f.steps) |i| {
        const tick = role.tick(1234567890 + i, 1000 + i * 2000) catch |err| {
            if (f.expect_halt and role.state.halted) {
                halted = true;
                break;
            }
            if (f.allow_retries and !role.state.halted) continue;
            return err;
        };
        pending = tick.announcement_pending;
        if (tick.progress) |p| {
            published += p.published;
            unavailable = @max(unavailable, p.unavailable_endpoints);
            repaired += p.history_repaired;
            recoveries += @intFromBool(p.recovery_reset);
        }
    }
    if (f.expect_halt and !halted) return error.ExpectedDurableHalt;
    const VoteDiagnostic = struct { ready: bool, failure: ?[]const u8, count: ?u32 };
    const vote_diag = try a.alloc(VoteDiagnostic, if (role.round) |r| r.len else 0);
    defer a.free(vote_diag);
    if (role.round) |results| for (results, 0..) |r, i| {
        vote_diag[i] = .{ .ready = r.ready, .failure = if (r.failure) |err| @errorName(err) else null, .count = if (r.value) |v| v.tree.count else null };
    };
    const output = try std.json.Stringify.valueAlloc(a, .{ .passed = true, .vote_diagnostics = vote_diag, .fresh_verified = role.state.fresh_verified_through, .halted = halted, .announcement_pending = pending, .announcement_calldata = if (owner.data) |data| try chunks(data) else &[_][]const u8{}, .tree_count = role.state.tree.count, .latest = role.state.latest_published, .snapshot_through = role.state.snapshot_through, .repair_complete = role.state.repair_complete, .history_repaired = repaired, .recoveries = recoveries, .bootstrap_index = role.state.bootstrap_index, .checkpoint_signatures = tracked.checkpoints, .published = published, .configured_slots = role.state.options.endpoint_count, .unavailable = unavailable }, .{});
    defer a.free(output);
    try std.fs.File.stdout().writeAll(output);
    try std.fs.File.stdout().writeAll("\n");
}
