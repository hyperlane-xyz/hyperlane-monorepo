const std = @import("std");
const settings = @import("../../settings/root.zig");
const config = @import("config.zig");
const tasks = @import("../validator_task.zig");
const metadata = @import("metadata.zig");
const cloud = @import("../../cloud/root.zig");
const A = std.mem.Allocator;
const revision = "1111111111111111111111111111111111111111";
const Backend = enum { local, s3, gcs };
fn configured(a: A, path: []const u8, backend: Backend, protocol: []const u8) !settings.Settings {
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const scratch = arena.allocator();
    const signer = try @import("../../evm/codecs.zig").hexAlloc(scratch, &@as([32]u8, @splat(0x11)));
    const checkpoint: std.json.Value = switch (backend) {
        .local => (try std.json.parseFromSlice(std.json.Value, scratch, try std.json.Stringify.valueAlloc(scratch, .{ .type = "localStorage", .path = try std.fs.path.join(scratch, &.{ path, "checkpoints" }) }, .{}), .{})).value,
        .s3 => (try std.json.parseFromSlice(std.json.Value, scratch, "{\"type\":\"s3\",\"bucket\":\"public-fixture\",\"region\":\"us-east-1\",\"folder\":\"nested\"}", .{})).value,
        .gcs => (try std.json.parseFromSlice(std.json.Value, scratch, "{\"type\":\"gcs\",\"bucket\":\"public-fixture\",\"folder\":\"nested\"}", .{})).value,
    };
    const address = "0x0000000000000000000000000000000000000001";
    const wire = try std.json.Stringify.valueAlloc(scratch, .{ .originChainName = "publicfixture", .db = try std.fs.path.join(scratch, &.{ path, "db" }), .validator = .{ .key = signer }, .checkpointSyncer = checkpoint, .skipAnnounce = true, .allowPublicRpcs = true, .chains = .{ .publicfixture = .{ .name = "publicfixture", .domainId = @as(u32, 3999999999), .chainId = @as(u32, 31337), .protocol = protocol, .rpcUrls = .{.{ .http = "http://127.0.0.1:1" }}, .grpcUrls = .{ .{ .http = "http://127.1/", .public = true }, .{ .http = "https://bücher.example/", .public = false } }, .walletUrls = .{.{ .http = "http://127.0.0.1:1/wallet" }}, .walletSolidityUrls = .{.{ .http = "http://127.0.0.1:1/walletsolidity" }}, .rpcConsensusType = "single", .mailbox = address, .merkleTreeHook = address, .validatorAnnounce = address, .interchainGasPaymaster = address, .blocks = .{ .reorgPeriod = 0 } } } }, .{});
    const parsed = try std.json.parseFromSlice(std.json.Value, scratch, wire, .{});
    const root = try @import("../../config.zig").normalizedValue(scratch, parsed.value);
    return settings.Settings.fromConfig(.{ .arena = arena, .root = root }, .validator);
}
const Transport = struct {
    backend: Backend,
    expected: []const u8,
    gets: usize = 0,
    writes: usize = 0,
    fail: bool = false,
    reorg: bool = false,
    cancel_after: ?*std.atomic.Value(bool) = null,
    fn lease(context: *anyopaque, _: u64) !config.Credentials {
        const self: *Transport = @ptrCast(@alignCast(context));
        return self.credentials();
    }
    fn credentials(self: *Transport) config.Credentials {
        return .{ .transport = .{ .context = self, .send_fn = send }, .amz_date = "20261106T000000Z", .aws = .{ .access_key_id = "EXAMPLE", .secret_access_key = "public-fixture" }, .gcp_bearer = "public-token" };
    }
    fn send(context: *anyopaque, a: A, request: cloud.http.Request) !cloud.http.Response {
        const self: *Transport = @ptrCast(@alignCast(context));
        if (request.method == .GET) {
            self.gets += 1;
            try std.testing.expect(std.mem.indexOf(u8, request.url, if (self.backend == .s3) "reorg_flag.json" else "gcsReorgFlagKey") != null);
            return .{ .allocator = a, .status = if (self.reorg) 200 else 404, .bytes = try a.dupe(u8, if (self.reorg) "{}" else if (self.backend == .s3) "<Error><Code>NoSuchKey</Code></Error>" else "") };
        }
        try std.testing.expectEqual(if (self.backend == .s3) std.http.Method.PUT else std.http.Method.POST, request.method);
        try std.testing.expect(std.mem.indexOf(u8, request.url, if (self.backend == .s3) "metadata_latest.json" else "gcsMetadataKey") != null);
        try std.testing.expect(std.mem.indexOf(u8, request.url, "nested") != null);
        try std.testing.expectEqualStrings(self.expected, request.body.?);
        const authorization = @import("../../cloud/testing.zig").header(request, "authorization") orelse return error.MissingAuth;
        if (self.backend == .s3) try std.testing.expect(std.mem.startsWith(u8, authorization, "AWS4-HMAC-SHA256")) else try std.testing.expectEqualStrings("Bearer public-token", authorization);
        self.writes += 1;
        if (self.cancel_after) |cancel| cancel.store(true, .release);
        return .{ .allocator = a, .status = if (self.fail) 503 else 200, .bytes = try a.dupe(u8, "") };
    }
};
fn library(a: A) ![]u8 {
    return @import("../../evm/pool_testing.zig").nativeLibrary(a);
}
test "validator metadata actual local backend startup cancellation success and reopen use compiled identity" {
    const a = std.testing.allocator;
    var url_library = try @import("metadata_test.zig").nativeLibrary();
    defer url_library.deinit();
    const normalizer = metadata.HostNormalizer.fromLibrary(&url_library);
    const url_path = try std.process.getEnvVarOwned(a, "HYPERLANE_URL_LIBRARY");
    defer a.free(url_path);
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const path = try tmp.dir.realpathAlloc(a, ".");
    defer a.free(path);
    var s = try configured(a, path, .local, "ethereum");
    defer s.deinit();
    try std.testing.expectEqual(@as(usize, 5), s.role.validator.rpcs.len);
    try std.testing.expectEqualStrings("http://127.1/", s.role.validator.rpcs[1].url);
    try std.testing.expect(s.role.validator.rpcs[1].public);
    try std.testing.expectEqualStrings("https://bücher.example/", s.role.validator.rpcs[2].url);
    var cancel: std.atomic.Value(bool) = .init(true);
    var transport: Transport = .{ .backend = .local, .expected = "" };
    const expected = try metadata.serialize(a, revision, s.role.validator.rpcs, s.role.validator.allow_public_rpcs, normalizer);
    defer a.free(expected);
    for (0..2) |iteration| {
        const task = try tasks.Task.init(a, &s, .{ .curl_library = "unused", .git_sha = revision, .url_library = url_path }, null, null);
        defer task.deinit();
        try std.testing.expect(task.metadata_url == null);
        const configured_url_path = task.options.url_library;
        task.options.url_library = "/public-fixture-no-such-url-library";

        task.resources = try config.Resources.open(a, &s, transport.credentials());
        task.mailbox.pending.store(true, .release);
        cancel.store(false, .release);
        _ = try task.announcement.tick(.{ .unix_ms = 1000, .monotonic_ms = 1000 }, &cancel);
        try std.testing.expect(!task.mailbox.pending.load(.acquire));
        try std.testing.expect(task.announcement.native == null and task.announcement.transactions == null and task.database_owner.value == null);
        cancel.store(true, .release);
        try std.testing.expectError(error.RequestCancelled, tasks.MetadataTests.publish(task, &cancel));
        try std.testing.expect(!task.metadata_ready.load(.acquire));
        cancel.store(false, .release);
        if (tasks.MetadataTests.publish(task, &cancel)) |_| return error.ExpectedMissingUrlLibrary else |_| {}
        try std.testing.expect(!task.metadata_ready.load(.acquire) and task.metadata_url == null);
        if (iteration == 0) try std.testing.expectError(error.FileNotFound, tmp.dir.openFile("checkpoints/metadata_latest.json", .{}));
        task.options.url_library = configured_url_path;
        try tasks.MetadataTests.publish(task, &cancel);
        try std.testing.expect(task.metadata_url != null);
        try std.testing.expect(task.metadata_ready.load(.acquire) and task.mailbox.pending.load(.acquire));
        const actual = try tmp.dir.readFileAlloc(a, "checkpoints/metadata_latest.json", 8192);
        defer a.free(actual);
        try std.testing.expectEqualStrings(expected, actual);
        try tasks.MetadataTests.publish(task, &cancel);
    }
    try std.testing.expectEqual(@as(usize, 0), transport.writes);
}
test "validator metadata actual EVM and generic Task startup failure blocks both descriptors and cloud retry is explicit" {
    const a = std.testing.allocator;
    var url_library = try @import("metadata_test.zig").nativeLibrary();
    defer url_library.deinit();
    const normalizer = metadata.HostNormalizer.fromLibrary(&url_library);
    const curl = try library(a);
    defer a.free(curl);
    for ([_]Backend{ .s3, .gcs }) |backend| for ([_][]const u8{ "ethereum", "tron" }) |protocol| {
        var tmp = std.testing.tmpDir(.{});
        defer tmp.cleanup();
        const path = try tmp.dir.realpathAlloc(a, ".");
        defer a.free(path);
        var s = try configured(a, path, backend, protocol);
        defer s.deinit();
        const expected = try metadata.serialize(a, revision, s.role.validator.rpcs, s.role.validator.allow_public_rpcs, normalizer);
        defer a.free(expected);
        var transport: Transport = .{ .backend = backend, .expected = expected, .fail = true };
        const task = try tasks.Task.init(a, &s, .{ .curl_library = curl, .git_sha = revision, .metadata_host = normalizer }, .{ .context = &transport, .lease = Transport.lease }, null);
        defer task.deinit();
        var cancel: std.atomic.Value(bool) = .init(false);
        if (task.tick(.{ .unix_ms = 1793923200000, .monotonic_ms = 0 }, &cancel)) |_| return error.MissingMetadataFailure else |err| {
            if (transport.writes != 1) std.debug.print("metadata startup before PUT backend={s} protocol={s} error={s}\n", .{ @tagName(backend), protocol, @errorName(err) });
            try std.testing.expect(err != error.OutOfMemory and err != error.RequestCancelled);
        }
        try std.testing.expectEqual(@as(usize, 1), transport.writes);
        try std.testing.expect(!task.metadata_ready.load(.acquire));
        if (task.validator) |v| try std.testing.expect(!v.announcement_written and v.signed_announcement == null and v.state.signed_watermark == null) else try std.testing.expect(task.generic_validator != null);
        _ = try task.announcement.tick(.{ .unix_ms = 1793923200000, .monotonic_ms = 1 }, &cancel);
        try std.testing.expect(task.announcement.native == null and task.announcement.native_owner == null and task.announcement.transactions == null);
        transport.fail = false;
        transport.cancel_after = &cancel;
        try std.testing.expectError(error.RequestCancelled, tasks.MetadataTests.publish(task, &cancel));
        try std.testing.expect(!task.metadata_ready.load(.acquire));
        cancel.store(false, .release);
        transport.cancel_after = null;
        try tasks.MetadataTests.publish(task, &cancel);
        try std.testing.expect(task.metadata_ready.load(.acquire));
        try std.testing.expectEqual(@as(usize, 3), transport.writes);
        const count = transport.gets;
        try tasks.MetadataTests.publish(task, &cancel);
        try std.testing.expectEqual(count, transport.gets);
        try std.testing.expectEqual(@as(usize, 3), transport.writes);
    };
}
test "validator metadata backend reorg and global halt never publish or release announcement" {
    const a = std.testing.allocator;
    var url_library = try @import("metadata_test.zig").nativeLibrary();
    defer url_library.deinit();
    const normalizer = metadata.HostNormalizer.fromLibrary(&url_library);
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const path = try tmp.dir.realpathAlloc(a, ".");
    defer a.free(path);
    var s = try configured(a, path, .s3, "ethereum");
    defer s.deinit();
    var transport: Transport = .{ .backend = .s3, .expected = "", .reorg = true };
    const task = try tasks.Task.init(a, &s, .{ .curl_library = "unused", .git_sha = revision, .metadata_host = normalizer }, null, null);
    defer task.deinit();
    task.resources = try config.Resources.open(a, &s, transport.credentials());
    var cancel: std.atomic.Value(bool) = .init(false);
    try std.testing.expectError(error.ValidatorHalted, tasks.MetadataTests.publish(task, &cancel));
    try std.testing.expect(task.effects_halted.load(.acquire) and !task.metadata_ready.load(.acquire));
    try std.testing.expectError(error.CheckpointEffectsHalted, task.announcement.tick(.{ .unix_ms = 0, .monotonic_ms = 0 }, &cancel));
    try std.testing.expectEqual(@as(usize, 0), transport.writes);
}
