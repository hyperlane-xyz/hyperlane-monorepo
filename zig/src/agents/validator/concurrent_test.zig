const std = @import("std");
const service = @import("../validator.zig");
const rocks = @import("../../db/rocks.zig");
const local = @import("../../storage/local.zig");
const objects = @import("../../storage/objects.zig");
const signature = @import("../../protocol/signature.zig");
const Signer = struct {
    calls: std.atomic.Value(usize) = .init(0),
    active: std.atomic.Value(usize) = .init(0),
    peak: std.atomic.Value(usize) = .init(0),
    fn sign(ctx: *anyopaque, checkpoint: service.Checkpoint) !service.Verified {
        const self: *Signer = @ptrCast(@alignCast(ctx));
        _ = self.calls.fetchAdd(1, .acq_rel);
        const active = self.active.fetchAdd(1, .acq_rel) + 1;
        defer _ = self.active.fetchSub(1, .acq_rel);
        var previous = self.peak.load(.acquire);
        while (previous < active) {
            if (self.peak.cmpxchgWeak(previous, active, .acq_rel, .acquire)) |actual| previous = actual else break;
        }
        std.Thread.sleep(50 * std.time.ns_per_ms);
        var key = try @import("../../protocol/root.zig").signature.SigningKey.init(@splat(0x11));
        defer key.deinit();
        return service.Verified.signWith(&key, checkpoint, null);
    }
    fn interface(self: *Signer) service.Signer {
        return .{ .parallel_safe = true, .context = self, .sign = sign };
    }
};
const Publisher = struct {
    base: service.Publisher,
    blocked_index: ?u32 = null,
    entered: std.Thread.Semaphore = .{},
    release: std.Thread.Semaphore = .{},
    fail_reorg: std.atomic.Value(bool) = .init(false),
    fail_latest: std.atomic.Value(bool) = .init(false),
    fn cast(ctx: *anyopaque) *Publisher {
        return @ptrCast(@alignCast(ctx));
    }
    fn fetch(ctx: *anyopaque, index: u32) !?objects.SignedCheckpoint {
        const base = cast(ctx).base;
        return base.fetch_checkpoint(base.context, index);
    }
    fn guard(ctx: *anyopaque) !bool {
        const base = cast(ctx).base;
        return base.is_reorged(base.context);
    }
    fn checkpoint(ctx: *anyopaque, signed: service.Verified, time: u64) !void {
        const self = cast(ctx);
        if (self.blocked_index == signed.signed.value.index) {
            self.entered.post();
            self.release.wait();
        }
        try self.base.write_checkpoint(self.base.context, signed, time);
    }
    fn latest(ctx: *anyopaque, index: u32) !void {
        const self = cast(ctx);
        if (self.fail_latest.swap(false, .acq_rel)) return error.InjectedLatestFailure;
        try self.base.write_latest(self.base.context, index);
    }
    fn snapshot(ctx: *anyopaque, value: *const objects.Snapshot) !void {
        const base = cast(ctx).base;
        try base.write_snapshot(base.context, value);
    }
    fn reorg(ctx: *anyopaque, value: objects.ReorgEvent) !void {
        if (cast(ctx).fail_reorg.swap(false, .acq_rel)) return error.InjectedGuardBackendFailure;
        const base = cast(ctx).base;
        try base.persist_reorg(base.context, value);
    }
    fn interface(self: *Publisher) service.Publisher {
        return .{ .parallel_safe = true, .context = self, .fetch_checkpoint = fetch, .is_reorged = guard, .write_checkpoint = checkpoint, .write_latest = latest, .write_snapshot = snapshot, .persist_reorg = reorg };
    }
};
fn observe(state: *service.Service, start: u32, end: u32) !void {
    for (start..end) |index| {
        var id: [32]u8 = @splat(0);
        std.mem.writeInt(u32, id[0..4], @intCast(index), .big);
        try state.observe(@intCast(index), .{ .message_id = id, .block_height = 1, .block_hash = @splat(1) }, 1);
    }
    _ = try state.authorize(&.{try state.checkpoint(end - 1)}, 100);
}
test "concurrent native publication bound latest-first covering snapshot and failed-latest restart never resigns" {
    const a = std.testing.allocator;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const directory = try temporary.dir.realpathAlloc(a, ".");
    defer a.free(directory);
    const db_path = try std.fs.path.join(a, &.{ directory, "db" });
    defer a.free(db_path);
    const object_path = try std.fs.path.join(a, &.{ directory, "objects" });
    defer a.free(object_path);
    var database = try rocks.Database.open(a, db_path, .{});
    defer database.deinit();
    const address = try signature.secretKeyAddress(@splat(0x11));
    const options: service.Options = .{ .domain_name = "concurrent-fixture", .domain = 3999999999, .hook = @splat(2), .signer_address = address, .endpoint_count = 1, .consensus = null };
    var state = try service.Service.open(a, &database, options);
    defer state.deinit();
    var store = try local.LocalStore.open(a, std.fs.cwd(), object_path, .{ .read_only = false, .signer = address });
    defer store.deinit();
    var adapter: service.LocalPublisher = .{ .store = &store };
    var publisher: Publisher = .{ .base = adapter.interface(), .blocked_index = 4 };
    var signer: Signer = .{};
    try observe(&state, 0, 8);
    const Coordinator = struct {
        state: *service.Service,
        signer: service.Signer,
        publisher: service.Publisher,
        result: ?(anyerror!usize) = null,
        fn run(self: *@This()) void {
            self.result = self.state.publishConcurrent(self.signer, self.publisher, 100, 4);
        }
    };
    var coordinator: Coordinator = .{ .state = &state, .signer = signer.interface(), .publisher = publisher.interface() };
    const thread = try std.Thread.spawn(.{}, Coordinator.run, .{&coordinator});
    var joined = false;
    defer if (!joined) {
        publisher.release.post();
        thread.join();
    };
    try publisher.entered.timedWait(10 * std.time.ns_per_s);
    // Serial/singleton entry points cannot bypass the active batch reservation
    // owner while its signer callbacks are outside the service mutex.
    try std.testing.expectError(error.PublicationAlreadyRunning, state.publishNext(signer.interface(), publisher.interface(), 100, 1));
    try std.testing.expectError(error.PublicationAlreadyRunning, state.publishConcurrent(signer.interface(), publisher.interface(), 100, 1));
    var available = false;
    for (0..1000) |_| {
        if (try store.latestIndex() == 7) {
            available = true;
            break;
        }
        std.Thread.sleep(std.time.ns_per_ms);
    }
    const lower_absent = try store.fetchCheckpoint(4) == null;
    const snapshot_absent = try store.readSnapshot() == null;
    publisher.release.post();
    thread.join();
    joined = true;
    try std.testing.expect(available and lower_absent and snapshot_absent);
    try std.testing.expectEqual(@as(usize, 4), try coordinator.result.?);
    try std.testing.expect(signer.peak.load(.acquire) >= 2 and signer.peak.load(.acquire) <= 4);
    publisher.blocked_index = null;
    // Workers persist across batches; threads are only added up to the
    // batch's need and the configured limit, never respawned.
    const workers = state.publication_workers.?;
    const threads = workers.threadCount();
    try std.testing.expect(threads >= 2 and threads <= 4);
    try std.testing.expectEqual(@as(usize, 4), try state.publishConcurrent(signer.interface(), publisher.interface(), 101, 4));
    try std.testing.expectEqual(workers, state.publication_workers.?);
    try std.testing.expect(workers.threadCount() >= threads and workers.threadCount() <= 4);
    try std.testing.expectEqual(@as(usize, 8), signer.calls.load(.acquire));
    try std.testing.expectEqual(@as(?u32, 7), state.snapshot_through);
    try observe(&state, 8, 12);
    publisher.fail_latest.store(true, .release);
    try std.testing.expectError(error.InjectedLatestFailure, state.publishConcurrent(signer.interface(), publisher.interface(), 102, 4));
    try std.testing.expectEqual(@as(usize, 12), signer.calls.load(.acquire));
    state.deinit();
    database.deinit();
    database = try rocks.Database.open(a, db_path, .{});
    state = try service.Service.open(a, &database, options);
    try std.testing.expect(state.fresh_verified_through == null);
    try std.testing.expectEqual(@as(usize, 1), try state.publishConcurrent(signer.interface(), publisher.interface(), 103, 4));
    try std.testing.expectEqual(@as(usize, 12), signer.calls.load(.acquire));
    try std.testing.expectEqual(@as(?u32, 11), state.latest_published);
    try std.testing.expectEqual(@as(?u32, 11), state.snapshot_through);
}

test "guard precommit and ambiguous postcommit failures retain event retry fsync gate effects and reopen halted" {
    const a = std.testing.allocator;
    for (0..2) |mode| {
        var temporary = std.testing.tmpDir(.{});
        defer temporary.cleanup();
        const directory = try temporary.dir.realpathAlloc(a, ".");
        defer a.free(directory);
        const db_path = try std.fs.path.join(a, &.{ directory, "db" });
        defer a.free(db_path);
        const object_path = try std.fs.path.join(a, &.{ directory, "objects" });
        defer a.free(object_path);
        var database = try rocks.Database.open(a, db_path, .{});
        defer database.deinit();
        const address = try signature.secretKeyAddress(@splat(0x11));
        var effects_halted: std.atomic.Value(bool) = .init(false);
        const options: service.Options = .{ .domain_name = "guard-fixture", .domain = 3999999999, .hook = @splat(2), .signer_address = address, .endpoint_count = 1, .consensus = null, .halt_signal = &effects_halted, .reorg_period = .{ .tag = "finalized" } };
        var state = try service.Service.open(a, &database, options);
        defer state.deinit();
        var store = try local.LocalStore.open(a, std.fs.cwd(), object_path, .{ .read_only = false, .signer = address });
        defer store.deinit();
        var adapter: service.LocalPublisher = .{ .store = &store };
        var publisher: Publisher = .{ .base = adapter.interface() };
        var signer: Signer = .{};
        try observe(&state, 0, 1);
        try std.testing.expectEqual(@as(usize, 1), try state.publishConcurrent(signer.interface(), publisher.interface(), 100, 1));
        service.TestGuardFault.attempts.store(0, .release);
        if (mode == 0) service.TestGuardFault.before.store(true, .release) else service.TestGuardFault.after.store(true, .release);
        try std.testing.expectError(error.ReorgGuardPersistencePending, state.verifyCommitted(0, @splat(0xee), 101));
        try std.testing.expect(state.halted and effects_halted.load(.acquire) and state.hasUnpersistedGuard());
        try std.testing.expectError(error.ValidatorHalted, state.publishConcurrent(signer.interface(), publisher.interface(), 102, 2));
        publisher.fail_reorg.store(true, .release);
        try std.testing.expectError(error.ReorgGuardPersistencePending, state.publishReorg(publisher.interface()));
        try std.testing.expect(state.hasUnpersistedGuard());
        try std.testing.expectEqual(@as(usize, 2), service.TestGuardFault.attempts.load(.acquire));
        try state.publishReorg(publisher.interface());
        try std.testing.expect(!state.hasUnpersistedGuard());
        try std.testing.expect(try publisher.base.is_reorged(publisher.base.context));
        state.deinit();
        database.deinit();
        database = try rocks.Database.open(a, db_path, .{});
        effects_halted.store(false, .release);
        state = try service.Service.open(a, &database, options);
        try std.testing.expect(state.halted and effects_halted.load(.acquire));
        try std.testing.expectError(error.ValidatorHalted, state.publishConcurrent(signer.interface(), publisher.interface(), 103, 1));
        try std.testing.expectEqual(@as(usize, 1), signer.calls.load(.acquire));
    }
}

test "in-process key and files publish a batch on the caller without helper threads" {
    const a = std.testing.allocator;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const directory = try temporary.dir.realpathAlloc(a, ".");
    defer a.free(directory);
    const db_path = try std.fs.path.join(a, &.{ directory, "db" });
    defer a.free(db_path);
    const object_path = try std.fs.path.join(a, &.{ directory, "objects" });
    defer a.free(object_path);
    var database = try rocks.Database.open(a, db_path, .{});
    defer database.deinit();
    const address = try signature.secretKeyAddress(@splat(0x11));
    const options: service.Options = .{ .domain_name = "inline-fixture", .domain = 3999999999, .hook = @splat(2), .signer_address = address, .endpoint_count = 1, .consensus = null };
    var state = try service.Service.open(a, &database, options);
    defer state.deinit();
    var store = try local.LocalStore.open(a, std.fs.cwd(), object_path, .{ .read_only = false, .signer = address });
    defer store.deinit();
    var publisher: service.LocalPublisher = .{ .store = &store };
    var signer = try service.LocalSigner.init(@splat(0x11), null);
    defer signer.deinit();
    try observe(&state, 0, 8);
    try std.testing.expectEqual(@as(usize, 8), try state.publishConcurrent(signer.interface(), publisher.interface(), 100, 50));
    try std.testing.expect(state.publication_workers == null);
    try std.testing.expectEqual(@as(?u32, 7), try store.latestIndex());
    try std.testing.expectEqual(@as(?u32, 7), state.latest_published);
    try std.testing.expectEqual(@as(?u32, 7), state.signed_watermark);
    try std.testing.expectEqual(@as(?u32, 7), state.snapshot_through);
    for (0..8) |index| try std.testing.expect(try store.fetchCheckpoint(@intCast(index)) != null);
    try std.testing.expect(!try state.hasPendingPublication());
    // Newest first: the latest pointer moves with the batch's highest index;
    // the remaining lower index is retired by the next batch.
    try observe(&state, 8, 11);
    try std.testing.expectEqual(@as(usize, 2), try state.publishConcurrent(signer.interface(), publisher.interface(), 101, 2));
    try std.testing.expectEqual(@as(?u32, 10), try store.latestIndex());
    try std.testing.expect(try state.hasPendingPublication());
    try std.testing.expectEqual(@as(usize, 1), try state.publishConcurrent(signer.interface(), publisher.interface(), 102, 2));
    try std.testing.expectEqual(@as(?u32, 10), state.latest_published);
    try std.testing.expectEqual(@as(?u32, 10), state.snapshot_through);
    try std.testing.expect(!try state.hasPendingPublication());
    try std.testing.expect(state.publication_workers == null);
}

/// In-process adapters with crash-boundary faults; every call is counted.
const CountingSigner = struct {
    base: service.LocalSigner,
    calls: usize = 0,
    fn sign(ctx: *anyopaque, checkpoint: service.Checkpoint) !service.Verified {
        const self: *CountingSigner = @ptrCast(@alignCast(ctx));
        self.calls += 1;
        return service.Verified.signWith(&self.base.key, checkpoint, null);
    }
    fn interface(self: *CountingSigner) service.Signer {
        return .{ .parallel_safe = true, .in_process = true, .context = self, .sign = sign };
    }
};
const FaultPublisher = struct {
    base: service.Publisher,
    fail_checkpoints: bool = false,
    fn cast(ctx: *anyopaque) *FaultPublisher {
        return @ptrCast(@alignCast(ctx));
    }
    fn fetch(ctx: *anyopaque, index: u32) !?objects.SignedCheckpoint {
        const base = cast(ctx).base;
        return base.fetch_checkpoint(base.context, index);
    }
    fn guard(ctx: *anyopaque) !bool {
        const base = cast(ctx).base;
        return base.is_reorged(base.context);
    }
    fn checkpoint(ctx: *anyopaque, signed: service.Verified, time: u64) !void {
        const self = cast(ctx);
        if (self.fail_checkpoints) return error.InjectedCheckpointFailure;
        try self.base.write_checkpoint(self.base.context, signed, time);
    }
    fn checkpoints(ctx: *anyopaque, signed: []const service.Verified, time: u64) !void {
        const self = cast(ctx);
        if (self.fail_checkpoints) return error.InjectedCheckpointFailure;
        try self.base.write_checkpoints.?(self.base.context, signed, time);
    }
    fn latest(ctx: *anyopaque, index: u32) !void {
        const base = cast(ctx).base;
        try base.write_latest(base.context, index);
    }
    fn snapshot(ctx: *anyopaque, value: *const objects.Snapshot) !void {
        const base = cast(ctx).base;
        try base.write_snapshot(base.context, value);
    }
    fn reorg(ctx: *anyopaque, value: objects.ReorgEvent) !void {
        const base = cast(ctx).base;
        try base.persist_reorg(base.context, value);
    }
    fn interface(self: *FaultPublisher) service.Publisher {
        return .{ .parallel_safe = true, .in_process = true, .context = self, .fetch_checkpoint = fetch, .is_reorged = guard, .write_checkpoint = checkpoint, .write_checkpoints = if (self.base.write_checkpoints != null) checkpoints else null, .write_latest = latest, .write_snapshot = snapshot, .persist_reorg = reorg };
    }
};
const Boundary = enum { after_signatures, before_directory_sync, before_completion };
fn expectDurablePrefix(store: *local.LocalStore) !void {
    // The latest pointer never names an index whose object is not durable.
    if (try store.latestIndex()) |latest| try std.testing.expect(try store.fetchCheckpoint(latest) != null);
}
test "batched publication restarts at each crash boundary without resigning or conflicting" {
    const a = std.testing.allocator;
    for (std.enums.values(Boundary)) |boundary| {
        var temporary = std.testing.tmpDir(.{});
        defer temporary.cleanup();
        const directory = try temporary.dir.realpathAlloc(a, ".");
        defer a.free(directory);
        const db_path = try std.fs.path.join(a, &.{ directory, "db" });
        defer a.free(db_path);
        const object_path = try std.fs.path.join(a, &.{ directory, "objects" });
        defer a.free(object_path);
        const address = try signature.secretKeyAddress(@splat(0x11));
        const options: service.Options = .{ .domain_name = "restart-fixture", .domain = 3999999999, .hook = @splat(2), .signer_address = address, .endpoint_count = 1, .consensus = null };
        var signer: CountingSigner = .{ .base = try service.LocalSigner.init(@splat(0x11), null) };
        defer signer.base.deinit();
        var database = try rocks.Database.open(a, db_path, .{});
        var state = try service.Service.open(a, &database, options);
        var store = try local.LocalStore.open(a, std.fs.cwd(), object_path, .{ .read_only = false, .signer = address });
        var adapter: service.LocalPublisher = .{ .store = &store };
        var publisher: FaultPublisher = .{ .base = adapter.interface() };
        try observe(&state, 0, 6);
        switch (boundary) {
            .after_signatures => publisher.fail_checkpoints = true,
            .before_directory_sync => local.TestBatchFault.before_directory_sync.store(true, .release),
            .before_completion => service.TestPublicationFault.before_completion.store(true, .release),
        }
        try std.testing.expect(std.meta.isError(state.publishConcurrent(signer.interface(), publisher.interface(), 100, 50)));
        try std.testing.expectEqual(@as(usize, 6), signer.calls);
        try std.testing.expectEqual(@as(?u32, 5), state.signed_watermark);
        var wire: [6][]u8 = undefined;
        for (&wire, 0..) |*bytes, index| {
            const signed = (try state.signedCheckpoint(@intCast(index))).?;
            bytes.* = try signed.toJson(a);
        }
        defer for (wire) |bytes| a.free(bytes);
        try expectDurablePrefix(&store);
        // Restart: process state, database and store handles are all new.
        store.deinit();
        state.deinit();
        database.deinit();
        database = try rocks.Database.open(a, db_path, .{});
        defer database.deinit();
        state = try service.Service.open(a, &database, options);
        defer state.deinit();
        store = try local.LocalStore.open(a, std.fs.cwd(), object_path, .{ .read_only = false, .signer = address });
        defer store.deinit();
        adapter = .{ .store = &store };
        publisher = .{ .base = adapter.interface() };
        try std.testing.expect(try state.hasPendingPublication());
        _ = try state.authorize(&.{try state.checkpoint(5)}, 101);
        // The highest index (object + pointer) completed before the lower
        // store batch failed short of its directory fsync.
        const remaining: usize = if (boundary == .before_directory_sync) 5 else 6;
        try std.testing.expectEqual(remaining, try state.publishConcurrent(signer.interface(), publisher.interface(), 101, 50));
        try std.testing.expectEqual(@as(usize, 6), signer.calls);
        for (wire, 0..) |bytes, index| {
            const published = (try store.fetchCheckpoint(@intCast(index))).?;
            const json = try published.toJson(a);
            defer a.free(json);
            try std.testing.expectEqualStrings(bytes, json);
        }
        try std.testing.expectEqual(@as(?u32, 5), try store.latestIndex());
        try std.testing.expectEqual(@as(?u32, 5), state.snapshot_through);
        try std.testing.expect(!try state.hasPendingPublication());
        try expectDurablePrefix(&store);
    }
}
