const std = @import("std");
const validator = @import("../validator.zig");
const rocks = @import("../../db/rocks.zig");
const protocol = @import("../../protocol/root.zig");
const objects = @import("../../storage/objects.zig");
const key: validator.Hash = @splat(0x11);
const Fake = struct {
    a: std.mem.Allocator,
    checkpoints: std.AutoHashMap(u32, objects.SignedCheckpoint),
    order: std.array_list.Managed(u32),
    latest: ?u32 = null,
    snapshot: ?objects.Snapshot = null,
    reorged: bool = false,
    fail_latest: bool = false,
    fail_snapshot: bool = false,
    sign_count: usize = 0,
    fn init(a: std.mem.Allocator) Fake {
        return .{ .a = a, .checkpoints = .init(a), .order = .init(a) };
    }
    fn deinit(self: *Fake) void {
        self.checkpoints.deinit();
        self.order.deinit();
    }
    fn sign(ctx: *anyopaque, c: validator.Checkpoint) !objects.SignedCheckpoint {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        self.sign_count += 1;
        return objects.SignedCheckpoint.sign(c, key, null);
    }
    fn readSnapshot(ctx: *anyopaque) !?objects.Snapshot {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        return self.snapshot;
    }
    fn fetch(ctx: *anyopaque, index: u32) !?objects.SignedCheckpoint {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        return self.checkpoints.get(index);
    }
    fn guard(ctx: *anyopaque) !bool {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        return self.reorged;
    }
    fn put(ctx: *anyopaque, s: objects.SignedCheckpoint, _: u64) !void {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        try self.checkpoints.put(s.value.index, s);
        try self.order.append(s.value.index);
    }
    fn latestFn(ctx: *anyopaque, index: u32) !void {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        if (self.fail_latest) return error.InjectedLatestFailure;
        if (self.latest) |old| {
            if (index < old) return error.LatestRegression;
        }
        self.latest = index;
    }
    fn snapshotFn(ctx: *anyopaque, s: *const objects.Snapshot) !void {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        if (self.fail_snapshot) return error.InjectedSnapshotFailure;
        self.snapshot = s.*;
    }
    fn reorg(ctx: *anyopaque, _: objects.ReorgEvent) !void {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        self.reorged = true;
    }
    fn signer(self: *Fake) validator.Signer {
        return .{ .context = self, .sign = sign };
    }
    fn publisher(self: *Fake) validator.Publisher {
        return .{ .context = self, .read_snapshot = readSnapshot, .fetch_checkpoint = fetch, .is_reorged = guard, .write_checkpoint = put, .write_latest = latestFn, .write_snapshot = snapshotFn, .persist_reorg = reorg };
    }
};
fn options(count: usize) !validator.Options {
    return .{ .domain_name = "validator-test", .domain = 9913371, .hook = @splat(0x44), .signer_address = try protocol.signature.secretKeyAddress(key), .endpoint_count = count, .consensus = .majority };
}
fn observe(service: *validator.Service, n: u32) !void {
    for (0..n) |i| {
        var id: validator.Hash = @splat(0);
        std.mem.writeInt(u32, id[0..4], @intCast(i), .big);
        try service.observe(@intCast(i), .{ .message_id = id, .block_height = i + 100, .block_hash = @splat(@truncate(i)) }, n + 100);
    }
}
fn path(a: std.mem.Allocator, temp: *std.testing.TmpDir) ![]u8 {
    const base = try temp.dir.realpathAlloc(a, ".");
    defer a.free(base);
    return std.fs.path.join(a, &.{ base, "db" });
}

test "durable reservation and signature resume latest and snapshot failures latest-first without signing twice" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const p = try path(a, &temp);
    defer a.free(p);
    var db = try rocks.Database.open(a, p, .{});
    var opened = true;
    defer if (opened) db.deinit();
    var service = try validator.Service.open(a, &db, try options(5));
    try observe(&service, 6);
    var fake = Fake.init(a);
    defer fake.deinit();
    const votes = [_]?validator.Checkpoint{ try service.checkpoint(5), try service.checkpoint(4), try service.checkpoint(3), try service.checkpoint(2), null };
    try std.testing.expectEqual(@as(u32, 2), (try service.authorize(&votes, 123)).?.index);
    try std.testing.expectEqual(@as(u32, 3), service.nextVerificationIndex());
    fake.fail_latest = true;
    try std.testing.expectError(error.InjectedLatestFailure, service.publishNext(fake.signer(), fake.publisher(), 123, 1));
    try std.testing.expectEqual(@as(usize, 1), fake.sign_count);
    try std.testing.expectEqual(@as(?u32, null), service.latest_published);
    try std.testing.expect(try service.hasPendingPublication());
    db.deinit();
    opened = false;
    db = try rocks.Database.open(a, p, .{ .create_if_missing = false });
    opened = true;
    service = try validator.Service.open(a, &db, try options(5));
    try std.testing.expectEqual(@as(u32, 2), (try service.reservation()).?.index);
    fake.fail_latest = false;
    try std.testing.expectEqual(@as(usize, 1), try service.publishNext(fake.signer(), fake.publisher(), 124, 1));
    try std.testing.expectEqual(@as(?objects.Snapshot, null), fake.snapshot);
    try std.testing.expectEqual(@as(usize, 1), fake.sign_count);
    try std.testing.expectError(error.FreshAuthorizationRequired, service.publishNext(fake.signer(), fake.publisher(), 125, 64));
    _ = try service.authorize(&votes, 125);
    try std.testing.expectEqual(@as(usize, 1), try service.publishNext(fake.signer(), fake.publisher(), 126, 1));
    fake.fail_snapshot = true;
    try std.testing.expectError(error.InjectedSnapshotFailure, service.publishNext(fake.signer(), fake.publisher(), 127, 1));
    try std.testing.expectEqual(@as(usize, 3), fake.sign_count);
    try std.testing.expect(try service.hasPendingPublication());
    fake.fail_snapshot = false;
    try std.testing.expectEqual(@as(usize, 1), try service.publishNext(fake.signer(), fake.publisher(), 128, 1));
    try std.testing.expectEqual(@as(usize, 3), fake.sign_count);
    try std.testing.expectEqual(@as(u32, 2), fake.order.items[0]);
    try std.testing.expectEqual(@as(u32, 0), fake.order.items[fake.order.items.len - 1]);
    try std.testing.expectEqual(@as(?u32, 2), fake.latest);
    try std.testing.expectEqual(@as(u32, 2), fake.snapshot.?.index);
    try std.testing.expectEqual(@as(usize, 0), try service.publishNext(fake.signer(), fake.publisher(), 127, 64));
    try std.testing.expect(!try service.hasPendingPublication());
}
test "configured vote denominator retains failures and conflicts below signed watermark persist fatal guard" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const p = try path(a, &temp);
    defer a.free(p);
    var db = try rocks.Database.open(a, p, .{});
    defer db.deinit();
    var service = try validator.Service.open(a, &db, try options(4));
    try observe(&service, 3);
    const c = try service.checkpoint(2);
    try std.testing.expectEqual(@as(?validator.Checkpoint, null), try service.authorize(&.{ c, c, null, null }, 100));
    try std.testing.expectEqual(@as(?u32, null), service.verified_through);
    _ = try service.authorize(&.{ c, c, c, null }, 101);
    var fake = Fake.init(a);
    defer fake.deinit();
    _ = try service.publishNext(fake.signer(), fake.publisher(), 102, 1);
    var conflict = try service.checkpoint(0);
    conflict.root = @splat(0xee);
    try std.testing.expectError(error.FinalizedHistoryConflict, service.authorize(&.{ conflict, conflict, conflict, null }, 103));
    var replay = try validator.Service.open(a, &db, try options(4));
    try std.testing.expect(replay.halted);
    try std.testing.expectError(error.ValidatorHalted, replay.publishNext(fake.signer(), fake.publisher(), 104, 1));
    try std.testing.expect(fake.reorged);
}
test "preexisting same signer conflicting remote checkpoint prevents signature and survives reopen" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const p = try path(a, &temp);
    defer a.free(p);
    var db = try rocks.Database.open(a, p, .{});
    defer db.deinit();
    var service = try validator.Service.open(a, &db, try options(1));
    try observe(&service, 1);
    const c = try service.checkpoint(0);
    _ = try service.authorize(&.{c}, 100);
    var fake = Fake.init(a);
    defer fake.deinit();
    var wrong = c;
    wrong.root = @splat(0xee);
    try fake.checkpoints.put(0, try objects.SignedCheckpoint.sign(wrong, key, null));
    try std.testing.expectError(error.FinalizedHistoryConflict, service.publishNext(fake.signer(), fake.publisher(), 101, 1));
    try std.testing.expectEqual(@as(usize, 0), fake.sign_count);
    try std.testing.expect(fake.reorged);
    const replay = try validator.Service.open(a, &db, try options(1));
    try std.testing.expect(replay.halted);
}
test "history exceeds in-memory model capacities and publication tick stays bounded" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const p = try path(a, &temp);
    defer a.free(p);
    var db = try rocks.Database.open(a, p, .{});
    defer db.deinit();
    var service = try validator.Service.open(a, &db, try options(1));
    try observe(&service, 137);
    _ = try service.authorize(&.{try service.checkpoint(136)}, 100);
    var fake = Fake.init(a);
    defer fake.deinit();
    try std.testing.expectEqual(@as(usize, 64), try service.publishNext(fake.signer(), fake.publisher(), 101, 64));
    try std.testing.expectEqual(@as(usize, 64), try service.publishNext(fake.signer(), fake.publisher(), 102, 64));
    try std.testing.expectEqual(@as(usize, 9), try service.publishNext(fake.signer(), fake.publisher(), 103, 64));
    try std.testing.expectEqual(@as(usize, 137), fake.checkpoints.count());
    try std.testing.expectEqual(@as(u32, 136), fake.order.items[0]);
    try std.testing.expectEqual(@as(u32, 0), fake.order.items[136]);
}
test "actual durable local checkpoint publisher latest-first snapshot and restart authentication" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const p = try path(a, &temp);
    defer a.free(p);
    var db = try rocks.Database.open(a, p, .{});
    defer db.deinit();
    const opts = try options(1);
    var service = try validator.Service.open(a, &db, opts);
    try observe(&service, 4);
    const LocalStore = @import("../../storage/local.zig").LocalStore;
    var store = try LocalStore.open(a, temp.dir, "checkpoints", .{ .read_only = false, .signer = opts.signer_address });
    defer store.deinit();
    var publisher: validator.LocalPublisher = .{ .store = &store };
    var signer: validator.LocalSigner = .{ .key = key };
    _ = try service.authorize(&.{try service.checkpoint(3)}, 100);
    try std.testing.expectEqual(@as(usize, 1), try service.publishNext(signer.interface(), publisher.interface(), 101, 1));
    try std.testing.expectEqual(@as(?u32, 3), try store.latestIndex());
    try std.testing.expectEqual(@as(?objects.SignedCheckpoint, null), try store.fetchCheckpoint(0));
    try std.testing.expectEqual(@as(usize, 3), try service.publishNext(signer.interface(), publisher.interface(), 102, 64));
    for (0..4) |i| {
        const signed = (try store.fetchCheckpoint(@intCast(i))).?;
        try std.testing.expectEqualSlices(u8, &opts.signer_address, &try signed.recover());
    }
    const restored = (try store.readAuthenticatedSnapshot(opts.signer_address, opts.domain, opts.hook)).?;
    try std.testing.expectEqual(@as(u32, 4), restored.count);
    try std.testing.expectEqualSlices(u8, &service.tree.root(), &restored.root());
    var replay = try validator.Service.open(a, &db, opts);
    try std.testing.expectEqual(@as(usize, 0), try replay.publishNext(signer.interface(), publisher.interface(), 103, 64));
}
const Polling = struct {
    checkpoint_value: validator.Checkpoint,
    successful: usize = 3,
    fn height(_: *anyopaque, _: objects.ReorgPeriod) !u64 {
        return 1000;
    }
    fn insertion(_: *anyopaque, index: u32, _: u64) !?validator.Observation {
        var id: validator.Hash = @splat(0);
        std.mem.writeInt(u32, id[0..4], index, .big);
        return .{ .message_id = id, .block_height = index + 100, .block_hash = @splat(@truncate(index)) };
    }
    fn checkpointFn(ctx: *anyopaque, slot: usize, _: objects.ReorgPeriod) !?validator.Checkpoint {
        const self: *Polling = @ptrCast(@alignCast(ctx));
        if (slot >= self.successful) return error.InjectedUnavailable;
        return self.checkpoint_value;
    }
};
test "bounded driver replays 64 observations and retains unavailable configured endpoint slots" {
    const driver = @import("driver.zig");
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const p = try path(a, &temp);
    defer a.free(p);
    var db = try rocks.Database.open(a, p, .{});
    defer db.deinit();
    const opts = try options(4);
    var service = try validator.Service.open(a, &db, opts);
    var tree = protocol.IncrementalMerkle.init();
    for (0..137) |i| {
        var id: validator.Hash = @splat(0);
        std.mem.writeInt(u32, id[0..4], @intCast(i), .big);
        try tree.ingest(id);
    }
    var polling: Polling = .{ .checkpoint_value = .{ .mailbox_domain = opts.domain, .merkle_tree_hook_address = opts.hook, .root = tree.root(), .index = 136, .message_id = @splat(0) } };
    const source: driver.Source = .{ .context = &polling, .finalized_height = Polling.height, .insertion = Polling.insertion, .checkpoint = Polling.checkpointFn };
    var fake = Fake.init(a);
    defer fake.deinit();
    const first = try driver.tick(&service, source, fake.signer(), fake.publisher(), 100, .{});
    try std.testing.expectEqual(@as(usize, 64), first.observed);
    try std.testing.expectEqual(@as(usize, 0), first.published);
    try std.testing.expectEqual(@as(usize, 1), first.unavailable_endpoints);
    try std.testing.expect(first.more_observations);
    const second = try driver.tick(&service, source, fake.signer(), fake.publisher(), 101, .{});
    try std.testing.expectEqual(@as(usize, 64), second.observed);
    try std.testing.expectEqual(@as(usize, 0), second.published);
    const third = try driver.tick(&service, source, fake.signer(), fake.publisher(), 102, .{});
    try std.testing.expectEqual(@as(usize, 9), third.observed);
    try std.testing.expectEqual(@as(usize, 32), third.published);
    try std.testing.expectEqual(@as(?u32, 136), fake.latest);
    polling.successful = 2;
    const outage = try driver.tick(&service, source, fake.signer(), fake.publisher(), 103, .{});
    try std.testing.expectEqual(@as(usize, 0), outage.published);
    try std.testing.expectEqual(@as(usize, 32), fake.sign_count);
}
const CloudProbe = struct {
    expected: validator.Hash,
    calls: usize = 0,
    fn send(ctx: *anyopaque, a: std.mem.Allocator, r: @import("../../cloud/http.zig").Request) !@import("../../cloud/http.zig").Response {
        const self: *CloudProbe = @ptrCast(@alignCast(ctx));
        self.calls += 1;
        if (r.method == .POST) {
            var encoded: [44]u8 = undefined;
            const b64 = std.base64.standard.Encoder.encode(&encoded, &self.expected);
            try std.testing.expect(std.mem.indexOf(u8, r.body.?, b64) != null);
            return .{ .allocator = a, .bytes = try a.dupe(u8, "{}"), .status = 500 };
        }
        return .{ .allocator = a, .bytes = try a.dupe(u8, ""), .status = 404 };
    }
};
test "cloud signer adapters submit exact EIP191 digest and publisher missing reads use injected transport" {
    const adapters = @import("cloud.zig");
    const cloud = @import("../../cloud/root.zig");
    const a = std.testing.allocator;
    const c: validator.Checkpoint = .{ .mailbox_domain = 9913371, .merkle_tree_hook_address = @splat(0x44), .root = @splat(0x55), .index = 7, .message_id = @splat(0x66) };
    var probe: CloudProbe = .{ .expected = c.digest() };
    const transport: cloud.http.Transport = .{ .context = &probe, .send_fn = CloudProbe.send };
    const point = try std.crypto.ecc.Secp256k1.basePoint.mul(key, .big);
    const public = try cloud.kms.PublicKey.fromSec1(&point.toUncompressedSec1());
    var aws: adapters.AwsSigner = .{ .allocator = a, .transport = transport, .config = .{ .endpoint = "https://kms.us-east-1.amazonaws.com", .region = "us-east-1", .credentials = .{ .access_key_id = "PUBLICFIXTURE", .secret_access_key = "public-fixture" }, .key_id = "alias/public-fixture", .expected_key_arn = "arn:aws:kms:us-east-1:123456789012:key/public-fixture", .public_key = public }, .amz_date = "20261105T120000Z" };
    const ai = aws.interface();
    try std.testing.expectError(error.KmsHttpStatus, ai.sign(ai.context, c));
    var gcp: adapters.GcpSigner = .{ .allocator = a, .transport = transport, .config = .{ .key_version_name = "projects/fixture/locations/global/keyRings/fixture/cryptoKeys/fixture/cryptoKeyVersions/1", .bearer_token = "public-fixture", .public_key = public } };
    const gi = gcp.interface();
    try std.testing.expectError(error.KmsHttpStatus, gi.sign(gi.context, c));
    var store = try cloud.storage.Store.init(a, transport, .{ .gcs = .{ .bucket = "public-fixture", .bearer_token = "public-fixture" } }, .{ .read_only = false, .signer = public.address });
    var publisher: adapters.Publisher = .{ .store = &store, .amz_date = "20261105T120000Z" };
    const pi = publisher.interface();
    try std.testing.expect(!try pi.is_reorged(pi.context));
    try std.testing.expectEqual(@as(?objects.SignedCheckpoint, null), try pi.fetch_checkpoint(pi.context, 7));
    try std.testing.expect(probe.calls >= 4);
}
fn seededHistory(fake: *Fake, opts: validator.Options, n: u32, holes: []const u32) !void {
    var tree = protocol.IncrementalMerkle.init();
    for (0..n) |i| {
        var id: validator.Hash = @splat(0);
        std.mem.writeInt(u32, id[0..4], @intCast(i), .big);
        try tree.ingest(id);
        const checkpoint: validator.Checkpoint = .{ .mailbox_domain = opts.domain, .merkle_tree_hook_address = opts.hook, .root = tree.root(), .index = @intCast(i), .message_id = id };
        var missing = false;
        for (holes) |hole| {
            if (hole == i) missing = true;
        }
        if (!missing) try fake.checkpoints.put(@intCast(i), try objects.SignedCheckpoint.sign(checkpoint, key, null));
    }
    fake.snapshot = try objects.Snapshot.capture(&tree);
    fake.latest = n - 1;
}
test "remote snapshot resumes live indexing while bounded durable prefix repair finds and signs historical holes only after anchor authentication" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const p = try path(a, &temp);
    defer a.free(p);
    var db = try rocks.Database.open(a, p, .{});
    var opened = true;
    defer if (opened) db.deinit();
    const opts = try options(1);
    var fake = Fake.init(a);
    defer fake.deinit();
    try seededHistory(&fake, opts, 5, &.{ 1, 3 });
    var service = try validator.Service.open(a, &db, opts);
    try std.testing.expect(try service.bootstrap(fake.publisher()));
    try std.testing.expectEqual(@as(u32, 5), service.tree.count);
    try std.testing.expect(!service.repair_complete);
    try std.testing.expect(try service.hasPendingPublication());
    try std.testing.expectEqual(@as(?u32, null), service.snapshot_through);
    try std.testing.expect(try service.authenticateStoredHistory(0, fake.publisher()));
    try std.testing.expect(!try service.authenticateStoredHistory(1, fake.publisher()));
    const next = (try Polling.insertion(&fake, 5, 1000)).?;
    try service.observe(5, next, 1000);
    _ = try service.authorize(&.{try service.checkpoint(5)}, 100);
    try std.testing.expectEqual(@as(usize, 1), try service.publishNext(fake.signer(), fake.publisher(), 101, 1));
    try std.testing.expectEqual(@as(u32, 4), fake.snapshot.?.index);
    try std.testing.expectEqual(@as(usize, 2), try service.repairHistory(fake.publisher(), &fake, Polling.insertion, 1000, 2, 102));
    try std.testing.expect(!service.repair_complete);
    try std.testing.expectEqual(@as(usize, 0), try service.publishNext(fake.signer(), fake.publisher(), 103, 64));
    try std.testing.expectEqual(@as(usize, 1), fake.sign_count);
    db.deinit();
    opened = false;
    db = try rocks.Database.open(a, p, .{ .create_if_missing = false });
    opened = true;
    service = try validator.Service.open(a, &db, opts);
    try std.testing.expectEqual(@as(u32, 6), service.tree.count);
    try std.testing.expect(!service.repair_complete);
    try std.testing.expectEqual(@as(usize, 3), try service.repairHistory(fake.publisher(), &fake, Polling.insertion, 1000, 64, 104));
    try std.testing.expect(service.repair_complete);
    try std.testing.expectError(error.FreshAuthorizationRequired, service.publishNext(fake.signer(), fake.publisher(), 105, 64));
    _ = try service.authorize(&.{try service.checkpoint(5)}, 106);
    try std.testing.expectEqual(@as(usize, 2), try service.publishNext(fake.signer(), fake.publisher(), 107, 64));
    try std.testing.expectEqual(@as(usize, 3), fake.sign_count);
    try std.testing.expectEqual(@as(usize, 6), fake.checkpoints.count());
    try std.testing.expectEqual(@as(u32, 5), fake.snapshot.?.index);
    try std.testing.expectEqual(@as(?u32, 5), service.snapshot_through);
    try std.testing.expect(!try service.hasPendingPublication());
}
test "remote snapshot tampering wrong signer and durable backend guard never seed a signing frontier" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const p = try path(a, &temp);
    defer a.free(p);
    var db = try rocks.Database.open(a, p, .{});
    defer db.deinit();
    const opts = try options(1);
    var fake = Fake.init(a);
    defer fake.deinit();
    try seededHistory(&fake, opts, 3, &.{});
    var service = try validator.Service.open(a, &db, opts);
    fake.snapshot.?.root[0] ^= 1;
    try std.testing.expectError(error.SnapshotCheckpointMismatch, service.bootstrap(fake.publisher()));
    try std.testing.expectEqual(@as(u32, 0), service.tree.count);
    fake.snapshot.?.root[0] ^= 1;
    const c = fake.checkpoints.get(2).?.value;
    try fake.checkpoints.put(2, try objects.SignedCheckpoint.sign(c, @splat(0x22), null));
    try std.testing.expectError(error.SnapshotSignerMismatch, service.bootstrap(fake.publisher()));
    try std.testing.expectEqual(@as(u32, 0), service.tree.count);
    fake.reorged = true;
    try std.testing.expectError(error.ValidatorHalted, service.bootstrap(fake.publisher()));
    const replay = try validator.Service.open(a, &db, opts);
    try std.testing.expect(replay.halted);
    try std.testing.expectEqual(@as(usize, 0), fake.sign_count);
}
test "snapshot prefix repair never signs RPC holes whose replay conflicts with the authenticated anchor" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const p = try path(a, &temp);
    defer a.free(p);
    var db = try rocks.Database.open(a, p, .{});
    defer db.deinit();
    const opts = try options(1);
    var fake = Fake.init(a);
    defer fake.deinit();
    try seededHistory(&fake, opts, 3, &.{1});
    var wrong = fake.checkpoints.get(0).?.value;
    wrong.root = @splat(0xee);
    try fake.checkpoints.put(0, try objects.SignedCheckpoint.sign(wrong, key, null));
    var service = try validator.Service.open(a, &db, opts);
    _ = try service.bootstrap(fake.publisher());
    try std.testing.expectError(error.FinalizedHistoryConflict, service.repairHistory(fake.publisher(), &fake, Polling.insertion, 1000, 64, 100));
    try std.testing.expectEqual(@as(usize, 0), fake.sign_count);
    const replay = try validator.Service.open(a, &db, opts);
    try std.testing.expect(replay.halted);
}
fn noCloud(_: *anyopaque, _: std.mem.Allocator, _: @import("../../cloud/http.zig").Request) anyerror!@import("../../cloud/http.zig").Response {
    return error.UnexpectedCloudRequest;
}
test "typed local validator factory and operational EVM role canonicalize slots and wire bounded cancellation without reading credentials" {
    const settings_module = @import("../../settings/root.zig");
    const factory = @import("config.zig");
    const evm = @import("evm.zig");
    const a = std.testing.allocator;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const scratch = arena.allocator();
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const base = try temp.dir.realpathAlloc(scratch, ".");
    const checkpoint_path = try std.fs.path.join(scratch, &.{ base, "checkpoints" });
    const key_hex = try @import("../../evm/codecs.zig").hexAlloc(scratch, &key);
    const contracts = "0x0000000000000000000000000000000000000001";
    const conf = .{ .originChainName = "test1", .validator = .{ .key = key_hex }, .checkpointSyncer = .{ .type = "localStorage", .path = checkpoint_path }, .skipAnnounce = true, .chains = .{ .test1 = .{ .name = "test1", .domainId = 9913371, .chainId = 31337, .protocol = "ethereum", .rpcUrls = &.{ .{ .http = "http://127.0.0.1:9" }, .{ .http = "http://127.0.0.1:9/" } }, .mailbox = contracts, .validatorAnnounce = contracts, .merkleTreeHook = contracts, .interchainGasPaymaster = contracts } } };
    try temp.dir.writeFile(.{ .sub_path = "config.json", .data = try std.json.Stringify.valueAlloc(scratch, conf, .{}) });
    var s = try settings_module.Settings.load(a, .validator, .{ .defaults_dir = base });
    defer s.deinit();
    var probe: u8 = 0;
    const credentials: factory.Credentials = .{ .transport = .{ .context = &probe, .send_fn = noCloud }, .amz_date = "20261105T120000Z" };
    const resources = try factory.Resources.open(a, &s, credentials);
    defer resources.deinit();
    try std.testing.expectEqualSlices(u8, &try @import("../../protocol/signature.zig").secretKeyAddress(key), &resources.signer_address);
    try resources.refresh(credentials);
    const db_path = try path(a, &temp);
    defer a.free(db_path);
    var db = try rocks.Database.open(a, db_path, .{});
    defer db.deinit();
    const role = try evm.Role.open(a, &s, &db, .{ .allow_std_transport_for_tests = true, .signer = resources.signer(), .signer_address = resources.signer_address, .publisher = resources.publisher(), .storage_location = resources.storage_location });
    defer role.deinit();
    try std.testing.expectEqual(@as(usize, 1), role.slots.len);
    try std.testing.expectEqual(@as(usize, 1), role.state.options.endpoint_count);
    var cancel = std.atomic.Value(bool).init(true);
    role.setCancellation(&cancel);
    try std.testing.expectError(error.Cancelled, role.tick(100, 100));
    const announcement: objects.Announcement = .{ .validator = resources.signer_address, .mailbox_address = s.chains[0].contracts.mailbox, .mailbox_domain = s.chains[0].domain, .storage_location = resources.storage_location };
    const signed: objects.SignedAnnouncement = .{ .value = announcement, .signature = objects.Signature.fromBytes(try resources.signer().digest(announcement.digest())) };
    const publisher = resources.publisher();
    try publisher.write_announcement.?(publisher.context, signed);
    try std.testing.expectEqualSlices(u8, &resources.signer_address, &try signed.recover());
}
test "native unsigned suffix rollback preserves committed signed prefix and survives reopen with no duplicate signature" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const p = try path(a, &temp);
    defer a.free(p);
    var db = try rocks.Database.open(a, p, .{});
    var opened = true;
    defer if (opened) db.deinit();
    const opts = try options(1);
    var service = try validator.Service.open(a, &db, opts);
    try observe(&service, 1);
    _ = try service.authorize(&.{try service.checkpoint(0)}, 100);
    var fake = Fake.init(a);
    defer fake.deinit();
    _ = try service.publishNext(fake.signer(), fake.publisher(), 101, 64);
    try service.observe(1, .{ .message_id = @splat(0xee), .block_height = 101, .block_hash = @splat(1) }, 1000);
    try service.observe(2, .{ .message_id = @splat(0xdd), .block_height = 102, .block_hash = @splat(2) }, 1000);
    try std.testing.expect(try service.resetUnverifiedSuffix());
    try std.testing.expectEqual(@as(u32, 1), service.tree.count);
    try std.testing.expectEqual(@as(?u32, 0), service.latest_published);
    try std.testing.expectEqual(@as(?u32, 0), service.signed_watermark);
    try std.testing.expectEqual(@as(usize, 1), fake.sign_count);
    try std.testing.expectError(error.UnknownCheckpoint, service.checkpoint(1));
    db.deinit();
    opened = false;
    db = try rocks.Database.open(a, p, .{ .create_if_missing = false });
    opened = true;
    service = try validator.Service.open(a, &db, opts);
    try std.testing.expectEqual(@as(u32, 1), service.tree.count);
    for (1..3) |i| try service.observe(@intCast(i), (try Polling.insertion(&fake, @intCast(i), 1000)).?, 1000);
    _ = try service.authorize(&.{try service.checkpoint(2)}, 102);
    try std.testing.expectEqual(@as(usize, 2), try service.publishNext(fake.signer(), fake.publisher(), 103, 64));
    try std.testing.expectEqual(@as(usize, 3), fake.sign_count);
}
test "RPC-authenticated committed prefix conflict halts even when signer never completed" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const p = try path(a, &temp);
    defer a.free(p);
    var db = try rocks.Database.open(a, p, .{});
    defer db.deinit();
    const opts = try options(1);
    var service = try validator.Service.open(a, &db, opts);
    try observe(&service, 1);
    _ = try service.authorize(&.{try service.checkpoint(0)}, 100);
    try std.testing.expect(service.signed_watermark == null);
    try std.testing.expectError(error.FinalizedHistoryConflict, service.verifyCommitted(0, @splat(0xee), 101));
    const replay = try validator.Service.open(a, &db, opts);
    try std.testing.expect(replay.halted);
}
test "same-block provenance change remains recoverable until prefix RPC authorization" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const p = try path(a, &temp);
    defer a.free(p);
    var db = try rocks.Database.open(a, p, .{});
    defer db.deinit();
    var state = try validator.Service.open(a, &db, try options(1));
    const old: validator.Observation = .{ .message_id = @splat(1), .block_height = 10, .block_hash = @splat(2) };
    const next: validator.Observation = .{ .message_id = @splat(3), .block_height = 10, .block_hash = @splat(4) };
    try state.observe(0, old, 20);
    try std.testing.expectError(error.UnverifiedSuffixChanged, state.observe(1, next, 20));
    try std.testing.expect(!state.halted);
    try std.testing.expect(try state.resetUnverifiedSuffix());
    try state.observe(0, old, 20);
    _ = try state.authorize(&.{try state.checkpoint(0)}, 100);
    try std.testing.expectError(error.FinalizedHistoryConflict, state.observe(1, next, 20));
    try std.testing.expect(state.halted);
}
test "checkpoint storage factory uses distinct AWS and GCS leases without granting them to KMS" {
    const factory = @import("config.zig");
    const settings_module = @import("../../settings/root.zig");
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const base = try temp.dir.realpathAlloc(a, ".");
    defer a.free(base);
    const key_hex = try @import("../../evm/codecs.zig").hexAlloc(a, &key);
    defer a.free(key_hex);
    const contract = "0x0000000000000000000000000000000000000001";
    const value = .{ .originChainName = "test1", .validator = .{ .key = key_hex }, .checkpointSyncer = .{ .type = "s3", .bucket = "public-fixture", .region = "us-east-1" }, .chains = .{ .test1 = .{ .name = "test1", .domainId = 9913371, .chainId = 31337, .protocol = "ethereum", .rpcUrls = &.{.{ .http = "http://127.0.0.1:9" }}, .mailbox = contract, .validatorAnnounce = contract, .merkleTreeHook = contract, .interchainGasPaymaster = contract } } };
    const json = try std.json.Stringify.valueAlloc(a, value, .{});
    defer a.free(json);
    try temp.dir.writeFile(.{ .sub_path = "public.json", .data = json });
    var s = try settings_module.Settings.load(a, .validator, .{ .defaults_dir = base });
    defer s.deinit();
    var unused: u8 = 0;
    var credentials: factory.Credentials = .{ .transport = .{ .context = &unused, .send_fn = noCloud }, .amz_date = "20261105T120000Z", .aws_storage = .{ .access_key_id = "public-storage", .secret_access_key = "public-storage-fixture" }, .gcs_bearer = "public-gcs-fixture" };
    const aws = try factory.Resources.open(a, &s, credentials);
    defer aws.deinit();
    try std.testing.expectEqualStrings("public-storage", aws.store.cloud.backend.s3.credentials.?.access_key_id);
    credentials.aws_storage.?.access_key_id = "refreshed-storage";
    try aws.refresh(credentials);
    try std.testing.expectEqualStrings("refreshed-storage", aws.store.cloud.backend.s3.credentials.?.access_key_id);
    s.role.validator.checkpoint_syncer = .{ .gcs = .{ .bucket = "public-fixture", .folder = null, .service_account_key = null, .user_secrets = null, .use_application_default = true } };
    const gcs = try factory.Resources.open(a, &s, credentials);
    defer gcs.deinit();
    try std.testing.expectEqualStrings("public-gcs-fixture", gcs.store.cloud.backend.gcs.bearer_token.?);
    credentials.gcs_bearer = "refreshed-gcs";
    try gcs.refresh(credentials);
    try std.testing.expectEqualStrings("refreshed-gcs", gcs.store.cloud.backend.gcs.bearer_token.?);
    // Storage credentials alone cannot authorize either KMS signer.
    try std.testing.expectError(error.MissingAwsCredentialLease, @import("../signer.zig").DigestSigner.open(a, .{ .aws = .{ .id = "alias/public", .region = "us-east-1" } }, credentials));
    try std.testing.expectError(error.MissingGcpCredentialLease, @import("../signer.zig").DigestSigner.open(a, .{ .gcp = .{ .key_version_name = "public-fixture" } }, credentials));
}

test "unknown stream header hash transitions to canonical RPC within the same block without weakening known header conflict guard" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const p = try path(a, &temp);
    defer a.free(p);
    var db = try rocks.Database.open(a, p, .{});
    defer db.deinit();
    var state = try validator.Service.open(a, &db, try options(1));
    try state.observe(0, .{ .message_id = @splat(1), .block_height = 100, .block_hash = @splat(0) }, 100);
    _ = try state.authorize(&.{try state.checkpoint(0)}, 1);
    try state.observe(0, .{ .message_id = @splat(1), .block_height = 100, .block_hash = @splat(0xaa) }, 100);
    try state.observe(1, .{ .message_id = @splat(2), .block_height = 100, .block_hash = @splat(0xaa) }, 100);
    try std.testing.expect(!state.halted);
    try std.testing.expectEqual(@as(u32, 2), state.tree.count);
    var opts = try options(1);
    opts.domain_name = "known-provenance";
    var known = try validator.Service.open(a, &db, opts);
    try known.observe(0, .{ .message_id = @splat(1), .block_height = 100, .block_hash = @splat(0xaa) }, 100);
    _ = try known.authorize(&.{try known.checkpoint(0)}, 1);
    try std.testing.expectError(error.FinalizedHistoryConflict, known.observe(1, .{ .message_id = @splat(2), .block_height = 100, .block_hash = @splat(0xbb) }, 100));
    try std.testing.expect(known.halted);
}
