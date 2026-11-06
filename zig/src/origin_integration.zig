//! Native RocksDB origin service fixture, actual local Solidity logs only.
const std = @import("std");
const origin = @import("agents/origin_tasks.zig");
const supervisor = @import("runtime/supervisor.zig");
const rpc = @import("evm/provider.zig");
const abi = @import("evm/codecs.zig");
const protocol = @import("protocol/root.zig");
const settings = @import("settings/root.zig");
const engine = @import("relayer/remote_checkpoints.zig");
const Curl = @import("net/curl.zig");
comptime {
    _ = @import("db/bzip2_glue.zig");
}
const Config = struct { rpc_url: []const u8, origin_domain: u32, origin_mailbox: []const u8, origin_hook: []const u8, state_dir: []const u8, messages: []const []const u8, curl_library: []const u8 };
pub fn main() !void {
    const a = std.heap.smp_allocator;
    const args = try std.process.argsAlloc(a);
    defer std.process.argsFree(a, args);
    if (args.len != 2) return error.ExpectedLoopbackFixture;
    const bytes = try std.fs.cwd().readFileAlloc(a, args[1], 1024 * 1024);
    defer a.free(bytes);
    var parsed = try std.json.parseFromSlice(Config, a, bytes, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const config = parsed.value;
    if (!std.mem.startsWith(u8, config.rpc_url, "http://127.0.0.1:") or config.messages.len > 1024) return error.ExpectedLoopbackFixture;
    var native = try Curl.Client.init(a, config.curl_library);
    defer native.deinit();
    var client = try rpc.RpcClient.init(a, config.rpc_url, .{ .native_transport = &native });
    defer client.deinit();
    const owner = try engine.Engine.start(a, .{ .multi = .{ .library_path = config.curl_library } });
    defer owner.deinit();
    const path = try std.fs.path.join(a, &.{ config.state_dir, "origin-db" });
    defer a.free(path);
    const database = try origin.DatabaseOwner.init(a, path);
    defer database.deinit();
    const wire = try std.json.Stringify.valueAlloc(a, .{ .relayChains = "fixture", .db = path, .chains = .{ .fixture = .{ .name = "fixture", .protocol = "ethereum", .chainId = 31337, .domainId = config.origin_domain, .rpcUrls = .{.{ .http = config.rpc_url }}, .mailbox = config.origin_mailbox, .merkleTreeHook = config.origin_hook, .validatorAnnounce = config.origin_mailbox, .interchainGasPaymaster = config.origin_mailbox, .blocks = .{ .reorgPeriod = 0 }, .index = .{ .from = 0, .chunk = 1999, .interval = 1 } } } }, .{});
    defer a.free(wire);
    const config_path = try std.fs.path.join(a, &.{ config.state_dir, "origin-settings.json" });
    defer a.free(config_path);
    try std.fs.cwd().writeFile(.{ .sub_path = config_path, .data = wire });
    var loaded = try settings.Settings.fromConfig(try @import("config.zig").Config.load(a, .{ .defaults = &.{config_path} }), .relayer);
    defer loaded.deinit();
    const chain = &loaded.chains[0];
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const sources = try origin.Set.open(a, loaded.chains, &environment, database, owner, .{ .source = .{ .curl_library = config.curl_library, .allow_insecure_loopback = true }, .gas_enabled = false });
    defer sources.deinit();
    const schedule = try supervisor.Supervisor.start(a, sources.descriptors());
    defer schedule.deinit();
    var timer = try std.time.Timer.start();
    const service = ready: while (timer.read() < 30 * std.time.ns_per_s) {
        _ = try schedule.tick(.{ .unix_ms = @intCast(std.time.milliTimestamp()), .monotonic_ms = timer.read() / std.time.ns_per_ms });
        if ((try schedule.health(0)).last_error) |err| return err;
        if (sources.slots[0].handle()) |handle| {
            if (try handle.history.highestKnownLeafIndex()) |highest| {
                if (highest + 1 == config.messages.len) {
                    var all = true;
                    for (0..config.messages.len) |nonce| {
                        var message = try handle.store.messageByNonce(@intCast(nonce));
                        defer if (message) |*value| value.deinit();
                        all = all and message != null;
                    }
                    if (all) break :ready handle;
                }
            }
        }
        std.Thread.sleep(std.time.ns_per_ms);
    } else return error.OriginWorkerDidNotCatchUp;
    schedule.stop();
    while (!schedule.drained()) std.Thread.sleep(std.time.ns_per_ms);
    const onchain = try client.latestCheckpoint(chain.contracts.merkle_tree_hook[12..].*, .latest);
    var tree = protocol.IncrementalMerkle.init();
    for (config.messages, 0..) |text, i| {
        const raw = try a.alloc(u8, (text.len - 2) / 2);
        defer a.free(raw);
        _ = try abi.decodeHex(raw, text);
        const message = try protocol.Message.decode(raw);
        var stored = (try service.store.messageByNonce(message.nonce)) orelse return error.MissingIndexedMessage;
        defer stored.deinit();
        if (!std.mem.eql(u8, &message.id(), &stored.value.id())) return error.WrongIndexedMessage;
        try tree.ingest(message.id());
        const insertion = (try service.store.insertionByIndex(@intCast(i))) orelse return error.MissingIndexedInsertion;
        if (!std.mem.eql(u8, &message.id(), &insertion.message_id)) return error.WrongIndexedInsertion;
    }
    if (!std.mem.eql(u8, &tree.root(), &onchain.root)) return error.WrongIndexedTree;
    const last = (try service.store.insertionByIndex(onchain.index)).?;
    const checkpoint: protocol.Checkpoint = .{ .mailbox_domain = config.origin_domain, .merkle_tree_hook_address = chain.contracts.merkle_tree_hook, .index = onchain.index, .root = onchain.root, .message_id = last.message_id };
    for (0..config.messages.len) |i| {
        const proof = try service.history.proof(@intCast(i), checkpoint);
        if (!proof.verify(checkpoint.root)) return error.WrongNativeProof;
    }
    const output = try std.json.Stringify.valueAlloc(a, .{ .messages = config.messages.len, .scheduled_worker_cycles = (try schedule.health(0)).completed, .native_rocksdb = true, .historical_proofs = config.messages.len, .passed = true }, .{});
    defer a.free(output);
    try std.fs.File.stdout().writeAll(output);
    try std.fs.File.stdout().writeAll("\n");
}
