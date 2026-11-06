//! Local production-compatible checkpoint object names and data. Atomic writes,
//! explicit bounds, and a cooperating-writer lock intentionally strengthen Rust's
//! current file backend; see README.md. This is not RocksDB/Postgres storage.
const std = @import("std");
const objects = @import("objects.zig");
const protocol = @import("../protocol/root.zig");
const Allocator = std.mem.Allocator;
pub const max_object_bytes = 50 * 1024;

pub const Options = struct {
    read_only: bool = true,
    signer: ?objects.Address = null,
    reorg_period: objects.ReorgPeriod = .none,
    max_bytes: usize = max_object_bytes,
};

pub const WriteResult = enum { written, already_present, overwrote_other_signer, overwrote_other_context };

pub const ReorgStatus = struct {
    allocator: Allocator,
    exists: bool,
    event: ?objects.Decoded(objects.ReorgEvent),
    content: ?[]u8,

    pub fn deinit(self: *ReorgStatus) void {
        if (self.event) |*event| event.deinit();
        if (self.content) |bytes| self.allocator.free(bytes);
        self.* = undefined;
    }
};

pub const LocalStore = struct {
    allocator: Allocator,
    dir: std.fs.Dir,
    lock: ?std.fs.File,
    options: Options,
    halted: bool = false,
    poisoned: bool = false,
    mutex: std.Thread.Mutex = .{},

    /// Opens its own directory handle; the caller retains ownership of parent.
    /// Read-only readers neither create paths nor participate in writer locking.
    /// Reorg-period tag bytes are borrowed and must outlive the store.
    pub fn open(allocator: Allocator, parent: std.fs.Dir, path: []const u8, options: Options) !LocalStore {
        if (options.max_bytes < 2) return error.InvalidObjectLimit;
        if (!options.read_only and options.signer == null) return error.MissingStoreSigner;
        var dir = if (options.read_only) try parent.openDir(path, .{}) else try openDurableDirectory(parent, path);
        errdefer dir.close();
        var lock: ?std.fs.File = null;
        errdefer if (lock) |file| file.close();
        if (!options.read_only) {
            lock = try dir.createFile(".zig-validator-writer.lock", .{ .read = true, .truncate = false, .mode = 0o600 });
            if (!try lock.?.tryLock(.exclusive)) return error.StoreAlreadyLocked;
        }
        var store: LocalStore = .{ .allocator = allocator, .dir = dir, .lock = lock, .options = options };
        // Monitoring readers may inspect a flag, including malformed content.
        // Writers must never initialize over any existing flag.
        if (!options.read_only) {
            var status = try store.reorgStatus();
            defer status.deinit();
            if (status.exists) return error.ReorgFlagPresent;
        }
        return store;
    }

    pub fn deinit(self: *LocalStore) void {
        if (self.lock) |file| file.close();
        self.dir.close();
        self.* = undefined;
    }

    fn readObject(self: *LocalStore, name: []const u8) !?[]u8 {
        const bytes = self.dir.readFileAlloc(self.allocator, name, self.options.max_bytes - 1) catch |err| switch (err) {
            error.FileNotFound => return null,
            else => return err,
        };
        return bytes;
    }

    pub fn fetchCheckpoint(self: *LocalStore, index: u32) !?objects.SignedCheckpoint {
        var name_buffer: [40]u8 = undefined;
        const name = try std.fmt.bufPrint(&name_buffer, "{d}_with_id.json", .{index});
        const bytes = (try self.readObject(name)) orelse return null;
        defer self.allocator.free(bytes);
        const signed = try objects.SignedCheckpoint.parse(self.allocator, bytes);
        if (signed.value.index != index) return error.WrongCheckpointIndex;
        return signed;
    }

    pub fn latestIndex(self: *LocalStore) !?u32 {
        const bytes = (try self.readObject("index.json")) orelse return null;
        defer self.allocator.free(bytes);
        const digits = if (std.mem.startsWith(u8, bytes, "+")) bytes[1..] else bytes;
        if (digits.len == 0) return error.InvalidLatestIndex;
        for (digits) |byte| if (!std.ascii.isDigit(byte)) return error.InvalidLatestIndex;
        return std.fmt.parseInt(u32, digits, 10) catch return error.InvalidLatestIndex;
    }

    pub fn readSnapshot(self: *LocalStore) !?objects.Snapshot {
        const bytes = (try self.readObject("merkle_snapshot.json")) orelse return null;
        defer self.allocator.free(bytes);
        return try objects.Snapshot.parse(self.allocator, bytes);
    }

    pub fn readAuthenticatedSnapshot(self: *LocalStore, expected_signer: objects.Address, domain: u32, hook: objects.Hash) !?protocol.IncrementalMerkle {
        const snapshot = (try self.readSnapshot()) orelse return null;
        const signed = (try self.fetchCheckpoint(snapshot.index)) orelse return error.SnapshotCheckpointMissing;
        return try snapshot.authenticatedRestore(signed, expected_signer, domain, hook);
    }

    pub fn readAnnouncement(self: *LocalStore) !?objects.Decoded(objects.SignedAnnouncement) {
        const bytes = (try self.readObject("announcement.json")) orelse return null;
        defer self.allocator.free(bytes);
        return try objects.SignedAnnouncement.parse(self.allocator, bytes);
    }

    pub fn reorgStatus(self: *LocalStore) !ReorgStatus {
        const bytes = (try self.readObject("reorg_flag.json")) orelse return .{ .allocator = self.allocator, .exists = false, .event = null, .content = null };
        errdefer self.allocator.free(bytes);
        // As in Rust LocalStorage, malformed existing content still means a flag
        // exists. It must never be downgraded to a missing flag.
        const event = objects.ReorgEvent.parse(self.allocator, bytes) catch |err| switch (err) {
            error.OutOfMemory => return err,
            else => null,
        };
        return .{ .allocator = self.allocator, .exists = true, .event = event, .content = bytes };
    }

    fn requireWrite(self: *LocalStore) !void {
        if (self.options.read_only) return error.ReadOnlyStore;
        if (self.halted) return error.ReorgHalted;
        if (self.poisoned) return error.StorePoisoned;
        var status = try self.reorgStatus();
        defer status.deinit();
        if (status.exists) {
            self.halted = true;
            return error.ReorgHalted;
        }
    }

    /// Atomic rename after file fsync, followed by parent-directory fsync.
    /// An ambiguous I/O failure poisons the handle until reopen and readback.
    fn atomicWrite(self: *LocalStore, name: []const u8, bytes: []const u8) !void {
        if (bytes.len >= self.options.max_bytes) return error.ObjectTooLarge;
        self.poisoned = true;
        var atomic = try self.dir.atomicFile(name, .{ .mode = 0o600, .write_buffer = &.{} });
        defer atomic.deinit();
        try atomic.file_writer.file.writeAll(bytes);
        try atomic.file_writer.file.sync();
        try atomic.renameIntoPlace();
        try std.posix.fsync(self.dir.fd);
        self.poisoned = false;
    }

    /// Same-signer conflict is checked against durable state before publication.
    /// A different key's valid object may be overwritten, as in Rust submit.rs.
    pub fn writeCheckpoint(self: *LocalStore, signed: objects.SignedCheckpoint, unix_timestamp: u64) !WriteResult {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.requireWrite();
        const expected_signer = self.options.signer orelse return error.MissingStoreSigner;
        if (!std.mem.eql(u8, &try signed.recover(), &expected_signer)) return error.WrongStoreSigner;
        const result = try self.inspectCheckpointLocked(signed.value, unix_timestamp);
        if (result != .already_present) try self.writeCheckpointLocked(signed);
        return result;
    }

    /// Local signing is serialized with durable conflict inspection: the new
    /// value is never signed if this key already signed a conflicting value.
    /// Remote/KMS signers need the equivalent reservation in their runtime.
    pub fn signAndWriteCheckpoint(self: *LocalStore, value: objects.Checkpoint, secret_key: objects.Hash, noise: ?objects.Hash, unix_timestamp: u64) !WriteResult {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.requireWrite();
        const expected_signer = self.options.signer orelse return error.MissingStoreSigner;
        if (!std.mem.eql(u8, &try protocol.signature.secretKeyAddress(secret_key), &expected_signer)) return error.WrongStoreSigner;
        const result = try self.inspectCheckpointLocked(value, unix_timestamp);
        if (result != .already_present) try self.writeCheckpointLocked(try objects.SignedCheckpoint.sign(value, secret_key, noise));
        return result;
    }

    fn inspectCheckpointLocked(self: *LocalStore, value: objects.Checkpoint, unix_timestamp: u64) !WriteResult {
        const expected_signer = self.options.signer orelse return error.MissingStoreSigner;
        var result: WriteResult = .written;
        if (try self.fetchCheckpoint(value.index)) |existing| {
            const existing_signer = try existing.recover();
            if (std.mem.eql(u8, &existing_signer, &expected_signer)) {
                if (std.meta.eql(existing.value, value)) return .already_present;
                if (existing.value.mailbox_domain == value.mailbox_domain and std.mem.eql(u8, &existing.value.merkle_tree_hook_address, &value.merkle_tree_hook_address)) {
                    try self.persistReorgLocked(.{ .local_merkle_root = existing.value.root, .canonical_merkle_root = value.root, .checkpoint_index = value.index, .unix_timestamp = unix_timestamp, .reorg_period = self.options.reorg_period });
                    return error.ConflictingSignedCheckpoint;
                }
                result = .overwrote_other_context;
            } else result = .overwrote_other_signer;
        }
        return result;
    }

    fn writeCheckpointLocked(self: *LocalStore, signed: objects.SignedCheckpoint) !void {
        const bytes = try signed.toJson(self.allocator);
        defer self.allocator.free(bytes);
        var name_buffer: [40]u8 = undefined;
        const name = try std.fmt.bufPrint(&name_buffer, "{d}_with_id.json", .{signed.value.index});
        try self.atomicWrite(name, bytes);
    }

    /// Rust publishes the newest checkpoint before filling historical indices.
    /// The pointer target must exist and be signed by this writer; the runtime
    /// separately owns durable history completion and signing reservations.
    pub fn writeLatestIndex(self: *LocalStore, index: u32) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.requireWrite();
        const previous = try self.latestIndex();
        if (previous) |old| {
            if (index < old) return error.LatestIndexRegression;
        }
        const expected_signer = self.options.signer orelse return error.MissingStoreSigner;
        const checkpoint = (try self.fetchCheckpoint(index)) orelse return error.CheckpointPublicationGap;
        if (!std.mem.eql(u8, &try checkpoint.recover(), &expected_signer)) return error.WrongStoreSigner;
        if (previous == index) return;
        var buffer: [10]u8 = undefined;
        const bytes = try std.fmt.bufPrint(&buffer, "{d}", .{index});
        try self.atomicWrite("index.json", bytes);
    }

    pub fn writeSnapshot(self: *LocalStore, snapshot: *const objects.Snapshot) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.requireWrite();
        const checkpoint = (try self.fetchCheckpoint(snapshot.index)) orelse return error.SnapshotCheckpointMissing;
        _ = try snapshot.authenticatedRestore(checkpoint, self.options.signer orelse return error.MissingStoreSigner, checkpoint.value.mailbox_domain, checkpoint.value.merkle_tree_hook_address);
        const bytes = try snapshot.toJson(self.allocator);
        defer self.allocator.free(bytes);
        try self.atomicWrite("merkle_snapshot.json", bytes);
    }

    pub fn writeAnnouncement(self: *LocalStore, announcement: objects.SignedAnnouncement) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.requireWrite();
        if (!std.mem.eql(u8, &try announcement.recover(), &(self.options.signer orelse return error.MissingStoreSigner))) return error.WrongStoreSigner;
        const bytes = try announcement.toJson(self.allocator);
        defer self.allocator.free(bytes);
        try self.atomicWrite("announcement.json", bytes);
    }

    pub fn writeMetadata(self: *LocalStore, bytes: []const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.requireWrite();
        try self.atomicWrite("metadata_latest.json", bytes);
    }

    pub fn writeReorgRpcResponses(self: *LocalStore, public_log: []const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.requireWrite();
        try self.atomicWrite("reorg_rpc_responses.json", public_log);
    }

    /// Can be retried even after a failed guard write; all ordinary writes stay
    /// halted. The runtime must retry guard persistence before exiting.
    pub fn persistReorg(self: *LocalStore, event: objects.ReorgEvent) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.options.read_only) return error.ReadOnlyStore;
        try self.persistReorgLocked(event);
    }

    fn persistReorgLocked(self: *LocalStore, event: objects.ReorgEvent) !void {
        self.halted = true;
        const bytes = try event.toJson(self.allocator);
        defer self.allocator.free(bytes);
        try self.atomicWrite("reorg_flag.json", bytes);
    }
};

/// Persist each newly created directory entry before descending into it. File
/// fsync plus final-directory fsync alone does not persist that directory's own
/// name in its parent. Preserve existing relative/absolute path semantics.
fn openDurableDirectory(parent: std.fs.Dir, path: []const u8) !std.fs.Dir {
    if (path.len == 0) return error.InvalidStorePath;
    var current = if (std.fs.path.isAbsolute(path)) try std.fs.openDirAbsolute("/", .{ .iterate = true }) else try parent.openDir(".", .{ .iterate = true });
    errdefer current.close();
    var components = std.mem.tokenizeScalar(u8, path, '/');
    while (components.next()) |component| {
        if (std.mem.eql(u8, component, ".")) continue;
        const created = if (std.mem.eql(u8, component, "..")) false else blk: {
            current.makeDir(component) catch |err| switch (err) {
                error.PathAlreadyExists => break :blk false,
                else => return err,
            };
            break :blk true;
        };
        if (created) try std.posix.fsync(current.fd);
        // Linux otherwise opens O_PATH, which cannot be synchronized.
        const next = try current.openDir(component, .{ .iterate = true });
        current.close();
        current = next;
    }
    return current;
}

fn testCheckpoint(index: u32, root_byte: u8, key: objects.Hash) !objects.SignedCheckpoint {
    return objects.SignedCheckpoint.sign(.{ .merkle_tree_hook_address = .{0x22} ** 32, .mailbox_domain = 1000, .root = .{root_byte} ** 32, .index = index, .message_id = .{0x33} ** 32 }, key, null);
}

fn testOptions(key: objects.Hash) !Options {
    return .{ .read_only = false, .signer = try protocol.signature.secretKeyAddress(key), .reorg_period = .{ .blocks = 5 } };
}

test "writer lock excludes second writer while readers neither lock nor create paths" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const allocator = std.testing.allocator;
    const options = try testOptions(.{0x11} ** 32);
    var writer = try LocalStore.open(allocator, tmp.dir, "writer", options);
    defer writer.deinit();
    try std.testing.expectError(error.StoreAlreadyLocked, LocalStore.open(allocator, tmp.dir, "writer", options));
    var reader = try LocalStore.open(allocator, tmp.dir, "writer", .{});
    defer reader.deinit();
    try std.testing.expectError(error.ReadOnlyStore, reader.writeMetadata("{}"));
    try std.testing.expectError(error.FileNotFound, LocalStore.open(allocator, tmp.dir, "missing", .{}));
    try tmp.dir.makeDir("read-only");
    var clean_reader = try LocalStore.open(allocator, tmp.dir, "read-only", .{});
    defer clean_reader.deinit();
    try std.testing.expectError(error.FileNotFound, clean_reader.dir.access(".zig-validator-writer.lock", .{}));
}

test "same signer conflict persists guard preserves old checkpoint and blocks all late writes" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const allocator = std.testing.allocator;
    const key: objects.Hash = .{0x11} ** 32;
    const options = try testOptions(key);
    var store = try LocalStore.open(allocator, tmp.dir, "store", options);
    const original = try testCheckpoint(0, 1, key);
    try std.testing.expectEqual(WriteResult.written, try store.writeCheckpoint(original, 10));
    try std.testing.expectEqual(WriteResult.already_present, try store.writeCheckpoint(original, 11));
    try std.testing.expectError(error.ConflictingSignedCheckpoint, store.writeCheckpoint(try testCheckpoint(0, 2, key), 12));
    try std.testing.expectEqual(original.value, (try store.fetchCheckpoint(0)).?.value);
    var status = try store.reorgStatus();
    defer status.deinit();
    try std.testing.expect(status.exists);
    try std.testing.expectEqual(@as(u64, 12), status.event.?.value.unix_timestamp);
    try std.testing.expectEqual(original.value.root, status.event.?.value.local_merkle_root);
    try std.testing.expectError(error.ReorgHalted, store.writeCheckpoint(try testCheckpoint(1, 3, key), 13));
    try std.testing.expectError(error.ReorgHalted, store.writeLatestIndex(0));
    try std.testing.expectError(error.ReorgHalted, store.writeMetadata("late signer result"));
    store.deinit();
    try std.testing.expectError(error.ReorgFlagPresent, LocalStore.open(allocator, tmp.dir, "store", options));
}

test "different signer checkpoint is overwritten without creating a false reorg" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const allocator = std.testing.allocator;
    var old = try LocalStore.open(allocator, tmp.dir, "store", try testOptions(.{0x22} ** 32));
    _ = try old.writeCheckpoint(try testCheckpoint(0, 1, .{0x22} ** 32), 1);
    old.deinit();
    var current = try LocalStore.open(allocator, tmp.dir, "store", try testOptions(.{0x11} ** 32));
    defer current.deinit();
    try std.testing.expectEqual(WriteResult.overwrote_other_signer, try current.writeCheckpoint(try testCheckpoint(0, 2, .{0x11} ** 32), 2));
    var status = try current.reorgStatus();
    defer status.deinit();
    try std.testing.expect(!status.exists);
}

test "latest-first publication validates target while historical checkpoints fill and snapshot survives reopen" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const allocator = std.testing.allocator;
    const key: objects.Hash = .{0x11} ** 32;
    const options = try testOptions(key);
    var store = try LocalStore.open(allocator, tmp.dir, "store", options);
    const leaf: objects.Hash = .{0x44} ** 32;
    var tree = protocol.IncrementalMerkle.init();
    try tree.ingest(leaf);
    const checkpoint = try objects.SignedCheckpoint.sign(.{ .merkle_tree_hook_address = .{0x22} ** 32, .mailbox_domain = 1000, .root = tree.root(), .index = 0, .message_id = leaf }, key, null);
    try std.testing.expectError(error.CheckpointPublicationGap, store.writeLatestIndex(2));
    const latest = try testCheckpoint(2, 3, key);
    _ = try store.writeCheckpoint(latest, 1);
    try store.writeLatestIndex(2);
    try std.testing.expectEqual(@as(?u32, 2), try store.latestIndex());
    try std.testing.expect(try store.fetchCheckpoint(0) == null);
    try std.testing.expect(try store.fetchCheckpoint(1) == null);
    _ = try store.writeCheckpoint(try testCheckpoint(1, 2, key), 1);
    _ = try store.writeCheckpoint(checkpoint, 1);
    try store.writeLatestIndex(2);
    try std.testing.expectEqual(@as(?u32, 2), try store.latestIndex());
    try std.testing.expectError(error.LatestIndexRegression, store.writeLatestIndex(0));
    try store.dir.deleteFile("2_with_id.json");
    try std.testing.expectError(error.CheckpointPublicationGap, store.writeLatestIndex(2));
    _ = try store.writeCheckpoint(latest, 1);
    const wrong_signer = try (try testCheckpoint(3, 4, .{0x22} ** 32)).toJson(allocator);
    defer allocator.free(wrong_signer);
    try store.dir.writeFile(.{ .sub_path = "3_with_id.json", .data = wrong_signer });
    try std.testing.expectError(error.WrongStoreSigner, store.writeLatestIndex(3));
    const snapshot = try objects.Snapshot.capture(&tree);
    try store.writeSnapshot(&snapshot);
    const announcement = try objects.SignedAnnouncement.sign(.{ .validator = options.signer.?, .mailbox_address = .{0x22} ** 32, .mailbox_domain = 1000, .storage_location = "file:///public-fixture" }, key, null);
    try store.writeAnnouncement(announcement);
    try store.writeMetadata("{\"agent\":\"validator\"}");
    try store.writeReorgRpcResponses("public correctness evidence");
    store.deinit();
    var reopened = try LocalStore.open(allocator, tmp.dir, "store", options);
    defer reopened.deinit();
    const restored = (try reopened.readAuthenticatedSnapshot(options.signer.?, 1000, .{0x22} ** 32)).?;
    try std.testing.expectEqual(tree, restored);
    try std.testing.expectError(error.SnapshotSignerMismatch, reopened.readAuthenticatedSnapshot(.{0} ** 20, 1000, .{0x22} ** 32));
    try std.testing.expectError(error.SnapshotCheckpointMismatch, reopened.readAuthenticatedSnapshot(options.signer.?, 1001, .{0x22} ** 32));
    var stored_announcement = (try reopened.readAnnouncement()).?;
    defer stored_announcement.deinit();
    try std.testing.expectEqualStrings(announcement.value.storage_location, stored_announcement.value.value.storage_location);
}

test "malformed unreadable and oversized reorg flags are never treated as absent" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const allocator = std.testing.allocator;
    try tmp.dir.makeDir("store");
    try tmp.dir.writeFile(.{ .sub_path = "store/reorg_flag.json", .data = "torn {\"checkpoint_index\":" });
    try std.testing.expectError(error.ReorgFlagPresent, LocalStore.open(allocator, tmp.dir, "store", try testOptions(.{0x11} ** 32)));
    var reader = try LocalStore.open(allocator, tmp.dir, "store", .{});
    defer reader.deinit();
    var status = try reader.reorgStatus();
    defer status.deinit();
    try std.testing.expect(status.exists and status.event == null);
    try reader.dir.deleteFile("reorg_flag.json");
    try reader.dir.makeDir("reorg_flag.json");
    try std.testing.expectError(error.IsDir, reader.reorgStatus());
    try reader.dir.deleteDir("reorg_flag.json");
    const oversized = try allocator.alloc(u8, max_object_bytes);
    defer allocator.free(oversized);
    @memset(oversized, ' ');
    try reader.dir.writeFile(.{ .sub_path = "reorg_flag.json", .data = oversized });
    try std.testing.expectError(error.FileTooBig, reader.reorgStatus());
    try std.testing.expectError(error.FileTooBig, LocalStore.open(allocator, tmp.dir, "store", try testOptions(.{0x11} ** 32)));
}

test "read errors torn checkpoint and snapshot size boundaries fail closed" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const allocator = std.testing.allocator;
    var store = try LocalStore.open(allocator, tmp.dir, "store", try testOptions(.{0x11} ** 32));
    defer store.deinit();
    try store.dir.makeDir("7_with_id.json");
    try std.testing.expectError(error.IsDir, store.fetchCheckpoint(7));
    try store.dir.deleteDir("7_with_id.json");
    try store.dir.writeFile(.{ .sub_path = "7_with_id.json", .data = "{\"value\":" });
    if (store.fetchCheckpoint(7)) |_| return error.ExpectedTornCheckpointFailure else |_| {}
    try store.dir.makeDir("index.json");
    try std.testing.expectError(error.IsDir, store.latestIndex());
    try store.dir.deleteDir("index.json");
    try store.dir.writeFile(.{ .sub_path = "index.json", .data = "1_0" });
    try std.testing.expectError(error.InvalidLatestIndex, store.latestIndex());
    var tree = protocol.IncrementalMerkle.init();
    try tree.ingest(.{1} ** 32);
    const snapshot = try objects.Snapshot.capture(&tree);
    const canonical = try snapshot.toJson(allocator);
    defer allocator.free(canonical);
    const padded = try allocator.alloc(u8, max_object_bytes);
    defer allocator.free(padded);
    @memset(padded, ' ');
    @memcpy(padded[0..canonical.len], canonical);
    try store.dir.writeFile(.{ .sub_path = "merkle_snapshot.json", .data = padded[0 .. padded.len - 1] });
    try std.testing.expectEqual(snapshot, (try store.readSnapshot()).?);
    try store.dir.writeFile(.{ .sub_path = "merkle_snapshot.json", .data = padded });
    try std.testing.expectError(error.FileTooBig, store.readSnapshot());
}

test "failed guard persistence stays halted and can retry without accepting late writes" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var store = try LocalStore.open(std.testing.allocator, tmp.dir, "store", try testOptions(.{0x11} ** 32));
    defer store.deinit();
    try store.dir.makeDir("reorg_flag.json");
    const event: objects.ReorgEvent = .{ .local_merkle_root = .{1} ** 32, .canonical_merkle_root = .{2} ** 32, .checkpoint_index = 0, .unix_timestamp = 1, .reorg_period = .none };
    if (store.persistReorg(event)) |_| return error.ExpectedGuardWriteFailure else |_| {}
    try std.testing.expect(store.halted and store.poisoned);
    try std.testing.expectError(error.ReorgHalted, store.writeMetadata("late result"));
    try store.dir.deleteDir("reorg_flag.json");
    try store.persistReorg(event);
    var status = try store.reorgStatus();
    defer status.deinit();
    try std.testing.expect(status.exists and status.event != null);
    try std.testing.expectError(error.ReorgHalted, store.writeMetadata("still halted"));
}

test "local sign-and-write checks durable history before generating another signature" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const key: objects.Hash = .{0x11} ** 32;
    var store = try LocalStore.open(std.testing.allocator, tmp.dir, "store", try testOptions(key));
    defer store.deinit();
    const value = (try testCheckpoint(0, 1, key)).value;
    try std.testing.expectEqual(WriteResult.written, try store.signAndWriteCheckpoint(value, key, null, 1));
    try std.testing.expectEqual(WriteResult.already_present, try store.signAndWriteCheckpoint(value, key, null, 2));
    var conflicting = value;
    conflicting.message_id[0] ^= 1;
    try std.testing.expectError(error.ConflictingSignedCheckpoint, store.signAndWriteCheckpoint(conflicting, key, null, 3));
    try std.testing.expectEqual(value, (try store.fetchCheckpoint(0)).?.value);
}

test "nested and absolute writer directories are created through durable parent entries" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const allocator = std.testing.allocator;
    const options = try testOptions(.{0x11} ** 32);
    var nested = try LocalStore.open(allocator, tmp.dir, "first/second/store", options);
    _ = try nested.signAndWriteCheckpoint((try testCheckpoint(0, 1, .{0x11} ** 32)).value, .{0x11} ** 32, null, 1);
    nested.deinit();
    const root_path = try tmp.dir.realpathAlloc(allocator, ".");
    defer allocator.free(root_path);
    const absolute = try std.fs.path.join(allocator, &.{ root_path, "absolute", "store" });
    defer allocator.free(absolute);
    var store = try LocalStore.open(allocator, std.fs.cwd(), absolute, options);
    defer store.deinit();
    try store.writeMetadata("{}");
    try std.testing.expectError(error.StoreAlreadyLocked, LocalStore.open(allocator, std.fs.cwd(), absolute, options));
}
