//! Typed validator signer/checkpoint backend factory. Explicit credential leases
//! only: this module never reads process environment, home files or metadata.
const std = @import("std");
const settings = @import("../../settings/root.zig");
const service = @import("../validator.zig");
const adapters = @import("cloud.zig");
const cloud = @import("../../cloud/root.zig");
const local = @import("../../storage/local.zig");
const objects = @import("../../storage/objects.zig");
const digest_signer = @import("../signer.zig");
pub const Credentials = digest_signer.Credentials;
pub const Resources = struct {
    allocator: std.mem.Allocator,
    arena: std.heap.ArenaAllocator,
    digest_signer: *digest_signer.DigestSigner,
    store: union(enum) { local: local.LocalStore, cloud: cloud.storage.Store },
    publisher_adapter: union(enum) { local: service.LocalPublisher, cloud: adapters.Publisher },
    signer_address: [20]u8,
    storage_location: []const u8,
    parallel_safe: bool = false,
    sign_cancel: ?*const std.atomic.Value(bool) = null,
    /// KMS resolution may perform bounded I/O: call this inside an I/O worker.
    /// Borrowed credential leases and transport must outlive each worker tick.
    pub fn open(a: std.mem.Allocator, s: *const settings.Settings, credentials: Credentials) !*Resources {
        if (s.role != .validator) return error.ExpectedValidatorSettings;
        const role = s.role.validator;
        const chain = s.chainByName(role.origin_chain) orelse return error.UnknownOriginChain;
        const self = try a.create(Resources);
        errdefer a.destroy(self);
        self.* = .{ .allocator = a, .arena = .init(a), .digest_signer = undefined, .store = undefined, .publisher_adapter = undefined, .signer_address = undefined, .storage_location = undefined };
        errdefer self.arena.deinit();
        const arena = self.arena.allocator();
        self.digest_signer = try digest_signer.DigestSigner.open(a, role.signer, credentials);
        errdefer self.digest_signer.deinit();
        self.signer_address = self.digest_signer.address;
        self.parallel_safe = nativeParallelTransport(credentials);
        self.sign_cancel = if (credentials.http_owner) |owner| owner.cancel else null;
        const period: objects.ReorgPeriod = switch (chain.reorg) {
            .blocks => |n| if (n == 0) .none else .{ .blocks = n },
            .tag => |tag| .{ .tag = tag },
        };
        switch (role.checkpoint_syncer) {
            .local_storage => |path| {
                self.store = .{ .local = try local.LocalStore.open(a, std.fs.cwd(), path, .{ .read_only = false, .signer = self.signer_address, .reorg_period = period }) };
                errdefer self.store.local.deinit();
                self.storage_location = try std.fmt.allocPrint(arena, "file://{s}", .{path});
                self.publisher_adapter = .{ .local = .{ .store = &self.store.local } };
            },
            .s3 => |config| {
                const auth = credentials.aws_storage orelse credentials.aws orelse return error.MissingAwsCredentialLease;
                self.store = .{ .cloud = try cloud.storage.Store.init(a, credentials.transport, .{ .s3 = .{ .endpoint = credentials.s3_endpoint orelse try std.fmt.allocPrint(arena, "https://s3.{s}.amazonaws.com", .{config.region}), .bucket = config.bucket, .region = config.region, .folder = config.folder, .credentials = auth } }, .{ .read_only = false, .signer = self.signer_address, .reorg_period = period }) };
                self.storage_location = try self.store.cloud.announcementLocation(arena);
                self.publisher_adapter = .{ .cloud = .{ .store = &self.store.cloud, .amz_date = credentials.amz_date } };
            },
            .gcs => |config| {
                self.store = .{ .cloud = try cloud.storage.Store.init(a, credentials.transport, .{ .gcs = .{ .endpoint = credentials.gcs_endpoint orelse "https://storage.googleapis.com", .bucket = config.bucket, .folder = config.folder, .bearer_token = credentials.gcs_bearer orelse credentials.gcp_bearer orelse return error.MissingGcpCredentialLease } }, .{ .read_only = false, .signer = self.signer_address, .reorg_period = period }) };
                self.storage_location = try self.store.cloud.announcementLocation(arena);
                self.publisher_adapter = .{ .cloud = .{ .store = &self.store.cloud, .amz_date = credentials.amz_date } };
            },
        }
        return self;
    }
    pub fn signer(self: *Resources) service.Signer {
        return .{ .parallel_safe = self.digest_signer.backend == .local or self.parallel_safe, .cancel = self.sign_cancel, .context = self.digest_signer, .sign = checkpointSignature, .sign_digest = rawSignature };
    }
    fn rawSignature(ctx: *anyopaque, hash: service.Hash) ![65]u8 {
        const s: *digest_signer.DigestSigner = @ptrCast(@alignCast(ctx));
        return s.signDigest(&hash);
    }
    fn checkpointSignature(ctx: *anyopaque, checkpoint: service.Checkpoint) !objects.SignedCheckpoint {
        return .{ .value = checkpoint, .signature = objects.Signature.fromBytes(try rawSignature(ctx, checkpoint.digest())) };
    }
    pub fn publisher(self: *Resources) service.Publisher {
        return switch (self.publisher_adapter) {
            .local => |*p| p.interface(),
            .cloud => |*p| blk: {
                var value = p.interface();
                value.parallel_safe = self.parallel_safe;
                break :blk value;
            },
        };
    }
    /// Call between ticks after refreshing the caller-owned credential lease.
    pub fn refresh(self: *Resources, credentials: Credentials) !void {
        // Validate every required lease before mutating any borrowed references.
        if (self.store == .cloud) switch (self.store.cloud.backend) {
            .s3 => if (credentials.aws_storage == null and credentials.aws == null) return error.MissingAwsCredentialLease,
            .gcs => if (credentials.gcs_bearer == null and credentials.gcp_bearer == null) return error.MissingGcpCredentialLease,
        };
        try self.digest_signer.refresh(credentials);
        self.parallel_safe = nativeParallelTransport(credentials);
        self.sign_cancel = if (credentials.http_owner) |owner| owner.cancel else null;
        if (self.store == .cloud) {
            self.store.cloud.transport = credentials.transport;
            switch (self.store.cloud.backend) {
                .s3 => |*s| s.credentials = credentials.aws_storage orelse credentials.aws orelse return error.MissingAwsCredentialLease,
                .gcs => |*s| s.bearer_token = credentials.gcs_bearer orelse credentials.gcp_bearer orelse return error.MissingGcpCredentialLease,
            }
            self.publisher_adapter.cloud.amz_date = credentials.amz_date;
        }
    }
    pub fn deinit(self: *Resources) void {
        if (self.store == .local) self.store.local.deinit();
        self.digest_signer.deinit();
        self.arena.deinit();
        const a = self.allocator;
        self.* = undefined;
        a.destroy(self);
    }
};

fn nativeParallelTransport(credentials: Credentials) bool {
    const owner = credentials.http_owner orelse return false;
    const native = owner.native_curl orelse return false;
    return native.send_override == null and credentials.transport.context == owner.interface().context and credentials.transport.send_fn == owner.interface().send_fn;
}
