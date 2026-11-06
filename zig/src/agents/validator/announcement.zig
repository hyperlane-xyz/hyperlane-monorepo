//! Durable native self-announcement owner. Queueing never signs a chain
//! transaction. The worker restores the first valid signed announcement and
//! exact persisted public intent/authorization/transaction on every restart.
const std = @import("std");
const settings = @import("../../settings/types.zig");
const signing = @import("../signer.zig");
const clients = @import("../chain_source.zig");
const destination = @import("../destination/root.zig");
const objects = @import("../../storage/objects.zig");
const native = @import("../store.zig");
const rocks = @import("../../db/rocks.zig");
const generic = @import("generic.zig");
const Times = destination.operation.Times;
const A = std.mem.Allocator;
const prefix = "zig_validator_native_announcement_v1/";
pub const Options = struct { initialization_clock: ?destination.Clock = null, clients: clients.Options, destination: destination.Options = .{}, interval_ms: u64 = 2000, revision: u64 = 0 };
pub const Owner = struct {
    allocator: A,
    expected: objects.Announcement,
    expected_storage: []u8,
    operation_namespace: []u8,
    store: native.Store,
    resources: *clients.Resources,
    factory: *destination.Factory,
    options: Options,
    announcement: ?objects.Decoded(objects.SignedAnnouncement) = null,
    operation: ?*destination.operation.Operation = null,
    pub fn open(a: A, database: *rocks.Database, chain: *const settings.Chain, environment: *const std.process.EnvMap, transaction_signer: settings.Signer, credentials: signing.Credentials, expected: objects.Announcement, options: Options) !*Owner {
        if (options.interval_ms == 0 or expected.mailbox_domain != chain.domain or !std.mem.eql(u8, &expected.mailbox_address, &chain.contracts.mailbox)) return error.AnnouncementAuthorityMismatch;
        const storage = try a.dupe(u8, expected.storage_location);
        errdefer a.free(storage);
        var expected_owned = expected;
        expected_owned.storage_location = storage;
        const resource = try clients.Resources.open(a, chain, environment, options.clients);
        errdefer resource.deinit();
        const saved_cancel = resource.cancel;
        const saved_rpc_deadline = resource.rpc_deadline_ns;
        const saved_owner: ?@import("../../cloud/http.zig").RpcReadOwner = if (resource.http.rpc_read_owner) |guard| .{ .deadline_ns = guard.deadline_ns, .halt = guard.halt, .retry_physical_timeout = guard.retry_physical_timeout } else null;
        defer {
            resource.setCancellation(saved_cancel);
            resource.rpc_deadline_ns = saved_rpc_deadline;
            resource.http.rpc_read_owner = saved_owner;
        }
        if (options.initialization_clock) |clock| {
            resource.setCancellation(clock.cancel);
            const deadline = @min(clock.deadline_ns, @min(saved_rpc_deadline orelse clock.deadline_ns, if (saved_owner) |guard| guard.deadline_ns else clock.deadline_ns));
            resource.rpc_deadline_ns = deadline;
            resource.http.rpc_read_owner = .{ .deadline_ns = deadline, .halt = if (saved_owner) |guard| guard.halt orelse clock.halt else clock.halt, .retry_physical_timeout = if (saved_owner) |guard| guard.retry_physical_timeout else true };
        }
        const factory = try destination.Factory.open(a, resource, transaction_signer, credentials, options.destination);
        errdefer factory.deinit();
        const namespace = try std.fmt.allocPrint(a, "{s}:validator-announcement:{d}", .{ chain.name, options.revision });
        errdefer a.free(namespace);
        const self = try a.create(Owner);
        var retained_options = options;
        // Callback cancellation/deadline pointers are constructor borrows only.
        retained_options.initialization_clock = null;
        self.* = .{ .allocator = a, .expected = expected_owned, .expected_storage = storage, .operation_namespace = namespace, .store = native.Store.init(a, database, namespace), .resources = resource, .factory = factory, .options = retained_options };
        errdefer a.destroy(self);
        if (try self.store.typed.get(a, prefix, &expected.digest())) |bytes| {
            defer a.free(bytes);
            self.announcement = try self.decode(bytes);
        }
        return self;
    }
    pub fn deinit(self: *Owner) void {
        if (self.operation) |operation| operation.deinit();
        if (self.announcement) |*value| value.deinit();
        self.factory.deinit();
        self.resources.deinit();
        self.allocator.free(self.expected_storage);
        self.allocator.free(self.operation_namespace);
        self.allocator.destroy(self);
    }
    pub fn refresh(self: *Owner, credentials: signing.Credentials) !void {
        try self.factory.refresh(credentials);
    }
    pub fn interface(self: *Owner) generic.Announcer {
        return .{ .context = self, .submit = submit };
    }
    fn validate(self: *Owner, announcement: objects.SignedAnnouncement) !void {
        if (!std.mem.eql(u8, &announcement.value.digest(), &self.expected.digest()) or !std.mem.eql(u8, &try announcement.recover(), &self.expected.validator)) return error.AnnouncementAuthorityMismatch;
    }
    fn decode(self: *Owner, bytes: []const u8) !objects.Decoded(objects.SignedAnnouncement) {
        if (bytes.len == 0 or bytes.len > 2 * 1024 * 1024) return error.InvalidAnnouncementQueue;
        var value = try objects.SignedAnnouncement.parse(self.allocator, bytes);
        errdefer value.deinit();
        try self.validate(value.value);
        return value;
    }
    pub fn enqueue(self: *Owner, announcement: objects.SignedAnnouncement) !void {
        try submit(self, announcement);
    }
    fn submit(context: *anyopaque, announcement: objects.SignedAnnouncement) !void {
        const self: *Owner = @ptrCast(@alignCast(context));
        try self.validate(announcement);
        const digest = self.expected.digest();
        self.store.mutex.lock();
        defer self.store.mutex.unlock();
        // Another process may have durably queued the same value with another
        // valid ECDSA signature. Keep its exact bytes for native intent recovery.
        if (try self.store.typed.get(self.allocator, prefix, &digest)) |bytes| {
            defer self.allocator.free(bytes);
            var previous = try self.decode(bytes);
            defer previous.deinit();
            return;
        }
        const bytes = try announcement.toJson(self.allocator);
        defer self.allocator.free(bytes);
        var batch = try self.store.typed.batch(self.allocator);
        defer batch.deinit();
        try batch.put(prefix, &digest, bytes);
        try batch.commitSync();
    }
    fn operationFor(self: *Owner, now: Times) !?*destination.operation.Operation {
        if (self.operation) |operation| return operation;
        if (self.announcement == null) {
            const bytes = try self.store.typed.get(self.allocator, prefix, &self.expected.digest()) orelse return null;
            defer self.allocator.free(bytes);
            self.announcement = try self.decode(bytes);
        }
        const authority = try self.factory.authorityFor(self.expected.mailbox_domain, self.expected.digest(), 0, .announcement);
        self.operation = try destination.operation.Operation.open(self.allocator, &self.store, .{ .id = self.expected.digest(), .context = try self.factory.identityContext(), .nonce = 0, .origin = authority.origin, .destination = authority.destination, .kind = .announcement, .target = authority.target, .policy = .{ .confirm_delay_ms = self.options.interval_ms } }, now);
        return self.operation;
    }
    /// A fresh finalized location read proves the announcement goal itself,
    /// regardless of which transaction published it. No receipt guess is needed.
    pub fn observedAnnounced(self: *Owner, now: Times) !void {
        const operation = try self.operationFor(now) orelse return;
        if (operation.value.stage == .delivered) return;
        try operation.observe(true, true, now);
    }
    /// At most three effects per worker cycle. Every signing/broadcast effect is
    /// protected by Operation's synchronous persistence and native full identity.
    pub fn tick(self: *Owner, now: Times, clock: destination.Clock) !usize {
        const operation = try self.operationFor(now) orelse return 0;
        if (operation.value.stage == .delivered or now.monotonic_ms < operation.value.next_attempt_ms) return 0;
        var work: usize = 0;
        for (0..3) |_| {
            const effect = try operation.tick(now);
            switch (effect) {
                .none => return work,
                .prepare => |generation| {
                    var prepared = if (operation.intent) |bytes| try destination.types.Prepared.restore(self.allocator, bytes) else try self.factory.prepareAnnouncement(try self.factory.authorityFor(self.expected.mailbox_domain, self.expected.digest(), generation, .announcement), self.announcement.?.value, clock);
                    defer prepared.deinit();
                    try operation.staged(&prepared, now);
                    _ = try self.factory.quote(&prepared, operation.authorization, operation.persistence(now), clock);
                    try operation.prepared(&prepared, true, true, now);
                    work += 1;
                },
                .build => {
                    const bytes = operation.intent orelse return error.MissingAnnouncementIntent;
                    var prepared = try destination.types.Prepared.restore(self.allocator, bytes);
                    defer prepared.deinit();
                    var signed = try self.factory.sign(&prepared, operation.authorization, operation.persistence(now), clock);
                    defer signed.deinit();
                    // Native sign methods must persist their recoverable bytes
                    // before returning. Do not infer persistence from a local ID.
                    const persisted = operation.signed orelse return error.MissingPersistedNativeTransaction;
                    if (!destination.types.Identity.eql(persisted.identity, signed.identity) or !std.mem.eql(u8, persisted.bytes, signed.bytes)) return error.NativeSignedPersistenceMismatch;
                    try self.broadcast(operation, &prepared, now, clock);
                    work += 1;
                    return work;
                },
                .broadcast => {
                    var prepared = try destination.types.Prepared.restore(self.allocator, operation.intent orelse return error.MissingAnnouncementIntent);
                    defer prepared.deinit();
                    try self.broadcast(operation, &prepared, now, clock);
                    return work + 1;
                },
                .reconcile => |identity| {
                    const receipt = try self.factory.reconcile(identity, clock);
                    if (receipt) |value| {
                        if (!destination.types.Identity.eql(identity, value.identity)) return error.WrongNativeReceipt;
                        if (value.finalized and !value.success) {
                            try operation.finalizedFailure(value, now, 0);
                        } else try operation.observe(value.finalized, value.success, now);
                    } else {
                        // Absence permits only the SAME signed bytes. It never
                        // authorizes a new nonce, expiry, signature or identity.
                        var prepared = try destination.types.Prepared.restore(self.allocator, operation.intent orelse return error.MissingAnnouncementIntent);
                        defer prepared.deinit();
                        const signed = if (operation.signed) |*value| value else return error.MissingPersistedNativeTransaction;
                        if (try self.factory.announcementRetirement(&prepared, signed, self.announcement.?.value, clock)) |proof| {
                            try operation.retire(proof, now, 0);
                            return work + 1;
                        }
                        _ = try operation.rebroadcast(now);
                        try self.broadcast(operation, &prepared, now, clock);
                        try operation.observe(false, false, now);
                    }
                    return work + 1;
                },
            }
        }
        return work;
    }
    fn broadcast(self: *Owner, operation: *destination.operation.Operation, prepared: *const destination.types.Prepared, now: Times, clock: destination.Clock) !void {
        const signed = if (operation.signed) |*value| value else return error.MissingPersistedNativeTransaction;
        self.factory.broadcast(prepared, operation.authorization, signed, operation.persistence(now), clock) catch |err| {
            // Unknown acknowledgement retains the transaction for reconciliation.
            try operation.broadcastResult(false, now);
            return err;
        };
        try operation.broadcastResult(true, now);
    }
};
