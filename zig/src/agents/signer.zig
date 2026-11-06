//! Owned secp256k1 signer identity with explicit, borrowed credential leases.
//! KMS resolution/signing performs I/O: invoke inside a bounded worker. Refresh
//! only between operations; drain the worker before releasing leases/deinit.
const std = @import("std");
const settings = @import("../settings/root.zig");
const cloud = @import("../cloud/root.zig");
const signature = @import("../protocol/signature.zig");
pub const Credentials = struct {
    transport: cloud.http.Transport,
    http_owner: ?*cloud.http.HttpTransport = null,
    aws: ?cloud.sigv4.Credentials = null,
    aws_storage: ?cloud.sigv4.Credentials = null,
    gcp_bearer: ?[]const u8 = null,
    gcp_quota_project: ?[]const u8 = null,
    gcs_bearer: ?[]const u8 = null,
    amz_date: []const u8,
    aws_expected_key_arn: ?[]const u8 = null,
    kms_endpoint: ?[]const u8 = null,
    s3_endpoint: ?[]const u8 = null,
    gcs_endpoint: ?[]const u8 = null,
};
pub const DigestSigner = struct {
    allocator: std.mem.Allocator,
    arena: std.heap.ArenaAllocator,
    address: [20]u8,
    public_key: [33]u8,
    backend: union(enum) {
        local: [32]u8,
        aws: struct { transport: cloud.http.Transport, config: cloud.kms.AwsConfig, amz_date: []const u8 },
        gcp: struct { transport: cloud.http.Transport, config: cloud.kms.GcpConfig },
    },
    pub fn open(a: std.mem.Allocator, config: settings.Signer, credentials: Credentials) !*DigestSigner {
        const self = try a.create(DigestSigner);
        errdefer a.destroy(self);
        self.* = .{ .allocator = a, .arena = .init(a), .address = undefined, .public_key = undefined, .backend = undefined };
        errdefer self.arena.deinit();
        const arena = self.arena.allocator();
        switch (config) {
            .hex_key => |key| {
                self.address = try signature.secretKeyAddress(key);
                self.public_key = (try std.crypto.ecc.Secp256k1.basePoint.mul(key, .big)).toCompressedSec1();
                self.backend = .{ .local = key };
            },
            .aws => |aws| {
                const auth = credentials.aws orelse return error.MissingAwsCredentialLease;
                const region = try arena.dupe(u8, aws.region);
                const endpoint = if (credentials.kms_endpoint) |v| try arena.dupe(u8, v) else try std.fmt.allocPrint(arena, "https://kms.{s}.amazonaws.com", .{region});
                var resolved = try cloud.kms.awsResolvePublicKey(a, credentials.transport, .{ .endpoint = endpoint, .region = region, .credentials = auth, .key_id = aws.id, .expected_key_arn = credentials.aws_expected_key_arn orelse "" }, credentials.amz_date);
                defer resolved.deinit();
                const arn = try arena.dupe(u8, resolved.key_arn);
                self.address = resolved.public_key.address;
                self.public_key = resolved.public_key.key.p.toCompressedSec1();
                self.backend = .{ .aws = .{ .transport = credentials.transport, .config = .{ .endpoint = endpoint, .region = region, .credentials = auth, .key_id = arn, .expected_key_arn = arn, .public_key = resolved.public_key }, .amz_date = credentials.amz_date } };
            },
            .gcp => |gcp| {
                const token = credentials.gcp_bearer orelse return error.MissingGcpCredentialLease;
                const endpoint = try arena.dupe(u8, credentials.kms_endpoint orelse "https://cloudkms.googleapis.com");
                const name = try arena.dupe(u8, gcp.key_version_name);
                const public = try cloud.kms.gcpGetPublicKey(a, credentials.transport, .{ .endpoint = endpoint, .key_version_name = name, .bearer_token = token, .quota_project = credentials.gcp_quota_project });
                self.address = public.address;
                self.public_key = public.key.p.toCompressedSec1();
                self.backend = .{ .gcp = .{ .transport = credentials.transport, .config = .{ .endpoint = endpoint, .key_version_name = name, .bearer_token = token, .quota_project = credentials.gcp_quota_project, .public_key = public } } };
            },
            else => return error.UnsupportedDigestSigner,
        }
        return self;
    }
    /// Raw digest only: callers apply the protocol's signing preimage/hash.
    pub fn signDigest(self: *DigestSigner, digest: *const [32]u8) ![65]u8 {
        return switch (self.backend) {
            .local => |key| signature.signDigest(key, digest.*, null),
            .aws => |s| cloud.kms.awsSignDigest(self.allocator, s.transport, s.config, digest.*, s.amz_date),
            .gcp => |s| cloud.kms.gcpSignDigestRetrying(self.allocator, s.transport, s.config, digest.*),
        };
    }
    /// Identity stays pinned to the resolved canonical key; changing an alias or
    /// endpoint requires constructing a new signer, never silently rotating it.
    pub fn refresh(self: *DigestSigner, credentials: Credentials) !void {
        switch (self.backend) {
            .local => {},
            .aws => |*s| {
                const auth = credentials.aws orelse return error.MissingAwsCredentialLease;
                s.transport = credentials.transport;
                s.config.credentials = auth;
                s.amz_date = credentials.amz_date;
            },
            .gcp => |*s| {
                const token = credentials.gcp_bearer orelse return error.MissingGcpCredentialLease;
                s.transport = credentials.transport;
                s.config.bearer_token = token;
                s.config.quota_project = credentials.gcp_quota_project;
            },
        }
    }
    pub fn deinit(self: *DigestSigner) void {
        if (self.backend == .local) std.crypto.secureZero(u8, &self.backend.local);
        self.arena.deinit();
        const a = self.allocator;
        self.* = undefined;
        a.destroy(self);
    }
};

fn noNetwork(_: *anyopaque, _: std.mem.Allocator, _: cloud.http.Request) anyerror!cloud.http.Response {
    return error.UnexpectedNetwork;
}
test "digest signer owns local identity and signs arbitrary raw digests without network" {
    var unused: u8 = 0;
    const credentials: Credentials = .{ .transport = .{ .context = &unused, .send_fn = noNetwork }, .amz_date = "20261105T120000Z" };
    const s = try DigestSigner.open(std.testing.allocator, .{ .hex_key = .{0x11} ** 32 }, credentials);
    defer s.deinit();
    const digest: [32]u8 = .{0xa5} ** 32;
    const sig = try s.signDigest(&digest);
    try std.testing.expectEqualSlices(u8, &s.address, &try signature.recover(digest, sig));
    const public = try cloud.kms.PublicKey.fromSec1(&s.public_key);
    try std.testing.expectEqualSlices(u8, &s.address, &public.address);
    try s.refresh(credentials);
    try std.testing.expectEqualSlices(u8, &sig, &try s.signDigest(&digest));
    try std.testing.expectError(error.UnsupportedDigestSigner, DigestSigner.open(std.testing.allocator, .node, credentials));
    try std.testing.expectError(error.InvalidSecretKey, DigestSigner.open(std.testing.allocator, .{ .hex_key = .{0} ** 32 }, credentials));
    try std.testing.expectError(error.MissingAwsCredentialLease, DigestSigner.open(std.testing.allocator, .{ .aws = .{ .id = "alias/test", .region = "us-east-1" } }, credentials));
    try std.testing.expectError(error.MissingGcpCredentialLease, DigestSigner.open(std.testing.allocator, .{ .gcp = .{ .key_version_name = "test" } }, credentials));
}
