//! Real native KMS adapter/concurrent durable publication; public fixtures only.
const std = @import("std");
const settings = @import("settings/root.zig");
const factory = @import("agents/validator/config.zig");
const service = @import("agents/validator.zig");
const rocks = @import("db/rocks.zig");
const cloud = @import("cloud/root.zig");
const curl = @import("net/curl.zig");
const protocol = @import("protocol/root.zig");
comptime {
    _ = @import("db/bzip2_glue.zig");
}
const Fixture = struct { marker: []const u8, config_path: []const u8, db_path: []const u8, kms_endpoint: []const u8, curl_library: []const u8 };
pub fn main() !void {
    const a = std.heap.smp_allocator;
    const args = try std.process.argsAlloc(a);
    defer std.process.argsFree(a, args);
    if (args.len != 2) return error.ExpectedPublicFixture;
    const bytes = try std.fs.cwd().readFileAlloc(a, args[1], 1024 * 1024);
    defer a.free(bytes);
    var parsed = try std.json.parseFromSlice(Fixture, a, bytes, .{});
    defer parsed.deinit();
    const f = parsed.value;
    if (!std.mem.eql(u8, f.marker, "ziggy-public-validator-concurrency-v1") or !std.mem.startsWith(u8, f.kms_endpoint, "http://127.0.0.1:") or std.mem.indexOf(u8, f.db_path, "ziggy-public-validator-concurrency-") == null) return error.ExpectedPublicFixture;
    var configured = try settings.Settings.fromConfig(try @import("config.zig").Config.load(a, .{ .defaults = &.{f.config_path} }), .validator);
    defer configured.deinit();
    var native = try curl.Client.init(a, f.curl_library);
    defer native.deinit();
    var http = cloud.http.HttpTransport.init(a);
    defer http.deinit();
    http.native_curl = &native;
    http.allow_insecure_loopback = true;
    var cancel: std.atomic.Value(bool) = .init(false);
    http.cancel = &cancel;
    const resources = try factory.Resources.open(a, &configured, .{ .transport = http.interface(), .http_owner = &http, .aws = .{ .access_key_id = "PUBLICFIXTURE", .secret_access_key = "public-fixture" }, .amz_date = "20261105T120000Z", .kms_endpoint = f.kms_endpoint });
    defer resources.deinit();
    if (!resources.signer().parallel_safe or !resources.publisher().parallel_safe) return error.NativeParallelCapabilityNotEnabled;
    var database = try rocks.Database.open(a, f.db_path, .{});
    defer database.deinit();
    const chain = &configured.chains[0];
    const options: service.Options = .{ .domain_name = chain.name, .domain = chain.domain, .hook = chain.contracts.merkle_tree_hook, .signer_address = resources.signer_address, .endpoint_count = 1, .consensus = null };
    var state = try service.Service.open(a, &database, options);
    defer state.deinit();
    const messages = try a.alloc([]u8, 8);
    defer {
        for (messages) |message| a.free(message);
        a.free(messages);
    }
    for (messages, 0..) |*wire, index| {
        const message: protocol.Message = .{ .version = 3, .nonce = @intCast(index), .origin = chain.domain, .destination = 2000, .sender = @splat(2), .recipient = @splat(3), .body = "public parallel fixture" };
        const encoded = try message.encodeAlloc(a);
        defer a.free(encoded);
        wire.* = try @import("evm/codecs.zig").hexAlloc(a, encoded);
        try state.observe(@intCast(index), .{ .message_id = message.id(), .block_height = 1, .block_hash = @splat(1) }, 1);
    }
    _ = try state.authorize(&.{try state.checkpoint(7)}, 123);
    var published: usize = 0;
    for (0..2) |_| published += try state.publishConcurrent(resources.signer(), resources.publisher(), 123, 4);
    if (published != 8 or state.snapshot_through != 7) return error.IncompleteParallelPublication;
    state.deinit();
    database.deinit();
    database = try rocks.Database.open(a, f.db_path, .{});
    state = try service.Service.open(a, &database, options);
    const replayed = try state.publishConcurrent(resources.signer(), resources.publisher(), 124, 4);
    if (replayed != 0 or state.fresh_verified_through != null) return error.RestartSignedAgain;
    const text = try std.json.Stringify.valueAlloc(a, .{ .passed = true, .published = published, .replayed = replayed, .configured_concurrency = 4, .native_parallel_capability = true, .message_encodings = messages }, .{});
    defer a.free(text);
    try std.fs.File.stdout().writeAll(text);
    try std.fs.File.stdout().writeAll("\n");
}
