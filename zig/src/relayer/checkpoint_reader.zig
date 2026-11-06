//! Explicit announcement-location readers. Anonymous cloud reads use fixed
//! provider endpoints. Each request gets its own cancellation context while
//! sharing the native connection pool; no environment or credentials are read.
const std = @import("std");
const storage = @import("../storage/root.zig");
const cloud = @import("../cloud/root.zig");
const curl = @import("../net/curl.zig");
const pool = @import("checkpoint_pool.zig");
const Allocator = std.mem.Allocator;
pub const Location = union(enum) {
    local: []const u8,
    s3: struct { bucket: []const u8, region: []const u8, folder: ?[]const u8 },
    gcs: struct { bucket: []const u8, folder: ?[]const u8 },
};

/// The production parser splits announcement strings literally, including the
/// GCS announcement filename. S3 nested prefixes survive; GCS permits one folder.
/// Returned components borrow input.
pub fn parseLocation(text: []const u8) !Location {
    if (text.len > 8192 or std.mem.indexOfScalar(u8, text, 0) != null) return error.InvalidCheckpointLocation;
    var pair = std.mem.splitSequence(u8, text, "://");
    const scheme = pair.next().?;
    const suffix = pair.next() orelse return error.InvalidCheckpointLocation;
    if (pair.next() != null) return error.InvalidCheckpointLocation;
    if (std.mem.eql(u8, scheme, "file")) return .{ .local = suffix };
    var components = std.mem.splitScalar(u8, suffix, '/');
    const bucket = components.next().?;
    const second = components.next() orelse return error.InvalidCheckpointLocation;
    if (std.mem.eql(u8, scheme, "s3")) {
        const rest = components.rest();
        return .{ .s3 = .{ .bucket = bucket, .region = second, .folder = if (components.index == null) null else rest } };
    }
    if (std.mem.eql(u8, scheme, "gs")) {
        if (components.next() == null) return .{ .gcs = .{ .bucket = bucket, .folder = null } };
        if (components.next() != null) return error.InvalidCheckpointLocation;
        return .{ .gcs = .{ .bucket = bucket, .folder = second } };
    }
    return error.InvalidCheckpointLocation;
}

fn s3Endpoint(allocator: Allocator, region: []const u8) ![]const u8 {
    if (region.len == 0 or region.len > 64) return error.InvalidCheckpointRegion;
    for (region) |byte| if (!std.ascii.isLower(byte) and !std.ascii.isDigit(byte) and byte != '-') return error.InvalidCheckpointRegion;
    if (std.mem.eql(u8, region, "aws-global")) return allocator.dupe(u8, "https://s3.amazonaws.com");
    // Partition DNS suffixes from the pinned production aws-sdk-s3 endpoint
    // partition rules. Reader endpoints do not enable accelerate/FIPS/dualstack.
    const suffix = if (std.mem.startsWith(u8, region, "cn-")) "amazonaws.com.cn" else if (std.mem.startsWith(u8, region, "us-isob-")) "sc2s.sgov.gov" else if (std.mem.startsWith(u8, region, "us-iso-")) "c2s.ic.gov" else if (std.mem.startsWith(u8, region, "eu-isoe-")) "cloud.adc-e.uk" else if (std.mem.startsWith(u8, region, "us-isof-")) "csp.hci.ic.gov" else "amazonaws.com";
    return std.fmt.allocPrint(allocator, "https://s3.{s}.{s}", .{ region, suffix });
}

pub const Reader = struct {
    allocator: Allocator,
    arena: std.heap.ArenaAllocator,
    validator: pool.Address,
    origin: u32,
    native: ?*curl.Client,
    backend: union(enum) { local: storage.LocalStore, cloud: cloud.storage.Backend },
    references: std.atomic.Value(usize) = .init(1),
    location_id: [32]u8,

    pub fn open(allocator: Allocator, origin: u32, validator: pool.Address, location: []const u8, native: ?*curl.Client, allow_local: bool) !*Reader {
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const parsed = try parseLocation(try a.dupe(u8, location));
        const backend: @FieldType(Reader, "backend") = switch (parsed) {
            .local => |path| local: {
                if (!allow_local) return error.LocalCheckpointSyncerDisabled;
                break :local .{ .local = try storage.LocalStore.open(allocator, std.fs.cwd(), path, .{}) };
            },
            .s3 => |config| .{ .cloud = .{ .s3 = .{ .bucket = config.bucket, .region = config.region, .folder = config.folder, .endpoint = try s3Endpoint(a, config.region) } } },
            .gcs => |config| .{ .cloud = .{ .gcs = .{ .bucket = config.bucket, .folder = config.folder } } },
        };
        errdefer {
            if (backend == .local) {
                var local = backend.local;
                local.deinit();
            }
        }
        if (backend == .cloud) {
            if (native == null) return error.NativeTransportRequired;
            var transport = cloud.http.HttpTransport.init(allocator);
            defer transport.deinit();
            _ = try cloud.storage.Store.init(allocator, transport.interface(), backend.cloud, .{});
        }
        const self = try allocator.create(Reader);
        var location_id: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(location, &location_id, .{});
        self.* = .{ .allocator = allocator, .arena = arena, .origin = origin, .validator = validator, .native = native, .backend = backend, .location_id = location_id };
        return self;
    }

    /// Release the caller's reference. Pool registrations and active callbacks
    /// retain their own references until their work finishes.
    pub fn deinit(self: *Reader) void {
        if (self.references.fetchSub(1, .acq_rel) != 1) return;
        if (self.backend == .local) self.backend.local.deinit();
        self.arena.deinit();
        const allocator = self.allocator;
        allocator.destroy(self);
    }

    pub fn interface(self: *Reader) pool.Reader {
        return .{ .origin = self.origin, .validator = self.validator, .location_id = self.location_id, .context = self, .fetch = fetch, .latest = latest, .retain = retain, .release = release, .validate = validate };
    }

    fn retain(context: *anyopaque) void {
        const self: *Reader = @ptrCast(@alignCast(context));
        _ = self.references.fetchAdd(1, .acq_rel);
    }
    fn release(context: *anyopaque) void {
        const self: *Reader = @ptrCast(@alignCast(context));
        self.deinit();
    }

    fn guarded(comptime Store: type, store: *Store) !void {
        var status = try store.reorgStatus();
        defer status.deinit();
        if (status.exists) return error.ValidatorReorg;
    }

    pub fn validate(context: *anyopaque, cancel: *const std.atomic.Value(bool)) !void {
        const self: *Reader = @ptrCast(@alignCast(context));
        if (cancel.load(.acquire)) return error.RequestCancelled;
        switch (self.backend) {
            .local => try guarded(storage.LocalStore, &self.backend.local),
            .cloud => |backend| {
                var transport = cloud.http.HttpTransport.init(self.allocator);
                defer transport.deinit();
                transport.native_curl = self.native;
                transport.cancel = cancel;
                var store = try cloud.storage.Store.init(self.allocator, transport.interface(), backend, .{});
                try guarded(cloud.storage.Store, &store);
            },
        }
    }

    fn fetch(context: *anyopaque, index: u32, cancel: *const std.atomic.Value(bool)) !?storage.SignedCheckpoint {
        const self: *Reader = @ptrCast(@alignCast(context));
        if (cancel.load(.acquire)) return error.RequestCancelled;
        return switch (self.backend) {
            .local => local: {
                try guarded(storage.LocalStore, &self.backend.local);
                break :local self.backend.local.fetchCheckpoint(index);
            },
            .cloud => |backend| remote: {
                var transport = cloud.http.HttpTransport.init(self.allocator);
                defer transport.deinit();
                transport.native_curl = self.native;
                transport.cancel = cancel;
                var store = try cloud.storage.Store.init(self.allocator, transport.interface(), backend, .{});
                try guarded(cloud.storage.Store, &store);
                break :remote store.fetchCheckpoint(index);
            },
        };
    }

    fn latest(context: *anyopaque, cancel: *const std.atomic.Value(bool)) !?u32 {
        const self: *Reader = @ptrCast(@alignCast(context));
        if (cancel.load(.acquire)) return error.RequestCancelled;
        return switch (self.backend) {
            .local => local: {
                try guarded(storage.LocalStore, &self.backend.local);
                break :local self.backend.local.latestIndex();
            },
            .cloud => |backend| remote: {
                var transport = cloud.http.HttpTransport.init(self.allocator);
                defer transport.deinit();
                transport.native_curl = self.native;
                transport.cancel = cancel;
                var store = try cloud.storage.Store.init(self.allocator, transport.interface(), backend, .{});
                try guarded(cloud.storage.Store, &store);
                break :remote store.latestIndex();
            },
        };
    }
};

test "checkpoint announcement parser preserves source S3 and GCS path shapes" {
    const s3 = (try parseLocation("s3://bucket-name/us-east-1/a/b/")).s3;
    try std.testing.expectEqualStrings("a/b/", s3.folder.?);
    try std.testing.expect((try parseLocation("s3://bucket-name/us-east-1")).s3.folder == null);
    try std.testing.expectEqualStrings("", (try parseLocation("s3://bucket-name/us-east-1/")).s3.folder.?);
    const gcs = (try parseLocation("gs://bucket-name/folder/gcsAnnouncementKey")).gcs;
    try std.testing.expectEqualStrings("folder", gcs.folder.?);
    try std.testing.expect((try parseLocation("gs://bucket-name/gcsAnnouncementKey")).gcs.folder == null);
    try std.testing.expectError(error.InvalidCheckpointLocation, parseLocation("gs://bucket/a/b/c"));
    try std.testing.expectError(error.InvalidCheckpointLocation, parseLocation("s3://bucket/https://host"));
    try std.testing.expectEqualStrings("/tmp/checkpoints", (try parseLocation("file:///tmp/checkpoints")).local);
    const endpoint = try s3Endpoint(std.testing.allocator, "cn-north-1");
    defer std.testing.allocator.free(endpoint);
    try std.testing.expectEqualStrings("https://s3.cn-north-1.amazonaws.com.cn", endpoint);
    try std.testing.expectError(error.InvalidCheckpointRegion, s3Endpoint(std.testing.allocator, "us-east-1/@127.0.0.1"));
}

test "checkpoint location reader opens existing local history and treats every reorg flag as fatal" {
    const allocator = std.testing.allocator;
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    const key: [32]u8 = @splat(0x11);
    const validator = try @import("../protocol/root.zig").signature.secretKeyAddress(key);
    var writer = try storage.LocalStore.open(allocator, directory.dir, "checkpoints", .{ .read_only = false, .signer = validator });
    defer writer.deinit();
    const value: @import("../protocol/root.zig").Checkpoint = .{ .mailbox_domain = 1, .merkle_tree_hook_address = @splat(1), .root = @splat(2), .index = 2, .message_id = @splat(3) };
    const signed = try storage.SignedCheckpoint.sign(value, key, null);
    _ = try writer.writeCheckpoint(signed, 0);
    try writer.writeLatestIndex(2);
    const path = try writer.dir.realpathAlloc(allocator, ".");
    defer allocator.free(path);
    const location = try std.fmt.allocPrint(allocator, "file://{s}", .{path});
    defer allocator.free(location);
    try std.testing.expectError(error.LocalCheckpointSyncerDisabled, Reader.open(allocator, 1, validator, location, null, false));
    const reader = try Reader.open(allocator, 1, validator, location, null, true);
    defer reader.deinit();
    const interface = reader.interface();
    var cancel = std.atomic.Value(bool).init(false);
    try std.testing.expectEqual(@as(?u32, 2), try interface.latest(interface.context, &cancel));
    try std.testing.expectEqual(signed, (try interface.fetch(interface.context, 2, &cancel)).?);
    cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, interface.fetch(interface.context, 2, &cancel));
    cancel.store(false, .release);
    try writer.dir.writeFile(.{ .sub_path = "reorg_flag.json", .data = "malformed flag" });
    try std.testing.expectError(error.ValidatorReorg, interface.latest(interface.context, &cancel));
    try std.testing.expectError(error.ValidatorReorg, interface.fetch(interface.context, 2, &cancel));
}
