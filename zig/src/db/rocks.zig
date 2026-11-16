//! Optional native adapter for the SAME RocksDB engine used by Rust agents.
//! Owners are move-only by convention. Destroy batches/iterators before their DB;
//! returned get/iterator bytes are independent allocations owned by the caller.
const std = @import("std");
const c = @import("c.zig");
const keys = @import("keys.zig");
const sync_stats = @import("sync_stats.zig");
const Allocator = std.mem.Allocator;

/// Native error messages are copied before rocksdb_free. Optional diagnostics
/// never retain a dangling C pointer or require logging sensitive database keys.
pub const Diagnostic = struct {
    bytes: [2048]u8 = undefined,
    len: usize = 0,
    truncated: bool = false,

    pub fn message(self: *const Diagnostic) []const u8 {
        return self.bytes[0..self.len];
    }

    fn capture(self: *Diagnostic, text: []const u8) void {
        self.len = @min(text.len, self.bytes.len);
        self.truncated = text.len > self.bytes.len;
        @memcpy(self.bytes[0..self.len], text[0..self.len]);
    }
};

fn check(native_error: ?[*:0]u8, diagnostic: ?*Diagnostic) !void {
    if (native_error) |message| {
        defer c.rocksdb_free(message);
        if (diagnostic) |out| out.capture(std.mem.span(message));
        return error.RocksDB;
    }
}

/// Durability contract of a `sync = true` database: every write is durable
/// before any external effect that depends on it, or that a peer or chain
/// could observe (sendRaw, checkpoint/announcement publish, API ack, metrics
/// claims about delivery), and before any internal decision that is
/// irreversible after a crash (e.g. a nonce is durable before the transaction
/// is signed). `Durability.sync` commits are durable on return. A
/// `Durability.deferred` commit is a WAL write without fsync whose caller
/// guarantees a covering synced commit (or `ensureDurable`) on this database
/// before any such effect: RocksDB syncs every live WAL file in one ordered
/// log, so a later sync persists every earlier write. A crash between the
/// two reaches only states a crash just before the deferred commit already
/// could. Every deferral is covered within its own step. The EVM Lander gates
/// signing and sendRaw with `effectGate`, and in-step coverage is asserted
/// with it after the covering sync. Ungated effect sites (native destination
/// sign/broadcast, validator sign/publish, API acks) rely on their actor's own
/// synced persist preceding the effect, which covers every earlier write.
pub const Durability = enum { sync, deferred };

/// Test-mode proof that each deferral is covered: the newest deferred write
/// made on this thread (fibers do not park inside a deferral window), so a
/// concurrent fiber's legitimate debt on another thread never trips a gate.
threadlocal var thread_debt: struct { database: ?*const Database = null, sequence: u64 = 0 } = .{};

pub const OpenOptions = struct {
    create_if_missing: bool = true,
    read_only: bool = false,
    /// Rust's default writes are asynchronous; durable callers may opt into fsync.
    sync: bool = false,
    retain_rollback_wal: bool = false,
    diagnostic: ?*Diagnostic = null,
};

pub const Database = struct {
    handle: *c.DB,
    read_options: *c.ReadOptions,
    write_options: *c.WriteOptions,
    read_only: bool,
    /// Default write durability (OpenOptions.sync): WAL fsync per write.
    sync: bool,
    /// Durability debt (sequence numbers): the newest deferred write and the
    /// newest sequence known WAL-synced. Debt exists while owed > synced.
    owed: std.atomic.Value(u64) = .init(0),
    synced: std.atomic.Value(u64) = .init(0),
    /// Work counter: WAL fsyncs this handle requested (synced writes plus
    /// debt-paying flushes).
    wal_syncs: std.atomic.Value(u64) = .init(0),
    diagnostic: ?*Diagnostic,

    pub fn open(allocator: Allocator, path: []const u8, options: OpenOptions) !Database {
        try @import("native_abi.zig").verify();
        if (std.mem.indexOfScalar(u8, path, 0) != null) return error.InvalidPath;
        sync_stats.configure();
        const name = try allocator.dupeZ(u8, path);
        defer allocator.free(name);
        const native_options = c.rocksdb_options_create() orelse return error.NativeAllocation;
        defer c.rocksdb_options_destroy(native_options);
        c.rocksdb_options_set_create_if_missing(native_options, @intFromBool(options.create_if_missing));
        c.rocksdb_options_set_keep_log_file_num(native_options, 10);
        c.rocksdb_options_set_max_log_file_size(native_options, 16 * 1024 * 1024);
        if (options.retain_rollback_wal) {
            c.rocksdb_options_set_WAL_ttl_seconds(native_options, 7 * 24 * 60 * 60);
            c.rocksdb_options_set_WAL_size_limit_MB(native_options, 1024);
        }
        const read_options = c.rocksdb_readoptions_create() orelse return error.NativeAllocation;
        errdefer c.rocksdb_readoptions_destroy(read_options);
        const write_options = c.rocksdb_writeoptions_create() orelse return error.NativeAllocation;
        errdefer c.rocksdb_writeoptions_destroy(write_options);
        c.rocksdb_writeoptions_set_sync(write_options, @intFromBool(options.sync));
        c.rocksdb_writeoptions_disable_WAL(write_options, 0);
        var native_error: ?[*:0]u8 = null;
        const handle = if (options.read_only)
            c.rocksdb_open_for_read_only(native_options, name, 0, &native_error)
        else
            c.rocksdb_open(native_options, name, &native_error);
        // A successful handle is never leaked if a native implementation also
        // reports an error. Native libraries own all failure-message allocations.
        errdefer if (handle) |db| c.rocksdb_close(db);
        try check(native_error, options.diagnostic);
        return .{
            .handle = handle orelse return error.NativeAllocation,
            .read_options = read_options,
            .write_options = write_options,
            .read_only = options.read_only,
            .sync = options.sync,
            .diagnostic = options.diagnostic,
        };
    }

    pub fn deinit(self: *Database) void {
        sync_stats.dump();
        c.rocksdb_close(self.handle);
        c.rocksdb_readoptions_destroy(self.read_options);
        c.rocksdb_writeoptions_destroy(self.write_options);
        self.* = undefined;
    }

    pub fn get(self: *Database, allocator: Allocator, key: []const u8) !?[]u8 {
        var length: usize = 0;
        var native_error: ?[*:0]u8 = null;
        const value = c.rocksdb_get(self.handle, self.read_options, key.ptr, key.len, &length, &native_error);
        defer if (value) |ptr| c.rocksdb_free(ptr);
        try check(native_error, self.diagnostic);
        return if (value) |ptr| try allocator.dupe(u8, ptr[0..length]) else null;
    }

    pub fn put(self: *Database, key: []const u8, value: []const u8) !void {
        if (self.read_only) return error.ReadOnly;
        var native_error: ?[*:0]u8 = null;
        const before = self.sequence();
        c.rocksdb_put(self.handle, self.write_options, key.ptr, key.len, value.ptr, value.len, &native_error);
        try check(native_error, self.diagnostic);
        if (self.sync) self.coveredThrough(before);
        sync_stats.record(if (self.sync) .synced_write else .write, @returnAddress());
    }

    pub fn delete(self: *Database, key: []const u8) !void {
        if (self.read_only) return error.ReadOnly;
        var native_error: ?[*:0]u8 = null;
        const before = self.sequence();
        c.rocksdb_delete(self.handle, self.write_options, key.ptr, key.len, &native_error);
        try check(native_error, self.diagnostic);
        if (self.sync) self.coveredThrough(before);
        sync_stats.record(if (self.sync) .synced_write else .write, @returnAddress());
    }

    pub fn sequence(self: *const Database) u64 {
        return c.rocksdb_get_latest_sequence_number(self.handle);
    }

    /// A WAL sync that started after `before` was visible returned OK. Every
    /// visible write was already appended to the WAL, which syncs in order.
    fn coveredThrough(self: *Database, before: u64) void {
        _ = self.wal_syncs.fetchAdd(1, .monotonic);
        _ = self.synced.fetchMax(before, .acq_rel);
    }

    /// True while a deferred commit on this database is not yet covered by a
    /// WAL sync.
    pub fn owesSync(self: *const Database) bool {
        return self.owed.load(.acquire) > self.synced.load(.acquire);
    }

    /// Pays any durability debt with one WAL fsync; a no-op (no syscall)
    /// when every deferred write is already covered by a later synced commit.
    pub fn ensureDurable(self: *Database) !void {
        if (!self.owesSync()) return;
        const before = self.sequence();
        var native_error: ?[*:0]u8 = null;
        c.rocksdb_flush_wal(self.handle, 1, &native_error);
        try check(native_error, self.diagnostic);
        sync_stats.record(.wal_sync, @returnAddress());
        self.coveredThrough(before);
    }

    /// Call immediately before an external effect (see `Durability`). Tests
    /// fail if an uncovered deferred write reaches an effect, proving each
    /// deferral has its covering sync; production pays any debt instead.
    pub fn effectGate(self: *Database) !void {
        if (@import("builtin").is_test and thread_debt.database == self and thread_debt.sequence > self.synced.load(.acquire)) return error.UnsyncedWriteBeforeEffect;
        try self.ensureDurable();
    }

    pub fn batch(self: *Database) !Batch {
        if (self.read_only) return error.ReadOnly;
        return .{ .database = self, .handle = c.rocksdb_writebatch_create() orelse return error.NativeAllocation };
    }

    fn entryAt(self: *Database, allocator: Allocator, key: []const u8, forward: bool) !?Entry {
        const iterator = c.rocksdb_create_iterator(self.handle, self.read_options) orelse return error.NativeAllocation;
        defer c.rocksdb_iter_destroy(iterator);
        if (forward) c.rocksdb_iter_seek(iterator, key.ptr, key.len) else c.rocksdb_iter_seek_for_prev(iterator, key.ptr, key.len);
        var native_error: ?[*:0]u8 = null;
        c.rocksdb_iter_get_error(iterator, &native_error);
        try check(native_error, self.diagnostic);
        if (c.rocksdb_iter_valid(iterator) == 0) return null;
        var key_len: usize = 0;
        const native_key = c.rocksdb_iter_key(iterator, &key_len);
        const stored_key = try allocator.dupe(u8, native_key[0..key_len]);
        errdefer allocator.free(stored_key);
        var value_len: usize = 0;
        const native_value = c.rocksdb_iter_value(iterator, &value_len);
        return .{ .key = stored_key, .value = try allocator.dupe(u8, native_value[0..value_len]), .allocator = allocator };
    }

    pub fn atOrAfter(self: *Database, allocator: Allocator, key: []const u8) !?Entry {
        return self.entryAt(allocator, key, true);
    }

    pub fn atOrBefore(self: *Database, allocator: Allocator, key: []const u8) !?Entry {
        return self.entryAt(allocator, key, false);
    }

    pub fn lastFixedKey(self: *Database, comptime size: usize, allocator: Allocator, prefix_bytes: []const u8) !?[size]u8 {
        const start = try std.mem.concat(allocator, u8, &.{ prefix_bytes, &([_]u8{255} ** size) });
        defer allocator.free(start);
        var bounded = try Bounded.open(self, allocator, prefix_bytes);
        defer bounded.deinit(allocator);
        const iterator = bounded.handle;
        c.rocksdb_iter_seek_for_prev(iterator, start.ptr, start.len);
        while (true) {
            var native_error: ?[*:0]u8 = null;
            c.rocksdb_iter_get_error(iterator, &native_error);
            try check(native_error, self.diagnostic);
            if (c.rocksdb_iter_valid(iterator) == 0) return null;
            var length: usize = 0;
            const key = c.rocksdb_iter_key(iterator, &length)[0..length];
            if (!std.mem.startsWith(u8, key, prefix_bytes)) return null;
            const suffix = key[prefix_bytes.len..];
            if (suffix.len == size) return suffix[0..size].*;
            c.rocksdb_iter_prev(iterator);
        }
    }

    pub fn prefix(self: *Database, allocator: Allocator, prefix_bytes: []const u8) !PrefixIterator {
        return self.prefixFrom(allocator, prefix_bytes, "");
    }

    /// `prefix`, positioned at the first entry at or after `prefix_bytes ++ start`.
    pub fn prefixFrom(self: *Database, allocator: Allocator, prefix_bytes: []const u8, start: []const u8) !PrefixIterator {
        var bounded = try Bounded.open(self, allocator, prefix_bytes);
        errdefer bounded.deinit(allocator);
        if (start.len == 0) {
            c.rocksdb_iter_seek(bounded.handle, prefix_bytes.ptr, prefix_bytes.len);
        } else {
            const key = try std.mem.concat(allocator, u8, &.{ prefix_bytes, start });
            defer allocator.free(key);
            c.rocksdb_iter_seek(bounded.handle, key.ptr, key.len);
        }
        var iterator: PrefixIterator = .{ .handle = bounded.handle, .bounded = bounded, .allocator = allocator, .prefix_bytes = bounded.lower(), .diagnostic = self.diagnostic };
        try iterator.status();
        return iterator;
    }
};

extern fn rocksdb_readoptions_set_iterate_upper_bound(*c.ReadOptions, ?[*]const u8, usize) void;
extern fn rocksdb_readoptions_set_iterate_lower_bound(*c.ReadOptions, ?[*]const u8, usize) void;

/// A native iterator confined to keys starting with a prefix. RocksDB then
/// stops at the prefix's end (and, backwards, its start) instead of stepping
/// into the next table, and skips files and tombstones outside it. The bound
/// keys are borrowed by the native read options, so both are owned here and
/// outlive the iterator.
const Bounded = struct {
    handle: *c.Iterator,
    options: *c.ReadOptions,
    /// prefix ++ successor(prefix) (the successor is absent for an all-0xff
    /// or empty prefix, which has no upper bound).
    bounds: []u8,
    prefix_len: usize,

    fn open(database: *Database, allocator: Allocator, prefix_bytes: []const u8) !Bounded {
        const upper = keys.successor(allocator, prefix_bytes) catch |err| switch (err) {
            error.NoPrefixUpperBound => null,
            else => return err,
        };
        defer if (upper) |bytes| allocator.free(bytes);
        const bounds = try std.mem.concat(allocator, u8, &.{ prefix_bytes, upper orelse "" });
        errdefer allocator.free(bounds);
        const options = c.rocksdb_readoptions_create() orelse return error.NativeAllocation;
        errdefer c.rocksdb_readoptions_destroy(options);
        if (prefix_bytes.len > 0) rocksdb_readoptions_set_iterate_lower_bound(options, bounds.ptr, prefix_bytes.len);
        if (upper != null) rocksdb_readoptions_set_iterate_upper_bound(options, bounds[prefix_bytes.len..].ptr, bounds.len - prefix_bytes.len);
        const handle = c.rocksdb_create_iterator(database.handle, options) orelse return error.NativeAllocation;
        return .{ .handle = handle, .options = options, .bounds = bounds, .prefix_len = prefix_bytes.len };
    }

    fn lower(self: Bounded) []u8 {
        return self.bounds[0..self.prefix_len];
    }

    fn deinit(self: *Bounded, allocator: Allocator) void {
        c.rocksdb_iter_destroy(self.handle);
        c.rocksdb_readoptions_destroy(self.options);
        allocator.free(self.bounds);
        self.* = undefined;
    }
};

pub const Batch = struct {
    database: *Database,
    handle: ?*c.WriteBatch,

    pub fn deinit(self: *Batch) void {
        if (self.handle) |handle| c.rocksdb_writebatch_destroy(handle);
        self.handle = null;
    }

    pub fn put(self: *Batch, key: []const u8, value: []const u8) !void {
        const handle = self.handle orelse return error.ClosedBatch;
        c.rocksdb_writebatch_put(handle, key.ptr, key.len, value.ptr, value.len);
    }

    pub fn delete(self: *Batch, key: []const u8) !void {
        const handle = self.handle orelse return error.ClosedBatch;
        c.rocksdb_writebatch_delete(handle, key.ptr, key.len);
    }

    /// Staged operations (puts, deletes, range deletes).
    pub fn count(self: *const Batch) usize {
        const handle = self.handle orelse return 0;
        return @intCast(c.rocksdb_writebatch_count(handle));
    }

    pub fn deleteRange(self: *Batch, start: []const u8, end: []const u8) !void {
        const handle = self.handle orelse return error.ClosedBatch;
        if (std.mem.order(u8, start, end) != .lt) return error.InvalidDeleteRange;
        c.rocksdb_writebatch_delete_range(handle, start.ptr, start.len, end.ptr, end.len);
    }
    pub fn deletePrefix(self: *Batch, allocator: Allocator, prefix_bytes: []const u8) !void {
        const handle = self.handle orelse return error.ClosedBatch;
        const end = try keys.successor(allocator, prefix_bytes);
        defer allocator.free(end);
        c.rocksdb_writebatch_delete_range(handle, prefix_bytes.ptr, prefix_bytes.len, end.ptr, end.len);
    }

    /// Force WAL fsync for this batch without changing shared DB write options.
    pub fn commitSync(self: *Batch) !void {
        return self.commitWithSync(true);
    }

    /// WAL write without fsync, even on a sync=true Database. Only for rows
    /// that are hints whose loss is safe: the WAL is ordered, so any later
    /// synced commit also persists this record.
    pub fn commitUnsynced(self: *Batch) !void {
        return self.commitWithSync(false);
    }

    /// `.sync` is `commitSync`. `.deferred` is a WAL write whose caller owes
    /// a covering synced commit before any external effect (see
    /// `Durability`); on a sync=false database it is the plain unsynced
    /// commit and creates no debt.
    pub fn commitWith(self: *Batch, durability: Durability) !void {
        if (durability == .sync) return self.commitSync();
        if (!self.database.sync) return self.commit();
        try self.commitWithSync(false);
        const sequence = self.database.sequence();
        _ = self.database.owed.fetchMax(sequence, .acq_rel);
        if (@import("builtin").is_test) thread_debt = .{ .database = self.database, .sequence = sequence };
    }

    fn commitWithSync(self: *Batch, sync: bool) !void {
        const handle = self.handle orelse return error.ClosedBatch;
        const options = c.rocksdb_writeoptions_create() orelse return error.NativeAllocation;
        defer c.rocksdb_writeoptions_destroy(options);
        c.rocksdb_writeoptions_set_sync(options, @intFromBool(sync));
        c.rocksdb_writeoptions_disable_WAL(options, 0);
        var native_error: ?[*:0]u8 = null;
        const before = self.database.sequence();
        c.rocksdb_write(self.database.handle, options, handle, &native_error);
        try check(native_error, self.database.diagnostic);
        if (sync) self.database.coveredThrough(before);
        sync_stats.record(if (sync) .synced_write else .write, @returnAddress());
        self.deinit();
    }

    /// Native WriteBatch is atomic. sync=true on Database adds the WAL fsync.
    /// On error, the caller must resolve uncertain outcome before higher-level retry.
    pub fn commit(self: *Batch) !void {
        const handle = self.handle orelse return error.ClosedBatch;
        var native_error: ?[*:0]u8 = null;
        const before = self.database.sequence();
        c.rocksdb_write(self.database.handle, self.database.write_options, handle, &native_error);
        try check(native_error, self.database.diagnostic);
        if (self.database.sync) self.database.coveredThrough(before);
        sync_stats.record(if (self.database.sync) .synced_write else .write, @returnAddress());
        self.deinit();
    }
};

pub const Entry = struct {
    key: []u8,
    value: []u8,
    allocator: Allocator,
    pub fn deinit(self: *Entry) void {
        self.allocator.free(self.key);
        self.allocator.free(self.value);
        self.* = undefined;
    }
};

pub const PrefixIterator = struct {
    handle: *c.Iterator,
    /// Owns `handle` and `prefix_bytes`.
    bounded: Bounded,
    allocator: Allocator,
    prefix_bytes: []u8,
    diagnostic: ?*Diagnostic,
    /// `nextBorrowed` steps past the entry it returned on the following call.
    advance: bool = false,

    pub const Borrowed = struct { key: []const u8, value: []const u8 };

    pub fn deinit(self: *PrefixIterator) void {
        self.bounded.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn status(self: *PrefixIterator) !void {
        var native_error: ?[*:0]u8 = null;
        c.rocksdb_iter_get_error(self.handle, &native_error);
        try check(native_error, self.diagnostic);
    }

    pub fn next(self: *PrefixIterator, allocator: Allocator) !?Entry {
        try self.status();
        if (c.rocksdb_iter_valid(self.handle) == 0) return null;
        var key_len: usize = 0;
        const native_key = c.rocksdb_iter_key(self.handle, &key_len);
        if (!std.mem.startsWith(u8, native_key[0..key_len], self.prefix_bytes)) return null;
        const key = try allocator.dupe(u8, native_key[0..key_len]);
        errdefer allocator.free(key);
        var value_len: usize = 0;
        const native_value = c.rocksdb_iter_value(self.handle, &value_len);
        const value = try allocator.dupe(u8, native_value[0..value_len]);
        errdefer allocator.free(value);
        c.rocksdb_iter_next(self.handle);
        try self.status();
        return .{ .key = key, .value = value, .allocator = allocator };
    }

    /// The next entry without copying: `key` excludes the prefix. Both slices
    /// borrow native memory valid until the following call or deinit. Do not
    /// mix with `next` on one iterator.
    pub fn nextBorrowed(self: *PrefixIterator) !?Borrowed {
        if (self.advance) c.rocksdb_iter_next(self.handle);
        self.advance = true;
        try self.status();
        if (c.rocksdb_iter_valid(self.handle) == 0) return null;
        var key_len: usize = 0;
        const native_key = c.rocksdb_iter_key(self.handle, &key_len)[0..key_len];
        if (!std.mem.startsWith(u8, native_key, self.prefix_bytes)) return null;
        var value_len: usize = 0;
        const native_value = c.rocksdb_iter_value(self.handle, &value_len);
        return .{ .key = native_key[self.prefix_bytes.len..], .value = native_value[0..value_len] };
    }
};

/// Borrows database/domain name. Encoded keys/values remain explicit, so decoded
/// variable-length message bodies cannot outlive a freed native get buffer.
pub const Typed = struct {
    database: *Database,
    domain_name: []const u8,

    pub fn get(self: Typed, allocator: Allocator, table_prefix: []const u8, encoded_key: []const u8) !?[]u8 {
        const key = try keys.scoped(allocator, self.domain_name, table_prefix, encoded_key);
        defer allocator.free(key);
        return self.database.get(allocator, key);
    }

    pub fn put(self: Typed, allocator: Allocator, table_prefix: []const u8, encoded_key: []const u8, encoded_value: []const u8) !void {
        const key = try keys.scoped(allocator, self.domain_name, table_prefix, encoded_key);
        defer allocator.free(key);
        try self.database.put(key, encoded_value);
    }

    pub fn prefix(self: Typed, allocator: Allocator, table_prefix: []const u8) !PrefixIterator {
        const key = try keys.scoped(allocator, self.domain_name, table_prefix, "");
        defer allocator.free(key);
        return self.database.prefix(allocator, key);
    }

    /// `prefix`, starting at the first entry at or after `encoded_key`.
    pub fn prefixFrom(self: Typed, allocator: Allocator, table_prefix: []const u8, encoded_key: []const u8) !PrefixIterator {
        const key = try keys.scoped(allocator, self.domain_name, table_prefix, "");
        defer allocator.free(key);
        return self.database.prefixFrom(allocator, key, encoded_key);
    }

    /// The nearest entry of the table at or after (before) `encoded_key`,
    /// read by an iterator bounded to the table.
    fn entryAt(self: Typed, allocator: Allocator, table_prefix: []const u8, encoded_key: []const u8, forward: bool) !?Entry {
        const full_prefix = try keys.scoped(allocator, self.domain_name, table_prefix, "");
        defer allocator.free(full_prefix);
        const start = try std.mem.concat(allocator, u8, &.{ full_prefix, encoded_key });
        defer allocator.free(start);
        var bounded = try Bounded.open(self.database, allocator, full_prefix);
        defer bounded.deinit(allocator);
        const iterator = bounded.handle;
        if (forward) c.rocksdb_iter_seek(iterator, start.ptr, start.len) else c.rocksdb_iter_seek_for_prev(iterator, start.ptr, start.len);
        var native_error: ?[*:0]u8 = null;
        c.rocksdb_iter_get_error(iterator, &native_error);
        try check(native_error, self.database.diagnostic);
        if (c.rocksdb_iter_valid(iterator) == 0) return null;
        var key_len: usize = 0;
        const native_key = c.rocksdb_iter_key(iterator, &key_len)[0..key_len];
        if (!std.mem.startsWith(u8, native_key, full_prefix)) return null;
        const suffix = try allocator.dupe(u8, native_key[full_prefix.len..]);
        errdefer allocator.free(suffix);
        var value_len: usize = 0;
        const native_value = c.rocksdb_iter_value(iterator, &value_len);
        return .{ .key = suffix, .value = try allocator.dupe(u8, native_value[0..value_len]), .allocator = allocator };
    }

    pub fn atOrAfter(self: Typed, allocator: Allocator, table_prefix: []const u8, encoded_key: []const u8) !?Entry {
        return self.entryAt(allocator, table_prefix, encoded_key, true);
    }

    pub fn atOrBefore(self: Typed, allocator: Allocator, table_prefix: []const u8, encoded_key: []const u8) !?Entry {
        return self.entryAt(allocator, table_prefix, encoded_key, false);
    }

    pub fn lastFixedKey(self: Typed, comptime size: usize, allocator: Allocator, table_prefix: []const u8) !?[size]u8 {
        const full_prefix = try keys.scoped(allocator, self.domain_name, table_prefix, "");
        defer allocator.free(full_prefix);
        return self.database.lastFixedKey(size, allocator, full_prefix);
    }

    pub fn batch(self: Typed, allocator: Allocator) !TypedBatch {
        return .{ .batch = try self.database.batch(), .domain_name = self.domain_name, .allocator = allocator };
    }
};

pub const TypedBatch = struct {
    batch: Batch,
    domain_name: []const u8,
    allocator: Allocator,

    pub fn deinit(self: *TypedBatch) void {
        self.batch.deinit();
    }

    pub fn put(self: *TypedBatch, table_prefix: []const u8, encoded_key: []const u8, encoded_value: []const u8) !void {
        const key = try keys.scoped(self.allocator, self.domain_name, table_prefix, encoded_key);
        defer self.allocator.free(key);
        try self.batch.put(key, encoded_value);
    }

    pub fn delete(self: *TypedBatch, table_prefix: []const u8, encoded_key: []const u8) !void {
        const key = try keys.scoped(self.allocator, self.domain_name, table_prefix, encoded_key);
        defer self.allocator.free(key);
        try self.batch.delete(key);
    }

    pub fn deleteAtOrAfter(self: *TypedBatch, table_prefix: []const u8, encoded_key: []const u8) !void {
        const prefix = try keys.scoped(self.allocator, self.domain_name, table_prefix, "");
        defer self.allocator.free(prefix);
        const start = try keys.scoped(self.allocator, self.domain_name, table_prefix, encoded_key);
        defer self.allocator.free(start);
        const end = try keys.successor(self.allocator, prefix);
        defer self.allocator.free(end);
        try self.batch.deleteRange(start, end);
    }
    pub fn deletePrefix(self: *TypedBatch, table_prefix: []const u8) !void {
        const key = try keys.scoped(self.allocator, self.domain_name, table_prefix, "");
        defer self.allocator.free(key);
        try self.batch.deletePrefix(self.allocator, key);
    }

    pub fn commitSync(self: *TypedBatch) !void {
        try self.batch.commitSync();
    }

    pub fn commitUnsynced(self: *TypedBatch) !void {
        try self.batch.commitUnsynced();
    }

    pub fn commit(self: *TypedBatch) !void {
        try self.batch.commit();
    }

    pub fn commitWith(self: *TypedBatch, durability: Durability) !void {
        try self.batch.commitWith(durability);
    }
};
