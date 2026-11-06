//! Guarded native >8-stalled-peer checkpoint transport fixture, no signing/DB.
const std = @import("std");
const settings = @import("settings/root.zig");
const resources = @import("agents/chain_source.zig");
const votes = @import("agents/validator/chain_votes.zig");
const readers = @import("agents/validator/chain_checkpoint.zig");
const abi = @import("evm/codecs.zig");
const a = std.heap.smp_allocator;
const Fixture = struct { marker: []const u8, config_dir: []const u8, state_urls: []const []const u8, expected_root: []const []const u8, required: usize, expect_quorum: bool = true, timeout_ms: u32 = 20000, curl_library: []const u8 };
const Ready = struct {
    required: usize,
    fn callback(ctx: *anyopaque, results: []const votes.Result) bool {
        const self: *Ready = @ptrCast(@alignCast(ctx));
        for (results) |candidate| {
            if (!candidate.ready) continue;
            const value = candidate.value.?;
            const root = value.tree.root();
            var agreeing: usize = 0;
            var can_advance: usize = 0;
            for (results) |other| {
                if (!other.ready and other.failure == null) can_advance += 1;
                if (other.value) |v| {
                    if (v.tree.count == value.tree.count and std.mem.eql(u8, &v.tree.root(), &root)) agreeing += 1;
                    if (v.tree.count > value.tree.count) can_advance += 1;
                }
            }
            if (agreeing >= self.required and can_advance < self.required) return true;
        }
        return false;
    }
};
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
    const data = try std.fs.cwd().readFileAlloc(scratch, args[1], 1024 * 1024);
    const parsed = try std.json.parseFromSlice(Fixture, scratch, data, .{ .allocate = .alloc_always });
    const fixture = parsed.value;
    if (!std.mem.eql(u8, fixture.marker, "ziggy-public-chain-votes-v1") or fixture.state_urls.len > 256 or fixture.required == 0 or fixture.required > fixture.state_urls.len) return error.ExpectedPublicFixture;
    var configured = try settings.Settings.load(a, .validator, .{ .defaults_dir = fixture.config_dir });
    defer configured.deinit();
    const chain = configured.chainByName(configured.role.validator.origin_chain) orelse return error.MissingChain;
    if (chain.protocol != .tron and chain.protocol != .starknet) return error.ExpectedReadOnlyFixture;
    for (chain.rpc_urls) |url| try loopback(url);
    if (chain.protocol == .tron) {
        for (chain.connection.tron.wallet_urls) |url| try loopback(url);
        for (chain.connection.tron.wallet_solidity_urls) |url| try loopback(url);
    }
    const metrics = try @import("ops/metrics.zig").Registry.init(a, .validator, .{ .base_version = "3.0.0" });
    defer metrics.deinit();
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    const owned = try scratch.alloc(?*resources.Resources, fixture.state_urls.len);
    @memset(owned, null);
    defer for (owned) |maybe| if (maybe) |value| value.deinit();
    const slots = try scratch.alloc(votes.Slot, owned.len);
    for (fixture.state_urls, owned, slots) |url, *value, *slot| {
        try loopback(url);
        const urls = try scratch.alloc([]const u8, 1);
        urls[0] = url;
        value.* = try resources.Resources.open(a, chain, &env, .{ .curl_library = fixture.curl_library, .wallet_solidity_urls = if (chain.protocol == .tron) urls else null, .rpc_urls = if (chain.protocol == .starknet) urls else null, .request_timeout_ms = fixture.timeout_ms, .allow_insecure_loopback = true, .direct_native_transport = true, .metrics = metrics, .rpc_role = .quorum, .operation = .validator_checkpoint });
        slot.* = .{ .resources = value.*.?, .reader = try readers.Reader.fromResources(value.*.?) };
    }
    var ready: Ready = .{ .required = fixture.required };
    var timer = try std.time.Timer.start();
    const result = try votes.collect(a, slots, .{ .library_path = fixture.curl_library, .period = .none, .timeout_ms = fixture.timeout_ms }, &ready, Ready.callback);
    defer a.free(result);
    const elapsed = timer.read() / std.time.ns_per_ms;
    const root_text = try std.mem.join(scratch, "", fixture.expected_root);
    const expected = try abi.fixedHex(32, root_text);
    var accepted: usize = 0;
    for (result) |r| if (r.ready) {
        if (r.value.?.tree.count != 1 or !std.mem.eql(u8, &r.value.?.tree.root(), &expected)) return error.WrongCheckpointRoot;
        accepted += 1;
    };
    if (fixture.expect_quorum and accepted < fixture.required) return error.ExpectedQuorum;
    if (!fixture.expect_quorum and accepted != 0) return error.UnexpectedAcceptedVote;
    var mismatched_ids: usize = 0;
    var changed_fences: usize = 0;
    for (result) |r| if (r.failure) |err| {
        if (err == error.RpcIdMismatch) mismatched_ids += 1;
        if (err == error.CheckpointReadReorg) changed_fences += 1;
    };
    const exposition = try metrics.render(scratch);
    var requests: u64 = 0;
    var metric_lines = std.mem.tokenizeScalar(u8, exposition, '\n');
    while (metric_lines.next()) |line| if (std.mem.startsWith(u8, line, "hyperlane_request_count{")) {
        const space = std.mem.lastIndexOfScalar(u8, line, ' ') orelse return error.InvalidMetricOutput;
        requests += try std.fmt.parseInt(u64, line[space + 1 ..], 10);
    };
    const output = try std.json.Stringify.valueAlloc(scratch, .{ .passed = true, .physical_rpc_completions = requests, .configured_slots = slots.len, .required = fixture.required, .ready = accepted, .unavailable = slots.len - accepted, .elapsed_ms = elapsed, .rpc_timeout_ms = fixture.timeout_ms, .mismatched_ids = mismatched_ids, .changed_fences = changed_fences }, .{});
    try std.fs.File.stdout().writeAll(output);
    try std.fs.File.stdout().writeAll("\n");
}
