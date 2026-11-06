//! Append-only, hash-chained event journal for the experimental runtime. This
//! format is intentionally separate from production RocksDB/Postgres stores.
//! Never open a production agent database with this implementation.
const std = @import("std");
const Hash = [32]u8;
const sha256 = std.crypto.hash.sha2.Sha256;
const magic = "HYPZIG01";
const header_len = 8 + 8 + 4 + 32;
pub const max_payload = 1 << 20;
pub const Frame = struct { sequence: u64, payload: []const u8, end: usize, digest: Hash };
pub const Scan = struct { frames: u64, valid_bytes: usize, digest: Hash, torn_tail: bool };

pub const Reader = struct {
    bytes: []const u8,
    offset: usize = 0,
    sequence: u64 = 0,
    digest: Hash = @splat(0),
    torn_tail: bool = false,

    pub fn next(self: *Reader) !?Frame {
        const remaining = self.bytes[self.offset..];
        if (remaining.len == 0) return null;
        if (remaining.len < header_len) {
            self.torn_tail = true;
            return null;
        }
        if (!std.mem.eql(u8, remaining[0..8], magic)) return error.JournalMagicMismatch;
        const sequence = std.mem.readInt(u64, remaining[8..16], .little);
        if (sequence != self.sequence) return error.JournalSequenceMismatch;
        const length = std.mem.readInt(u32, remaining[16..20], .little);
        if (length > max_payload) return error.JournalPayloadTooLarge;
        if (remaining.len - header_len < length) {
            self.torn_tail = true;
            return null;
        }
        const payload = remaining[header_len..][0..length];
        const digest = frameHash(remaining[0..20], self.digest, payload);
        if (!std.mem.eql(u8, &digest, remaining[20..header_len])) return error.JournalChecksumMismatch;
        self.offset += header_len + length;
        self.sequence = try std.math.add(u64, self.sequence, 1);
        self.digest = digest;
        return .{ .sequence = sequence, .payload = payload, .end = self.offset, .digest = digest };
    }

    pub fn scan(bytes: []const u8) !Scan {
        var reader: Reader = .{ .bytes = bytes };
        while (try reader.next()) |_| {}
        return .{ .frames = reader.sequence, .valid_bytes = reader.offset, .digest = reader.digest, .torn_tail = reader.torn_tail };
    }
};

fn frameHash(header: []const u8, previous: Hash, payload: []const u8) Hash {
    var hash = sha256.init(.{});
    hash.update(&previous);
    hash.update(header);
    hash.update(payload);
    var out: Hash = undefined;
    hash.final(&out);
    return out;
}

pub fn encodeFrame(out: []u8, sequence: u64, previous: Hash, payload: []const u8) ![]u8 {
    if (payload.len > max_payload) return error.JournalPayloadTooLarge;
    if (out.len < header_len + payload.len) return error.NoSpaceLeft;
    @memcpy(out[0..8], magic);
    std.mem.writeInt(u64, out[8..16], sequence, .little);
    std.mem.writeInt(u32, out[16..20], @intCast(payload.len), .little);
    out[20..header_len].* = frameHash(out[0..20], previous, payload);
    @memcpy(out[header_len..][0..payload.len], payload);
    return out[0 .. header_len + payload.len];
}

pub const Journal = struct {
    file: std.fs.File,
    sequence: u64,
    digest: Hash,
    poisoned: bool = false,
    allocator: std.mem.Allocator,
    // A bounded maximum also prevents accidentally loading production stores.
    pub const max_journal_bytes = 256 * 1024 * 1024;

    /// Takes an exclusive file lock. Callers replay the returned bytes before
    /// doing work. Partial final frames are discarded only when explicitly
    /// requested; complete frames with bad hashes always fail closed.
    pub fn open(allocator: std.mem.Allocator, dir: std.fs.Dir, path: []const u8, repair_torn_tail: bool) !struct { journal: Journal, replay: []u8 } {
        // A directory handle binds all synchronization to the actual parent.
        // Callers opening nested journals must open their parent directory first.
        if (path.len == 0 or std.mem.indexOfAny(u8, path, "/\\") != null or std.mem.eql(u8, path, ".") or std.mem.eql(u8, path, "..")) return error.JournalPathMustBeBasename;
        var file = try dir.createFile(path, .{ .read = true, .truncate = false, .mode = 0o600 });
        errdefer file.close();
        if (!try file.tryLock(.exclusive)) return error.JournalAlreadyLocked;
        // fsync(file) alone cannot preserve a newly created directory entry.
        // Establish its durable name before any append may authorize an effect.
        try file.sync();
        // A caller may borrow an O_PATH directory on Linux; reopen the same
        // directory with an ordinary descriptor before synchronizing its entry.
        var sync_dir = try dir.openDir(".", .{ .iterate = true });
        defer sync_dir.close();
        try std.posix.fsync(sync_dir.fd);
        const bytes = try file.readToEndAlloc(allocator, max_journal_bytes);
        errdefer allocator.free(bytes);
        const state = try Reader.scan(bytes);
        if (state.torn_tail and !repair_torn_tail) return error.JournalTornTail;
        if (state.torn_tail) {
            try file.setEndPos(state.valid_bytes);
            try file.sync();
        }
        try file.seekTo(state.valid_bytes);
        return .{
            .journal = .{ .file = file, .sequence = state.frames, .digest = state.digest, .allocator = allocator },
            .replay = bytes,
        };
    }

    pub fn close(self: *Journal) void {
        self.file.close();
        self.* = undefined;
    }

    /// Success means bytes reached the file's synchronization boundary. After
    /// any I/O failure this handle is poisoned: reopen/replay before continuing.
    pub fn append(self: *Journal, payload: []const u8) !void {
        if (self.poisoned) return error.JournalPoisoned;
        if (self.sequence == std.math.maxInt(u64)) return error.JournalSequenceOverflow;
        if (payload.len > max_payload) return error.JournalPayloadTooLarge;
        const position = try self.file.getPos();
        if (position > max_journal_bytes - header_len - payload.len) return error.JournalCapacityReached;
        const buffer = try self.allocator.alloc(u8, header_len + payload.len);
        defer self.allocator.free(buffer);
        const frame = try encodeFrame(buffer, self.sequence, self.digest, payload);
        self.poisoned = true;
        try self.file.writeAll(frame);
        try self.file.sync();
        self.digest = frame[20..header_len].*;
        self.sequence += 1;
        self.poisoned = false;
    }
};

test "every torn write replays only complete frames" {
    var bytes: [256]u8 = undefined;
    const first = try encodeFrame(&bytes, 0, @splat(0), "first");
    const first_len = first.len;
    const previous = first[20..header_len].*;
    const second = try encodeFrame(bytes[first_len..], 1, previous, "second");
    const total = first_len + second.len;
    for (0..total + 1) |length| {
        const scan = try Reader.scan(bytes[0..length]);
        const expected: u64 = if (length < first_len) 0 else if (length < total) 1 else 2;
        try std.testing.expectEqual(expected, scan.frames);
        try std.testing.expectEqual(length != 0 and length != first_len and length != total, scan.torn_tail);
    }
    bytes[total - 1] ^= 1;
    try std.testing.expectError(error.JournalChecksumMismatch, Reader.scan(bytes[0..total]));
}

test "real journal persists, locks and reopens for replay" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const allocator = std.testing.allocator;
    var opened = try Journal.open(allocator, temp.dir, "events.wal", false);
    allocator.free(opened.replay);
    try opened.journal.append("one");
    try opened.journal.append("two");
    try std.testing.expectError(error.JournalAlreadyLocked, Journal.open(allocator, temp.dir, "events.wal", false));
    opened.journal.close();
    var recovered = try Journal.open(allocator, temp.dir, "events.wal", false);
    defer recovered.journal.close();
    defer allocator.free(recovered.replay);
    var reader: Reader = .{ .bytes = recovered.replay };
    try std.testing.expectEqualStrings("one", (try reader.next()).?.payload);
    try std.testing.expectEqualStrings("two", (try reader.next()).?.payload);
    try std.testing.expectEqual(@as(?Frame, null), try reader.next());
}
