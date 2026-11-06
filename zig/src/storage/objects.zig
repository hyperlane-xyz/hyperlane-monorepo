//! Production checkpoint object wire formats. JSON shape/order comes from
//! hyperlane-core serde; snapshot bytes are its Borsh IncrementalMerkle frontier.
const std = @import("std");
const protocol = @import("../protocol/root.zig");
const hex = @import("../evm/codecs.zig");
const Allocator = std.mem.Allocator;
const Value = std.json.Value;
pub const Hash = [32]u8;
pub const Address = [20]u8;
pub const Checkpoint = protocol.Checkpoint;

pub fn Decoded(comptime T: type) type {
    return struct {
        arena: std.heap.ArenaAllocator,
        value: T,

        pub fn deinit(self: *@This()) void {
            self.arena.deinit();
            self.* = undefined;
        }
    };
}

pub const Signature = struct {
    r: u256,
    s: u256,
    v: u64,

    pub fn fromBytes(raw: [65]u8) Signature {
        return .{ .r = std.mem.readInt(u256, raw[0..32], .big), .s = std.mem.readInt(u256, raw[32..64], .big), .v = raw[64] };
    }

    /// Rust's stored serialized_signature truncates v to one byte; recovery
    /// separately consumes the full u64 v from the signature object.
    pub fn bytes(self: Signature) [65]u8 {
        var out: [65]u8 = undefined;
        std.mem.writeInt(u256, out[0..32], self.r, .big);
        std.mem.writeInt(u256, out[32..64], self.s, .big);
        out[64] = @truncate(self.v);
        return out;
    }

    pub fn recover(self: Signature, digest: Hash) !Address {
        const raw = self.bytes();
        return protocol.signature.recoverCompatible(digest, raw[0..32].*, raw[32..64].*, self.v);
    }
};

const SignatureWire = struct { r: []const u8, s: []const u8, v: u64 };
fn signatureWire(allocator: Allocator, signature: Signature) !SignatureWire {
    return .{ .r = try std.fmt.allocPrint(allocator, "0x{x}", .{signature.r}), .s = try std.fmt.allocPrint(allocator, "0x{x}", .{signature.s}), .v = signature.v };
}

const CheckpointWire = struct {
    checkpoint: struct { merkle_tree_hook_address: []const u8, mailbox_domain: u32, root: []const u8, index: u32 },
    message_id: []const u8,
};

fn checkpointWire(allocator: Allocator, checkpoint: Checkpoint) !CheckpointWire {
    return .{
        .checkpoint = .{ .merkle_tree_hook_address = try hex.hexAlloc(allocator, &checkpoint.merkle_tree_hook_address), .mailbox_domain = checkpoint.mailbox_domain, .root = try hex.hexAlloc(allocator, &checkpoint.root), .index = checkpoint.index },
        .message_id = try hex.hexAlloc(allocator, &checkpoint.message_id),
    };
}

pub const SignedCheckpoint = struct {
    value: Checkpoint,
    signature: Signature,

    pub fn sign(value: Checkpoint, key: Hash, noise: ?Hash) !SignedCheckpoint {
        return .{ .value = value, .signature = Signature.fromBytes(try protocol.signature.signDigest(key, value.digest(), noise)) };
    }

    pub fn recover(self: SignedCheckpoint) !Address {
        return self.signature.recover(self.value.digest());
    }

    pub fn toJson(self: SignedCheckpoint, allocator: Allocator) ![]u8 {
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const temp = arena.allocator();
        return std.json.Stringify.valueAlloc(allocator, .{
            .value = try checkpointWire(temp, self.value),
            .signature = try signatureWire(temp, self.signature),
            .serialized_signature = try hex.hexAlloc(temp, &self.signature.bytes()),
        }, .{ .whitespace = .indent_2 });
    }

    pub fn parse(allocator: Allocator, bytes: []const u8) !SignedCheckpoint {
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const root = try parseValue(arena.allocator(), bytes);
        const value = try signedValue(root);
        const checkpoint = try field(value, "checkpoint");
        return .{ .value = .{
            .merkle_tree_hook_address = try hash(try field(checkpoint, "merkle_tree_hook_address")),
            .mailbox_domain = try uint(u32, try field(checkpoint, "mailbox_domain")),
            .root = try hash(try field(checkpoint, "root")),
            .index = try uint(u32, try field(checkpoint, "index")),
            .message_id = try hash(try field(value, "message_id")),
        }, .signature = try parseSignature(try field(root, "signature")) };
    }
};

pub const Announcement = struct {
    validator: Address,
    mailbox_address: Hash,
    mailbox_domain: u32,
    storage_location: []const u8,

    pub fn signingHash(self: Announcement) Hash {
        var domain = std.crypto.hash.sha3.Keccak256.init(.{});
        var number: [4]u8 = undefined;
        std.mem.writeInt(u32, &number, self.mailbox_domain, .big);
        domain.update(&number);
        domain.update(&self.mailbox_address);
        domain.update("HYPERLANE_ANNOUNCEMENT");
        var domain_hash: Hash = undefined;
        domain.final(&domain_hash);
        var hasher = std.crypto.hash.sha3.Keccak256.init(.{});
        hasher.update(&domain_hash);
        hasher.update(self.storage_location);
        var result: Hash = undefined;
        hasher.final(&result);
        return result;
    }

    pub fn digest(self: Announcement) Hash {
        return protocol.ethSignedMessageHash(self.signingHash());
    }
};

pub const SignedAnnouncement = struct {
    value: Announcement,
    signature: Signature,

    pub fn sign(value: Announcement, key: Hash, noise: ?Hash) !SignedAnnouncement {
        return .{ .value = value, .signature = Signature.fromBytes(try protocol.signature.signDigest(key, value.digest(), noise)) };
    }

    pub fn recover(self: SignedAnnouncement) !Address {
        return self.signature.recover(self.value.digest());
    }

    pub fn toJson(self: SignedAnnouncement, allocator: Allocator) ![]u8 {
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const temp = arena.allocator();
        return std.json.Stringify.valueAlloc(allocator, .{
            .value = .{ .validator = try hex.hexAlloc(temp, &self.value.validator), .mailbox_address = try hex.hexAlloc(temp, &self.value.mailbox_address), .mailbox_domain = self.value.mailbox_domain, .storage_location = self.value.storage_location },
            .signature = try signatureWire(temp, self.signature),
            .serialized_signature = try hex.hexAlloc(temp, &self.signature.bytes()),
        }, .{ .whitespace = .indent_2 });
    }

    pub fn parse(allocator: Allocator, bytes: []const u8) !Decoded(SignedAnnouncement) {
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const root = try parseValue(arena.allocator(), bytes);
        const value = try signedValue(root);
        return .{ .arena = arena, .value = .{ .value = .{
            .validator = try hex.fixedHex(20, try string(try field(value, "validator"))),
            .mailbox_address = try hash(try field(value, "mailbox_address")),
            .mailbox_domain = try uint(u32, try field(value, "mailbox_domain")),
            .storage_location = try string(try field(value, "storage_location")),
        }, .signature = try parseSignature(try field(root, "signature")) } };
    }
};

pub const Snapshot = struct {
    index: u32,
    root: Hash,
    tree: [protocol.IncrementalMerkle.snapshot_len]u8,

    pub fn capture(tree: *const protocol.IncrementalMerkle) !Snapshot {
        return .{ .index = try tree.index(), .root = tree.root(), .tree = tree.snapshot() };
    }

    /// Structural consistency only. Signing additionally requires this root to
    /// match an authenticated checkpoint belonging to the configured validator.
    pub fn restore(self: *const Snapshot) !protocol.IncrementalMerkle {
        return protocol.IncrementalMerkle.restore(&self.tree, self.index, self.root);
    }

    pub fn authenticatedRestore(self: *const Snapshot, signed: SignedCheckpoint, expected_signer: Address, domain: u32, hook: Hash) !protocol.IncrementalMerkle {
        if (signed.value.index != self.index or !std.mem.eql(u8, &signed.value.root, &self.root) or signed.value.mailbox_domain != domain or !std.mem.eql(u8, &signed.value.merkle_tree_hook_address, &hook)) return error.SnapshotCheckpointMismatch;
        if (!std.mem.eql(u8, &try signed.recover(), &expected_signer)) return error.SnapshotSignerMismatch;
        return self.restore();
    }

    pub fn toJson(self: *const Snapshot, allocator: Allocator) ![]u8 {
        const root = try hex.hexAlloc(allocator, &self.root);
        defer allocator.free(root);
        return std.json.Stringify.valueAlloc(allocator, .{ .index = self.index, .root = root, .tree = ByteArray{ .bytes = &self.tree } }, .{});
    }

    pub fn parse(allocator: Allocator, bytes: []const u8) !Snapshot {
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const value = try parseValue(arena.allocator(), bytes);
        const raw_tree = try field(value, "tree");
        if (raw_tree != .array or raw_tree.array.items.len != protocol.IncrementalMerkle.snapshot_len) return error.InvalidSnapshotLength;
        var snapshot: Snapshot = .{ .index = try uint(u32, try field(value, "index")), .root = try hash(try field(value, "root")), .tree = undefined };
        for (raw_tree.array.items, 0..) |item, i| snapshot.tree[i] = try uint(u8, item);
        _ = try snapshot.restore();
        return snapshot;
    }
};

const ByteArray = struct {
    bytes: []const u8,
    pub fn jsonStringify(self: ByteArray, writer: *std.json.Stringify) !void {
        try writer.beginArray();
        for (self.bytes) |byte| try writer.write(@as(u16, byte));
        try writer.endArray();
    }
};

pub const ReorgPeriod = union(enum) {
    none,
    blocks: u32,
    tag: []const u8,

    pub fn jsonStringify(self: ReorgPeriod, writer: *std.json.Stringify) !void {
        switch (self) {
            .none => try writer.write(@as(u32, 0)),
            .blocks => |blocks| try writer.write(blocks),
            .tag => |tag| try writer.write(tag),
        }
    }
};

pub const ReorgEvent = struct {
    local_merkle_root: Hash,
    canonical_merkle_root: Hash,
    checkpoint_index: u32,
    unix_timestamp: u64,
    reorg_period: ReorgPeriod,

    pub fn toJson(self: ReorgEvent, allocator: Allocator) ![]u8 {
        const local = try hex.hexAlloc(allocator, &self.local_merkle_root);
        defer allocator.free(local);
        const canonical = try hex.hexAlloc(allocator, &self.canonical_merkle_root);
        defer allocator.free(canonical);
        return std.json.Stringify.valueAlloc(allocator, .{ .local_merkle_root = local, .canonical_merkle_root = canonical, .checkpoint_index = self.checkpoint_index, .unix_timestamp = self.unix_timestamp, .reorg_period = self.reorg_period }, .{ .whitespace = .indent_2 });
    }

    pub fn parse(allocator: Allocator, bytes: []const u8) !Decoded(ReorgEvent) {
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const value = try parseValue(arena.allocator(), bytes);
        const period = try field(value, "reorg_period");
        const reorg_period: ReorgPeriod = if (period == .string) blk: {
            const digits = if (std.mem.startsWith(u8, period.string, "+")) period.string[1..] else period.string;
            if (digits.len == 0) break :blk .{ .tag = period.string };
            for (digits) |byte| if (!std.ascii.isDigit(byte)) break :blk .{ .tag = period.string };
            const numeric = std.fmt.parseInt(u32, period.string, 10) catch break :blk .{ .tag = period.string };
            break :blk if (numeric == 0) .none else .{ .blocks = numeric };
        } else blk: {
            const numeric = try uint(u32, period);
            break :blk if (numeric == 0) .none else .{ .blocks = numeric };
        };
        return .{ .arena = arena, .value = .{ .local_merkle_root = try hash(try field(value, "local_merkle_root")), .canonical_merkle_root = try hash(try field(value, "canonical_merkle_root")), .checkpoint_index = try uint(u32, try field(value, "checkpoint_index")), .unix_timestamp = try uint(u64, try field(value, "unix_timestamp")), .reorg_period = reorg_period } };
    }
};

fn parseValue(allocator: Allocator, bytes: []const u8) !Value {
    return std.json.parseFromSliceLeaky(Value, allocator, bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
}

pub fn field(value: Value, key: []const u8) !Value {
    if (value != .object) return error.InvalidCheckpointObject;
    return value.object.get(key) orelse error.InvalidCheckpointObject;
}

fn signedValue(value: Value) !Value {
    if (value != .object) return error.InvalidCheckpointObject;
    var result: ?Value = null;
    for ([_][]const u8{ "value", "checkpoint", "announcement" }) |key| {
        if (value.object.get(key)) |found| {
            if (result != null) return error.DuplicateSignedValue;
            result = found;
        }
    }
    return result orelse error.InvalidCheckpointObject;
}

pub fn string(value: Value) ![]const u8 {
    if (value != .string) return error.InvalidCheckpointObject;
    return value.string;
}

pub fn uint(comptime T: type, value: Value) !T {
    return switch (value) {
        .integer => |n| if (n < 0 or n > std.math.maxInt(T)) error.InvalidCheckpointInteger else @intCast(n),
        .number_string => |text| std.fmt.parseInt(T, text, 10),
        else => error.InvalidCheckpointInteger,
    };
}

fn hash(value: Value) !Hash {
    return hex.fixedHex(32, try string(value));
}

fn parseSignature(value: Value) !Signature {
    return .{ .r = try uintHex(try field(value, "r")), .s = try uintHex(try field(value, "s")), .v = try uint(u64, try field(value, "v")) };
}

fn uintHex(value: Value) !u256 {
    const text = try string(value);
    if (text.len < 3 or text.len > 66 or !std.mem.startsWith(u8, text, "0x")) return error.InvalidCheckpointInteger;
    for (text[2..]) |byte| if (!std.ascii.isHex(byte)) return error.InvalidCheckpointInteger;
    return std.fmt.parseInt(u256, text[2..], 16);
}

fn joinChunks(allocator: Allocator, value: Value) ![]u8 {
    if (value != .array) return error.InvalidFixture;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    for (value.array.items) |part| try out.appendSlice(allocator, try string(part));
    return out.toOwnedSlice(allocator);
}

fn fixtureHash(allocator: Allocator, value: Value) !Hash {
    const text = try joinChunks(allocator, value);
    const out = try allocator.alloc(u8, 32);
    _ = try std.fmt.hexToBytes(out, text);
    return out[0..32].*;
}

test "23 production Rust checkpoint announcement snapshot reorg and index objects" {
    const fixture_bytes = try @import("../testing/fixture.zig").bytes(std.testing.allocator, @embedFile("fixtures/objects.jsonl.gz"), 16 * 1024 * 1024);
    defer std.testing.allocator.free(fixture_bytes);
    var lines = std.mem.tokenizeScalar(u8, fixture_bytes, '\n');
    var count: usize = 0;
    while (lines.next()) |line| {
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        const fixture = try parseValue(allocator, line);
        const kind = try string(try field(fixture, "kind"));
        const wire = try joinChunks(allocator, try field(fixture, "wire_utf8_chunks"));
        const canonical = if (fixture.object.get("canonical_wire_utf8_chunks")) |chunks| try joinChunks(allocator, chunks) else wire;
        if (std.mem.startsWith(u8, kind, "checkpoint")) {
            const checkpoint = try SignedCheckpoint.parse(allocator, wire);
            try std.testing.expectEqualStrings(canonical, try checkpoint.toJson(allocator));
            if (fixture.object.get("digest")) |expected| try std.testing.expectEqual(try fixtureHash(allocator, expected), checkpoint.value.digest());
            if (fixture.object.get("signing_hash")) |expected| try std.testing.expectEqual(try fixtureHash(allocator, expected), checkpoint.value.signingHash());
            try std.testing.expectEqual(try protocol.signature.secretKeyAddress(.{0x11} ** 32), try checkpoint.recover());
        } else if (std.mem.startsWith(u8, kind, "announcement")) {
            var decoded = try SignedAnnouncement.parse(allocator, wire);
            defer decoded.deinit();
            try std.testing.expectEqualStrings(canonical, try decoded.value.toJson(allocator));
            if (fixture.object.get("digest")) |expected| try std.testing.expectEqual(try fixtureHash(allocator, expected), decoded.value.value.digest());
            if (fixture.object.get("signing_hash")) |expected| try std.testing.expectEqual(try fixtureHash(allocator, expected), decoded.value.value.signingHash());
        } else if (std.mem.eql(u8, kind, "snapshot")) {
            const snapshot = try Snapshot.parse(allocator, wire);
            try std.testing.expectEqualStrings(canonical, try snapshot.toJson(allocator));
            const borsh_hex = try joinChunks(allocator, try field(fixture, "borsh_hex_chunks"));
            const borsh = try allocator.alloc(u8, borsh_hex.len / 2);
            _ = try std.fmt.hexToBytes(borsh, borsh_hex);
            try std.testing.expectEqualSlices(u8, borsh, &snapshot.tree);
            try std.testing.expectEqual(try uint(u32, try field(fixture, "count")), (try snapshot.restore()).count);
        } else if (std.mem.eql(u8, kind, "reorg_event")) {
            var decoded = try ReorgEvent.parse(allocator, wire);
            defer decoded.deinit();
            try std.testing.expectEqualStrings(canonical, try decoded.value.toJson(allocator));
        } else if (std.mem.eql(u8, kind, "latest_index")) {
            try std.testing.expectEqual(try uint(u32, try field(fixture, "index")), try std.fmt.parseInt(u32, wire, 10));
        } else if (!std.mem.eql(u8, kind, "reorg_malformed")) return error.InvalidFixture;
        count += 1;
    }
    try std.testing.expectEqual(@as(usize, 23), count);
}
