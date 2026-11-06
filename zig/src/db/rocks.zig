//! Optional native adapter for the SAME RocksDB engine used by Rust agents.
//! Owners are move-only by convention. Destroy batches/iterators before their DB;
//! returned get/iterator bytes are independent allocations owned by the caller.
const std = @import("std");
const c = @import("c.zig");
const keys = @import("keys.zig");
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
    diagnostic: ?*Diagnostic,

    pub fn open(allocator: Allocator, path: []const u8, options: OpenOptions) !Database {
        try @import("native_abi.zig").verify();
        if (std.mem.indexOfScalar(u8, path, 0) != null) return error.InvalidPath;
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
            .diagnostic = options.diagnostic,
        };
    }

    pub fn deinit(self: *Database) void {
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
        c.rocksdb_put(self.handle, self.write_options, key.ptr, key.len, value.ptr, value.len, &native_error);
        try check(native_error, self.diagnostic);
    }

    pub fn delete(self: *Database, key: []const u8) !void {
        if (self.read_only) return error.ReadOnly;
        var native_error: ?[*:0]u8 = null;
        c.rocksdb_delete(self.handle, self.write_options, key.ptr, key.len, &native_error);
        try check(native_error, self.diagnostic);
    }

    pub fn sequence(self: *const Database) u64 {
        return c.rocksdb_get_latest_sequence_number(self.handle);
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
        const iterator = c.rocksdb_create_iterator(self.handle, self.read_options) orelse return error.NativeAllocation;
        defer c.rocksdb_iter_destroy(iterator);
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
        const owned_prefix = try allocator.dupe(u8, prefix_bytes);
        errdefer allocator.free(owned_prefix);
        const handle = c.rocksdb_create_iterator(self.handle, self.read_options) orelse return error.NativeAllocation;
        errdefer c.rocksdb_iter_destroy(handle);
        c.rocksdb_iter_seek(handle, owned_prefix.ptr, owned_prefix.len);
        var iterator: PrefixIterator = .{ .handle = handle, .allocator = allocator, .prefix_bytes = owned_prefix, .diagnostic = self.diagnostic };
        try iterator.status();
        return iterator;
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
        const handle = self.handle orelse return error.ClosedBatch;
        const options = c.rocksdb_writeoptions_create() orelse return error.NativeAllocation;
        defer c.rocksdb_writeoptions_destroy(options);
        c.rocksdb_writeoptions_set_sync(options, 1);
        c.rocksdb_writeoptions_disable_WAL(options, 0);
        var native_error: ?[*:0]u8 = null;
        c.rocksdb_write(self.database.handle, options, handle, &native_error);
        try check(native_error, self.database.diagnostic);
        self.deinit();
    }

    /// Native WriteBatch is atomic. sync=true on Database adds the WAL fsync.
    /// On error, the caller must resolve uncertain outcome before higher-level retry.
    pub fn commit(self: *Batch) !void {
        const handle = self.handle orelse return error.ClosedBatch;
        var native_error: ?[*:0]u8 = null;
        c.rocksdb_write(self.database.handle, self.database.write_options, handle, &native_error);
        try check(native_error, self.database.diagnostic);
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
    allocator: Allocator,
    prefix_bytes: []u8,
    diagnostic: ?*Diagnostic,

    pub fn deinit(self: *PrefixIterator) void {
        c.rocksdb_iter_destroy(self.handle);
        self.allocator.free(self.prefix_bytes);
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

    fn entryAt(self: Typed, allocator: Allocator, table_prefix: []const u8, encoded_key: []const u8, forward: bool) !?Entry {
        const full_prefix = try keys.scoped(allocator, self.domain_name, table_prefix, "");
        defer allocator.free(full_prefix);
        const start = try std.mem.concat(allocator, u8, &.{ full_prefix, encoded_key });
        defer allocator.free(start);
        var entry = (try self.database.entryAt(allocator, start, forward)) orelse return null;
        errdefer entry.deinit();
        if (!std.mem.startsWith(u8, entry.key, full_prefix)) {
            entry.deinit();
            return null;
        }
        const suffix = try allocator.dupe(u8, entry.key[full_prefix.len..]);
        allocator.free(entry.key);
        entry.key = suffix;
        return entry;
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

    pub fn commit(self: *TypedBatch) !void {
        try self.batch.commit();
    }
};
