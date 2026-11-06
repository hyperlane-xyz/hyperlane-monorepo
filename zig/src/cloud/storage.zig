const std = @import("std");
const http = @import("http.zig");
const aws = @import("sigv4.zig");
const objects = @import("../storage/objects.zig");
const local = @import("../storage/local.zig");
const curl = @import("../net/curl.zig");
const Allocator = std.mem.Allocator;
pub const Object = union(enum) { checkpoint: u32, latest_index, snapshot, metadata, announcement, reorg_flag, reorg_rpc_responses };
pub const Backend = union(enum) {
    s3: struct { endpoint: []const u8, bucket: []const u8, region: []const u8, folder: ?[]const u8 = null, credentials: ?aws.Credentials = null },
    gcs: struct { endpoint: []const u8 = "https://storage.googleapis.com", bucket: []const u8, folder: ?[]const u8 = null, bearer_token: ?[]const u8 = null },
};
pub const Options = struct { read_only: bool = true, signer: ?objects.Address = null, reorg_period: objects.ReorgPeriod = .none };
pub const PreparedRead = struct {
    arena: std.heap.ArenaAllocator,
    request: curl.Request,
    pub fn deinit(self: *PreparedRead) void {
        self.arena.deinit();
        self.* = undefined;
    }
};

/// Explicit credentials and transport are borrowed. No ADC, metadata-server,
/// environment, credential-file or production request is performed by init.
pub const Store = struct {
    allocator: Allocator,
    transport: http.Transport,
    backend: Backend,
    options: Options,
    halted: bool = false,
    mutex: std.Thread.Mutex = .{},

    pub fn init(allocator: Allocator, transport: http.Transport, backend: Backend, options: Options) !Store {
        const bucket = switch (backend) {
            inline else => |config| config.bucket,
        };
        if (bucket.len < 3 or bucket.len > 63 or !std.ascii.isAlphanumeric(bucket[0]) or !std.ascii.isAlphanumeric(bucket[bucket.len - 1])) return error.InvalidBucket;
        for (bucket) |byte| if ((!std.ascii.isLower(byte) and !std.ascii.isDigit(byte)) and std.mem.indexOfScalar(u8, "-_.", byte) == null) return error.InvalidBucket;
        switch (backend) {
            .gcs => if (std.mem.startsWith(u8, bucket, "goog") or std.mem.indexOf(u8, bucket, "google") != null or std.mem.indexOf(u8, bucket, "g00gle") != null) return error.InvalidBucket,
            .s3 => {},
        }
        const endpoint = switch (backend) {
            inline else => |config| config.endpoint,
        };
        const uri = try std.Uri.parse(endpoint);
        if (uri.host == null or uri.user != null or uri.password != null or uri.query != null or uri.fragment != null or (uri.path.percent_encoded.len != 0 and !std.mem.eql(u8, uri.path.percent_encoded, "/"))) return error.InvalidCloudEndpoint;
        if (!options.read_only) {
            if (options.signer == null) return error.MissingStoreSigner;
            switch (backend) {
                .s3 => |config| if (config.credentials == null) return error.MissingCloudCredentials,
                .gcs => |config| if (config.bearer_token == null or config.bearer_token.?.len == 0) return error.MissingCloudCredentials,
            }
        }
        return .{ .allocator = allocator, .transport = transport, .backend = backend, .options = options };
    }

    pub fn key(self: Store, allocator: Allocator, object: Object, legacy_root: bool) ![]u8 {
        const name = switch (object) {
            .checkpoint => |index| try std.fmt.allocPrint(allocator, "checkpoint_{d}_with_id.json", .{index}),
            else => try allocator.dupe(u8, switch (self.backend) {
                .s3 => switch (object) {
                    .latest_index => "checkpoint_latest_index.json",
                    .snapshot => "merkle_snapshot.json",
                    .metadata => "metadata_latest.json",
                    .announcement => "announcement.json",
                    .reorg_flag => "reorg_flag.json",
                    .reorg_rpc_responses => "reorg_rpc_responses.json",
                    .checkpoint => unreachable,
                },
                .gcs => switch (object) {
                    .latest_index => "gcsLatestIndexKey",
                    .snapshot => "merkle_snapshot.json",
                    .metadata => "gcsMetadataKey",
                    .announcement => "gcsAnnouncementKey",
                    .reorg_flag => "gcsReorgFlagKey",
                    .reorg_rpc_responses => "gcsReorgRpcResponsesKey",
                    .checkpoint => unreachable,
                },
            }),
        };
        defer allocator.free(name);
        if (legacy_root) return allocator.dupe(u8, name);
        const folder = switch (self.backend) {
            inline else => |config| config.folder,
        };
        if (folder) |raw| {
            const prefix = switch (self.backend) {
                .s3 => raw,
                .gcs => std.mem.trimEnd(u8, raw, "/"),
            };
            if (self.backend == .s3 and prefix.len == 0) return allocator.dupe(u8, name);
            return std.fmt.allocPrint(allocator, "{s}/{s}", .{ prefix, name });
        }
        return allocator.dupe(u8, name);
    }

    pub fn announcementLocation(self: Store, allocator: Allocator) ![]u8 {
        return switch (self.backend) {
            .s3 => |config| if (config.folder) |folder|
                if (folder.len == 0) std.fmt.allocPrint(allocator, "s3://{s}/{s}", .{ config.bucket, config.region }) else std.fmt.allocPrint(allocator, "s3://{s}/{s}/{s}", .{ config.bucket, config.region, folder })
            else
                std.fmt.allocPrint(allocator, "s3://{s}/{s}", .{ config.bucket, config.region }),
            .gcs => |config| blk: {
                const object_key = try self.key(allocator, .announcement, false);
                defer allocator.free(object_key);
                break :blk std.fmt.allocPrint(allocator, "gs://{s}/{s}", .{ config.bucket, object_key });
            },
        };
    }

    /// Owns every URL/header/token byte until deinit. No request is performed.
    /// Explicit async engines may override deadline/cancel fields before submit.
    /// The backend authority is trusted configuration, not an arbitrary URL from
    /// validator announcement data. S3 reads deliberately remain anonymous.
    pub fn prepareRead(self: *const Store, allocator: Allocator, object: Object, legacy_root: bool, allow_insecure_loopback: bool) !PreparedRead {
        _ = try Store.init(allocator, self.transport, self.backend, .{});
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const key_name = try self.key(a, object, legacy_root);
        const cap: usize = if (self.backend == .gcs and object == .snapshot) 8 * 1024 else 50 * 1024;
        const endpoint = switch (self.backend) {
            inline else => |config| config.endpoint,
        };
        const uri = try std.Uri.parse(endpoint);
        var buffer: [std.Uri.host_name_max]u8 = undefined;
        const host = try uri.getHost(&buffer);
        const loopback = allow_insecure_loopback and (std.mem.eql(u8, host, "127.0.0.1") or std.mem.eql(u8, host, "::1") or std.mem.eql(u8, host, "[::1]"));
        if (!std.mem.eql(u8, uri.scheme, "https") and !(loopback and std.mem.eql(u8, uri.scheme, "http"))) return error.InsecureCloudUrl;
        const request: curl.Request = switch (self.backend) {
            .s3 => |config| blk: {
                const path = try http.percentEncode(a, try std.fmt.allocPrint(a, "/{s}/{s}", .{ config.bucket, key_name }), true);
                break :blk .{ .method = .get, .url = try std.fmt.allocPrint(a, "{s}{s}", .{ std.mem.trimEnd(u8, config.endpoint, "/"), path }), .timeout_ms = 10000, .connect_timeout_ms = 10000, .max_response_bytes = cap - 1 };
            },
            .gcs => |config| blk: {
                var headers: std.ArrayList(curl.Header) = .empty;
                if (config.bearer_token) |token| try headers.append(a, .{ .name = "authorization", .value = try std.fmt.allocPrint(a, "Bearer {s}", .{token}) });
                const url = try std.fmt.allocPrint(a, "{s}/storage/v1/b/{s}/o/{s}?alt=media", .{ std.mem.trimEnd(u8, config.endpoint, "/"), try http.percentEncode(a, config.bucket, false), try http.percentEncode(a, key_name, false) });
                const owned_headers = try headers.toOwnedSlice(a);
                break :blk .{ .method = .get, .url = url, .headers = owned_headers, .timeout_ms = 30000, .connect_timeout_ms = 30000, .max_response_bytes = cap - 1 };
            },
        };
        try curl.validateRequest(request);
        return .{ .arena = arena, .request = request };
    }

    fn objectRequest(self: *Store, object: Object, legacy_root: bool, write: bool, body: ?[]const u8, date: []const u8) !http.Response {
        if (!write) {
            // The synchronous injected transport retains its own explicit HTTP
            // loopback policy. The async public preparation API defaults at its
            // call site to HTTPS and exposes the fixture opt-in separately.
            var prepared = try self.prepareRead(self.allocator, object, legacy_root, true);
            defer prepared.deinit();
            const headers = try prepared.arena.allocator().alloc(http.Header, prepared.request.headers.len);
            for (prepared.request.headers, headers) |input, *out| out.* = .{ .name = input.name, .value = input.value };
            return self.transport.send(self.allocator, .{ .method = .GET, .url = prepared.request.url, .headers = headers, .max_response_bytes = prepared.request.max_response_bytes + 1 });
        }
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const temp = arena.allocator();
        const object_key = try self.key(temp, object, legacy_root);
        const cap: usize = if (self.backend == .gcs and object == .snapshot) 8 * 1024 else 50 * 1024;
        if (body) |bytes| if (bytes.len >= cap) return error.CloudObjectTooLarge;
        return switch (self.backend) {
            .s3 => |config| blk: {
                const raw_path = try std.fmt.allocPrint(temp, "/{s}/{s}", .{ config.bucket, object_key });
                const origin = std.mem.trimEnd(u8, config.endpoint, "/");
                const credentials = config.credentials orelse return error.MissingCloudCredentials;
                const uri = try std.Uri.parse(origin);
                var host_buffer: [std.Uri.host_name_max]u8 = undefined;
                const host_name = try uri.getHost(&host_buffer);
                const host = if (uri.port) |port| try std.fmt.allocPrint(temp, "{s}:{d}", .{ host_name, port }) else host_name;
                var signed = try aws.sign(self.allocator, .{ .method = .PUT, .host = host, .path = raw_path, .headers = &.{.{ .name = "content-type", .value = "application/json" }}, .body = body orelse &.{}, .amz_date = date, .region = config.region, .service = "s3", .credentials = credentials });
                defer signed.deinit();
                break :blk self.transport.send(self.allocator, .{ .method = .PUT, .url = try std.fmt.allocPrint(temp, "{s}{s}", .{ origin, signed.canonical_path }), .headers = signed.headers, .body = body, .max_response_bytes = cap });
            },
            .gcs => |config| blk: {
                var headers: std.ArrayList(http.Header) = .empty;
                if (config.bearer_token) |token| try headers.append(temp, .{ .name = "authorization", .value = try std.fmt.allocPrint(temp, "Bearer {s}", .{token}) });
                if (config.bearer_token == null or config.bearer_token.?.len == 0) return error.MissingCloudCredentials;
                const bucket = try http.percentEncode(temp, config.bucket, false);
                const encoded_key = try http.percentEncode(temp, object_key, false);
                const origin = std.mem.trimEnd(u8, config.endpoint, "/");
                const url = try std.fmt.allocPrint(temp, "{s}/upload/storage/v1/b/{s}/o?uploadType=media&name={s}", .{ origin, bucket, encoded_key });
                try headers.append(temp, .{ .name = "content-type", .value = "application/json" });
                break :blk self.transport.send(self.allocator, .{ .method = .POST, .url = url, .headers = headers.items, .body = body, .max_response_bytes = cap });
            },
        };
    }

    fn getRaw(self: *Store, object: Object, legacy_root: bool) !?[]u8 {
        var response = try self.objectRequest(object, legacy_root, false, null, "");
        defer response.deinit();
        if (response.status == 404) {
            if (self.backend == .gcs or std.mem.indexOf(u8, response.bytes, "<Code>NoSuchKey</Code>") != null) return null;
            return error.S3ObjectReadFailed;
        }
        if (!http.isSuccess(response.status)) return error.CloudObjectReadFailed;
        return try self.allocator.dupe(u8, response.bytes);
    }

    pub fn reorgStatus(self: *Store) !local.ReorgStatus {
        var bytes: ?[]u8 = null;
        if (self.backend == .gcs and self.backend.gcs.folder != null) bytes = try self.getRaw(.reorg_flag, true);
        if (bytes == null) bytes = try self.getRaw(.reorg_flag, false);
        const content = bytes orelse return .{ .allocator = self.allocator, .exists = false, .event = null, .content = null };
        errdefer self.allocator.free(content);
        const event = objects.ReorgEvent.parse(self.allocator, content) catch |err| switch (err) {
            error.OutOfMemory => return err,
            else => null,
        };
        return .{ .allocator = self.allocator, .exists = true, .event = event, .content = content };
    }

    fn requireWrite(self: *Store) !void {
        if (self.options.read_only) return error.ReadOnlyCloudStore;
        if (self.halted) return error.ReorgHalted;
        var status = try self.reorgStatus();
        defer status.deinit();
        if (status.exists) {
            self.halted = true;
            return error.ReorgHalted;
        }
    }

    fn putRaw(self: *Store, object: Object, bytes: []const u8, date: []const u8) !void {
        var response = try self.objectRequest(object, false, true, bytes, date);
        defer response.deinit();
        if (!http.isSuccess(response.status)) return error.CloudObjectWriteFailed;
    }

    pub fn fetchCheckpoint(self: *Store, index: u32) !?objects.SignedCheckpoint {
        const bytes = (try self.getRaw(.{ .checkpoint = index }, false)) orelse return null;
        defer self.allocator.free(bytes);
        const signed = try objects.SignedCheckpoint.parse(self.allocator, bytes);
        if (signed.value.index != index) return error.WrongCheckpointIndex;
        return signed;
    }
    pub fn latestIndex(self: *Store) !?u32 {
        const bytes = (try self.getRaw(.latest_index, false)) orelse return null;
        defer self.allocator.free(bytes);
        return try std.json.parseFromSliceLeaky(u32, self.allocator, bytes, .{});
    }
    pub fn readSnapshot(self: *Store) !?objects.Snapshot {
        const bytes = (try self.getRaw(.snapshot, false)) orelse return null;
        defer self.allocator.free(bytes);
        return try objects.Snapshot.parse(self.allocator, bytes);
    }

    /// Pre-signed publication only. Caller must serialize/check its signing
    /// reservations before requesting an external KMS signature.
    pub fn writeCheckpoint(self: *Store, signed: objects.SignedCheckpoint, unix_timestamp: u64, date: []const u8) !local.WriteResult {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.requireWrite();
        const expected = self.options.signer orelse return error.MissingStoreSigner;
        if (!std.mem.eql(u8, &try signed.recover(), &expected)) return error.WrongStoreSigner;
        var result: local.WriteResult = .written;
        if (try self.fetchCheckpoint(signed.value.index)) |previous| {
            if (std.mem.eql(u8, &try previous.recover(), &expected)) {
                if (std.meta.eql(previous.value, signed.value)) return .already_present;
                if (previous.value.mailbox_domain == signed.value.mailbox_domain and std.mem.eql(u8, &previous.value.merkle_tree_hook_address, &signed.value.merkle_tree_hook_address)) {
                    try self.persistReorgLocked(.{ .local_merkle_root = previous.value.root, .canonical_merkle_root = signed.value.root, .checkpoint_index = signed.value.index, .unix_timestamp = unix_timestamp, .reorg_period = self.options.reorg_period }, date);
                    return error.ConflictingSignedCheckpoint;
                }
                result = .overwrote_other_context;
            } else result = .overwrote_other_signer;
        }
        const pretty = try signed.toJson(self.allocator);
        defer self.allocator.free(pretty);
        const compact = try compactJson(self.allocator, pretty);
        defer self.allocator.free(compact);
        try self.putRaw(.{ .checkpoint = signed.value.index }, compact, date);
        return result;
    }

    pub fn writeLatestIndex(self: *Store, index: u32, date: []const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.requireWrite();
        const previous = try self.latestIndex();
        if (previous) |old| {
            if (index < old) return error.LatestIndexRegression;
        }
        const expected = self.options.signer orelse return error.MissingStoreSigner;
        const signed = (try self.fetchCheckpoint(index)) orelse return error.CheckpointPublicationGap;
        if (!std.mem.eql(u8, &try signed.recover(), &expected)) return error.WrongStoreSigner;
        if (previous == index) return;
        const bytes = try std.fmt.allocPrint(self.allocator, "{d}", .{index});
        defer self.allocator.free(bytes);
        try self.putRaw(.latest_index, bytes, date);
    }
    pub fn writeSnapshot(self: *Store, snapshot: *const objects.Snapshot, date: []const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.requireWrite();
        const signed = (try self.fetchCheckpoint(snapshot.index)) orelse return error.SnapshotCheckpointMissing;
        _ = try snapshot.authenticatedRestore(signed, self.options.signer orelse return error.MissingStoreSigner, signed.value.mailbox_domain, signed.value.merkle_tree_hook_address);
        const bytes = try snapshot.toJson(self.allocator);
        defer self.allocator.free(bytes);
        try self.putRaw(.snapshot, bytes, date);
    }
    pub fn writeAnnouncement(self: *Store, signed: objects.SignedAnnouncement, date: []const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.requireWrite();
        const expected = self.options.signer orelse return error.MissingStoreSigner;
        if (!std.mem.eql(u8, &try signed.recover(), &expected)) return error.WrongStoreSigner;
        const pretty = try signed.toJson(self.allocator);
        defer self.allocator.free(pretty);
        const bytes = if (self.backend == .gcs) try compactJson(self.allocator, pretty) else try self.allocator.dupe(u8, pretty);
        defer self.allocator.free(bytes);
        try self.putRaw(.announcement, bytes, date);
    }
    pub fn writeMetadata(self: *Store, bytes: []const u8, date: []const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.requireWrite();
        try self.putRaw(.metadata, bytes, date);
    }
    pub fn writeReorgRpcResponses(self: *Store, public_log: []const u8, date: []const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.requireWrite();
        try self.putRaw(.reorg_rpc_responses, public_log, date);
    }
    pub fn persistReorg(self: *Store, event: objects.ReorgEvent, date: []const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.options.read_only) return error.ReadOnlyCloudStore;
        try self.persistReorgLocked(event, date);
    }
    fn persistReorgLocked(self: *Store, event: objects.ReorgEvent, date: []const u8) !void {
        self.halted = true;
        const pretty = try event.toJson(self.allocator);
        defer self.allocator.free(pretty);
        const bytes = if (self.backend == .s3) try compactJson(self.allocator, pretty) else try self.allocator.dupe(u8, pretty);
        defer self.allocator.free(bytes);
        try self.putRaw(.reorg_flag, bytes, date);
    }
};

fn compactJson(allocator: Allocator, bytes: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{});
    defer parsed.deinit();
    return std.json.Stringify.valueAlloc(allocator, parsed.value, .{});
}

const mock = @import("testing.zig");
const fixture_date = "20130524T000000Z";
fn assertAnonymous(request: http.Request) !void {
    try std.testing.expect(mock.header(request, "authorization") == null);
}
fn assertAwsAuth(request: http.Request) !void {
    const authorization = mock.header(request, "authorization") orelse return error.MissingAwsAuthorization;
    try std.testing.expect(std.mem.startsWith(u8, authorization, "AWS4-HMAC-SHA256 Credential=EXAMPLE/"));
    try std.testing.expectEqualStrings("session-fixture", mock.header(request, "x-amz-security-token") orelse return error.MissingAwsSessionToken);
    try std.testing.expectEqualStrings(fixture_date, mock.header(request, "x-amz-date") orelse return error.MissingAwsDate);
}

test "cloud storage preserves distinct S3 and GCS names folder rules and locations" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var transport: mock.Mock = .{ .steps = &.{} };
    const s3 = try Store.init(allocator, transport.transport(), .{ .s3 = .{ .endpoint = "https://s3.example.invalid", .bucket = "public-fixture", .region = "us-east-1", .folder = "nested/path" } }, .{});
    try std.testing.expectEqualStrings("nested/path/checkpoint_42_with_id.json", try s3.key(allocator, .{ .checkpoint = 42 }, false));
    try std.testing.expectEqualStrings("nested/path/checkpoint_latest_index.json", try s3.key(allocator, .latest_index, false));
    try std.testing.expectEqualStrings("s3://public-fixture/us-east-1/nested/path", try s3.announcementLocation(allocator));
    const gcs = try Store.init(allocator, transport.transport(), .{ .gcs = .{ .bucket = "public.fixture", .folder = "nested/path///" } }, .{});
    try std.testing.expectEqualStrings("nested/path/gcsLatestIndexKey", try gcs.key(allocator, .latest_index, false));
    try std.testing.expectEqualStrings("gcsReorgFlagKey", try gcs.key(allocator, .reorg_flag, true));
    try std.testing.expectEqualStrings("nested/path/gcsMetadataKey", try gcs.key(allocator, .metadata, false));
    try std.testing.expectEqualStrings("nested/path/gcsReorgRpcResponsesKey", try gcs.key(allocator, .reorg_rpc_responses, false));
    try std.testing.expectEqualStrings("gs://public.fixture/nested/path/gcsAnnouncementKey", try gcs.announcementLocation(allocator));
    try std.testing.expectError(error.MissingCloudCredentials, Store.init(allocator, transport.transport(), .{ .gcs = .{ .bucket = "public-fixture" } }, .{ .read_only = false, .signer = .{0} ** 20 }));
    try std.testing.expectError(error.InvalidBucket, Store.init(allocator, transport.transport(), .{ .gcs = .{ .bucket = "invalid/bucket" } }, .{}));
    try transport.expectDone();
}

test "cloud prepared native GET owns URL auth exact keys caps and narrow loopback policy without IO" {
    const a = std.testing.allocator;
    const testing = @import("testing.zig");
    var transport: testing.Mock = .{ .steps = &.{} };
    var prefix = "a/../b//space %/".*;
    var s3 = try Store.init(a, transport.transport(), .{ .s3 = .{ .endpoint = "https://s3.example.invalid", .bucket = "fixture-bucket", .region = "us-east-1", .folder = &prefix, .credentials = .{ .access_key_id = "EXAMPLE", .secret_access_key = "fixture" } } }, .{});
    var prepared = try s3.prepareRead(a, .{ .checkpoint = 42 }, false, false);
    defer prepared.deinit();
    @memset(&prefix, 'X');
    try std.testing.expectEqualStrings("https://s3.example.invalid/fixture-bucket/a/../b//space%20%25//checkpoint_42_with_id.json", prepared.request.url);
    try std.testing.expectEqual(@as(usize, 0), prepared.request.headers.len);
    try std.testing.expectEqual(@as(usize, 50 * 1024 - 1), prepared.request.max_response_bytes);
    try std.testing.expectEqual(@as(u32, 10000), prepared.request.timeout_ms);
    var token = "fixture-token".*;
    var gcs = try Store.init(a, transport.transport(), .{ .gcs = .{ .endpoint = "https://storage.example.invalid", .bucket = "fixture-bucket", .folder = "route//", .bearer_token = &token } }, .{});
    var index = try gcs.prepareRead(a, .latest_index, false, false);
    defer index.deinit();
    token[0] = 'X';
    try std.testing.expectEqualStrings("https://storage.example.invalid/storage/v1/b/fixture-bucket/o/route%2FgcsLatestIndexKey?alt=media", index.request.url);
    try std.testing.expectEqualStrings("Bearer fixture-token", index.request.headers[0].value);
    var root = try gcs.prepareRead(a, .reorg_flag, true, false);
    defer root.deinit();
    try std.testing.expect(std.mem.endsWith(u8, root.request.url, "/o/gcsReorgFlagKey?alt=media"));
    var snapshot = try gcs.prepareRead(a, .snapshot, false, false);
    defer snapshot.deinit();
    try std.testing.expectEqual(@as(usize, 8 * 1024 - 1), snapshot.request.max_response_bytes);
    s3.backend.s3.endpoint = "http://127.0.0.1:5";
    try std.testing.expectError(error.InsecureCloudUrl, s3.prepareRead(a, .latest_index, false, false));
    var loop = try s3.prepareRead(a, .latest_index, false, true);
    defer loop.deinit();
    s3.backend.s3.endpoint = "http://192.168.1.2";
    try std.testing.expectError(error.InsecureCloudUrl, s3.prepareRead(a, .latest_index, false, true));
    try transport.expectDone();
}

test "GCS legacy root guard blocks folder writer even when malformed" {
    var transport: mock.Mock = .{ .steps = &.{.{ .method = .GET, .suffix = "/o/gcsReorgFlagKey?alt=media", .response = "torn guard" }} };
    var store = try Store.init(std.testing.allocator, transport.transport(), .{ .gcs = .{ .bucket = "public-fixture", .folder = "a/b", .bearer_token = "fixture-token" } }, .{ .read_only = false, .signer = .{0} ** 20 });
    try std.testing.expectError(error.ReorgHalted, store.writeMetadata("{}", fixture_date));
    try std.testing.expectError(error.ReorgHalted, store.writeMetadata("late signer", fixture_date));
    try transport.expectDone();
}

test "S3 reads anonymously and PUT signs escaped object path and temporary credentials" {
    const missing = "<Error><Code>NoSuchKey</Code></Error>";
    var transport: mock.Mock = .{ .steps = &.{
        .{ .method = .GET, .suffix = "/public-fixture/a%20b/reorg_flag.json", .check = assertAnonymous, .status = 404, .response = missing },
        .{ .method = .PUT, .suffix = "/public-fixture/a%20b/metadata_latest.json", .check = assertAwsAuth, .request_body = "{}" },
        .{ .method = .GET, .suffix = "/public-fixture/a%20b/checkpoint_latest_index.json", .check = assertAnonymous, .response = "42" },
        .{ .method = .GET, .suffix = "/public-fixture/a%20b/checkpoint_42_with_id.json", .check = assertAnonymous, .status = 404, .response = "<Error><Code>NoSuchBucket</Code></Error>" },
    } };
    var store = try Store.init(std.testing.allocator, transport.transport(), .{ .s3 = .{ .endpoint = "https://s3.example.invalid", .bucket = "public-fixture", .region = "us-east-1", .folder = "a b", .credentials = .{ .access_key_id = "EXAMPLE", .secret_access_key = "fixture", .session_token = "session-fixture" } } }, .{ .read_only = false, .signer = .{0} ** 20 });
    try store.writeMetadata("{}", fixture_date);
    try std.testing.expectEqual(@as(?u32, 42), try store.latestIndex());
    try std.testing.expectError(error.S3ObjectReadFailed, store.fetchCheckpoint(42));
    try transport.expectDone();
}

test "GCS checkpoint publication snapshot announcement and reorg serialization" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const protocol = @import("../protocol/root.zig");
    const key_bytes: objects.Hash = .{0x11} ** 32;
    const signer = try protocol.signature.secretKeyAddress(key_bytes);
    var tree = protocol.IncrementalMerkle.init();
    const leaf: objects.Hash = .{0x44} ** 32;
    try tree.ingest(leaf);
    const signed = try objects.SignedCheckpoint.sign(.{ .merkle_tree_hook_address = .{0x22} ** 32, .mailbox_domain = 1000, .root = tree.root(), .index = 0, .message_id = leaf }, key_bytes, null);
    const checkpoint = try compactJson(allocator, try signed.toJson(allocator));
    const snapshot = try objects.Snapshot.capture(&tree);
    const snapshot_json = try snapshot.toJson(allocator);
    const announcement = try objects.SignedAnnouncement.sign(.{ .validator = signer, .mailbox_address = .{0x22} ** 32, .mailbox_domain = 1000, .storage_location = "gs://public-fixture/gcsAnnouncementKey" }, key_bytes, null);
    const announcement_json = try compactJson(allocator, try announcement.toJson(allocator));
    const event: objects.ReorgEvent = .{ .local_merkle_root = .{1} ** 32, .canonical_merkle_root = .{2} ** 32, .checkpoint_index = 0, .unix_timestamp = 1, .reorg_period = .none };
    const guard = try event.toJson(allocator);
    var transport: mock.Mock = .{ .steps = &.{
        .{ .method = .GET, .suffix = "/o/gcsReorgFlagKey?alt=media", .status = 404 },
        .{ .method = .GET, .suffix = "/o/checkpoint_0_with_id.json?alt=media", .status = 404 },
        .{ .method = .POST, .suffix = "/o?uploadType=media&name=checkpoint_0_with_id.json", .request_body = checkpoint },
        .{ .method = .GET, .suffix = "/o/gcsReorgFlagKey?alt=media", .status = 404 },
        .{ .method = .GET, .suffix = "/o/gcsLatestIndexKey?alt=media", .status = 404 },
        .{ .method = .GET, .suffix = "/o/checkpoint_0_with_id.json?alt=media", .response = checkpoint },
        .{ .method = .POST, .suffix = "/o?uploadType=media&name=gcsLatestIndexKey", .request_body = "0" },
        .{ .method = .GET, .suffix = "/o/gcsReorgFlagKey?alt=media", .status = 404 },
        .{ .method = .GET, .suffix = "/o/checkpoint_0_with_id.json?alt=media", .response = checkpoint },
        .{ .method = .POST, .suffix = "/o?uploadType=media&name=merkle_snapshot.json", .request_body = snapshot_json },
        .{ .method = .GET, .suffix = "/o/merkle_snapshot.json?alt=media", .response = snapshot_json },
        .{ .method = .GET, .suffix = "/o/gcsReorgFlagKey?alt=media", .status = 404 },
        .{ .method = .POST, .suffix = "/o?uploadType=media&name=gcsAnnouncementKey", .request_body = announcement_json },
        .{ .method = .GET, .suffix = "/o/gcsReorgFlagKey?alt=media", .status = 404 },
        .{ .method = .POST, .suffix = "/o?uploadType=media&name=gcsReorgRpcResponsesKey", .request_body = "public evidence" },
        .{ .method = .POST, .suffix = "/o?uploadType=media&name=gcsReorgFlagKey", .request_body = guard },
    } };
    var store = try Store.init(allocator, transport.transport(), .{ .gcs = .{ .endpoint = "https://storage.example.invalid", .bucket = "public-fixture", .bearer_token = "fixture-token" } }, .{ .read_only = false, .signer = signer });
    try std.testing.expectEqual(local.WriteResult.written, try store.writeCheckpoint(signed, 1, fixture_date));
    try store.writeLatestIndex(0, fixture_date);
    try store.writeSnapshot(&snapshot, fixture_date);
    try std.testing.expectEqual(snapshot, (try store.readSnapshot()).?);
    try store.writeAnnouncement(announcement, fixture_date);
    try store.writeReorgRpcResponses("public evidence", fixture_date);
    try store.persistReorg(event, fixture_date);
    try std.testing.expectError(error.ReorgHalted, store.writeMetadata("late", fixture_date));
    try transport.expectDone();
}
