//! Operational cloud adapters. Credentials/tokens and current SigV4 date are
//! explicitly injected and borrowed; callers refresh them outside the service.
const std = @import("std");
const service = @import("../validator.zig");
const cloud = @import("../../cloud/root.zig");
const objects = @import("../../storage/objects.zig");
pub const Publisher = struct {
    store: *cloud.storage.Store,
    amz_date: []const u8,
    pub fn interface(self: *Publisher) service.Publisher {
        return .{ .context = self, .write_announcement = announcement, .read_snapshot = readSnapshot, .fetch_checkpoint = fetch, .is_reorged = guard, .write_checkpoint = checkpoint, .write_latest = latest, .write_snapshot = snapshot, .persist_reorg = reorg };
    }
    fn selfOf(ctx: *anyopaque) *Publisher {
        return @ptrCast(@alignCast(ctx));
    }
    fn announcement(ctx: *anyopaque, value: objects.SignedAnnouncement) !void {
        const self = selfOf(ctx);
        try self.store.writeAnnouncement(value, self.amz_date);
    }
    fn readSnapshot(ctx: *anyopaque) !?objects.Snapshot {
        return selfOf(ctx).store.readSnapshot();
    }
    fn fetch(ctx: *anyopaque, index: u32) !?objects.SignedCheckpoint {
        return selfOf(ctx).store.fetchCheckpoint(index);
    }
    fn guard(ctx: *anyopaque) !bool {
        var status = try selfOf(ctx).store.reorgStatus();
        defer status.deinit();
        return status.exists;
    }
    fn checkpoint(ctx: *anyopaque, s: objects.SignedCheckpoint, time: u64) !void {
        const self = selfOf(ctx);
        _ = try self.store.writeCheckpoint(s, time, self.amz_date);
    }
    fn latest(ctx: *anyopaque, index: u32) !void {
        const self = selfOf(ctx);
        try self.store.writeLatestIndex(index, self.amz_date);
    }
    fn snapshot(ctx: *anyopaque, s: *const objects.Snapshot) !void {
        const self = selfOf(ctx);
        try self.store.writeSnapshot(s, self.amz_date);
    }
    fn reorg(ctx: *anyopaque, event: objects.ReorgEvent) !void {
        const self = selfOf(ctx);
        try self.store.persistReorg(event, self.amz_date);
    }
};
pub const AwsSigner = struct {
    allocator: std.mem.Allocator,
    transport: cloud.http.Transport,
    config: cloud.kms.AwsConfig,
    amz_date: []const u8,
    pub fn interface(self: *AwsSigner) service.Signer {
        return .{ .context = self, .sign = sign, .sign_digest = digest };
    }
    fn digest(ctx: *anyopaque, hash: service.Hash) ![65]u8 {
        const self: *AwsSigner = @ptrCast(@alignCast(ctx));
        return cloud.kms.awsSignDigest(self.allocator, self.transport, self.config, hash, self.amz_date);
    }
    fn sign(ctx: *anyopaque, c: service.Checkpoint) !objects.SignedCheckpoint {
        const self: *AwsSigner = @ptrCast(@alignCast(ctx));
        const raw = try cloud.kms.awsSignDigest(self.allocator, self.transport, self.config, c.digest(), self.amz_date);
        return .{ .value = c, .signature = objects.Signature.fromBytes(raw) };
    }
};
pub const GcpSigner = struct {
    allocator: std.mem.Allocator,
    transport: cloud.http.Transport,
    config: cloud.kms.GcpConfig,
    pub fn interface(self: *GcpSigner) service.Signer {
        return .{ .context = self, .sign = sign, .sign_digest = digest };
    }
    fn digest(ctx: *anyopaque, hash: service.Hash) ![65]u8 {
        const self: *GcpSigner = @ptrCast(@alignCast(ctx));
        return cloud.kms.gcpSignDigestRetrying(self.allocator, self.transport, self.config, hash);
    }
    fn sign(ctx: *anyopaque, c: service.Checkpoint) !objects.SignedCheckpoint {
        const self: *GcpSigner = @ptrCast(@alignCast(ctx));
        const raw = try cloud.kms.gcpSignDigestRetrying(self.allocator, self.transport, self.config, c.digest());
        return .{ .value = c, .signature = objects.Signature.fromBytes(raw) };
    }
};
