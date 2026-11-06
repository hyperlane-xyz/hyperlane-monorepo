//! Solana legacy/v0 wire formats, address lookup compilation and PDA/Ed25519
//! primitives. Lookup table ownership, activation and slots are checked by the
//! account decoder before passing addresses into compileV0.
const std = @import("std");
const Ed25519 = std.crypto.sign.Ed25519;
pub const Key = [32]u8;
pub const packet_limit = 1232;
pub const AccountMeta = struct { key: Key, is_signer: bool = false, is_writable: bool = false };
pub const Instruction = struct { program: Key, accounts: []const AccountMeta, data: []const u8 };

pub fn createProgramAddress(seeds: []const []const u8, program: Key) !Key {
    if (seeds.len > 16) return error.TooManySeeds;
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    for (seeds) |seed| {
        if (seed.len > 32) return error.SeedTooLong;
        hasher.update(seed);
    }
    hasher.update(&program);
    hasher.update("ProgramDerivedAddress");
    var key: Key = undefined;
    hasher.final(&key);
    _ = std.crypto.ecc.Edwards25519.fromBytes(key) catch return key;
    return error.AddressOnCurve;
}

pub const ProgramAddress = struct { key: Key, bump: u8 };
pub fn findProgramAddress(seeds: []const []const u8, program: Key) !ProgramAddress {
    if (seeds.len >= 16) return error.TooManySeeds;
    var all_seeds: [16][]const u8 = undefined;
    @memcpy(all_seeds[0..seeds.len], seeds);
    var bump: u8 = 255;
    while (true) : (bump -= 1) {
        all_seeds[seeds.len] = &.{bump};
        const key = createProgramAddress(all_seeds[0 .. seeds.len + 1], program) catch |err| switch (err) {
            error.AddressOnCurve => {
                if (bump == 0) return error.NoProgramAddress;
                continue;
            },
            else => return err,
        };
        return .{ .key = key, .bump = bump };
    }
}

pub const Writer = struct {
    out: []u8,
    pos: usize = 0,
    pub fn bytes(self: *Writer, value: []const u8) !void {
        if (value.len > self.out.len - self.pos) return error.BufferTooSmall;
        @memcpy(self.out[self.pos..][0..value.len], value);
        self.pos += value.len;
    }
    pub fn shortvec(self: *Writer, value: usize) !void {
        if (value > std.math.maxInt(u16)) return error.ShortvecOverflow;
        var remaining = value;
        while (true) {
            var byte: u8 = @intCast(remaining & 127);
            remaining >>= 7;
            if (remaining != 0) byte |= 128;
            try self.bytes(&.{byte});
            if (remaining == 0) return;
        }
    }
};

pub fn readShortvec(bytes: []const u8, pos: *usize) !u16 {
    var value: u16 = 0;
    for (0..3) |i| {
        if (pos.* == bytes.len) return error.TruncatedShortvec;
        const byte = bytes[pos.*];
        pos.* += 1;
        if (i == 2 and byte > 3) return error.ShortvecOverflow;
        if (i != 0 and byte == 0) return error.NoncanonicalShortvec;
        value |= @as(u16, byte & 127) << @intCast(i * 7);
        if (byte & 128 == 0) return value;
    }
    return error.ShortvecOverflow;
}

pub const Compiled = struct { bytes: []const u8, signer_keys: [127]Key, signer_count: u8 };
const KeyMeta = struct { key: Key, signer: bool, writable: bool, invoked: bool = false, nonce: bool = false, loaded: bool = false };

fn addKey(keys: *[256]KeyMeta, count: *usize, key: Key, signer: bool, writable: bool) !void {
    for (keys[0..count.*]) |*entry| {
        if (std.mem.eql(u8, &entry.key, &key)) {
            entry.signer = entry.signer or signer;
            entry.writable = entry.writable or writable;
            return;
        }
    }
    if (count.* == keys.len) return error.TooManyAccountKeys;
    keys[count.*] = .{ .key = key, .signer = signer, .writable = writable };
    count.* += 1;
}

fn category(meta: KeyMeta) u2 {
    return if (meta.signer) (if (meta.writable) 0 else 1) else (if (meta.writable) 2 else 3);
}

fn findIndex(keys: []const KeyMeta, key: Key) !u8 {
    for (keys, 0..) |entry, i| if (std.mem.eql(u8, &entry.key, &key)) return @intCast(i);
    return error.UnknownAccountKey;
}

/// Accounts follow Rust SDK compile order: payer first; then writable signers,
/// readonly signers, writable nonsigners and readonly nonsigners. Each category
/// is ordered lexicographically by public key (the SDK's BTreeMap ordering).
pub fn compileLegacy(payer: Key, blockhash: Key, instructions: []const Instruction, out: []u8) !Compiled {
    var keys: [256]KeyMeta = undefined;
    var count: usize = 0;
    for (instructions) |instruction| {
        try addKey(&keys, &count, instruction.program, false, false);
        for (instruction.accounts) |account| try addKey(&keys, &count, account.key, account.is_signer, account.is_writable);
    }
    try addKey(&keys, &count, payer, true, true);
    const Context = struct {
        payer: Key,
        fn lessThan(ctx: @This(), left: KeyMeta, right: KeyMeta) bool {
            if (std.mem.eql(u8, &left.key, &ctx.payer)) return !std.mem.eql(u8, &right.key, &ctx.payer);
            if (std.mem.eql(u8, &right.key, &ctx.payer)) return false;
            if (category(left) != category(right)) return category(left) < category(right);
            return std.mem.order(u8, &left.key, &right.key) == .lt;
        }
    };
    std.mem.sort(KeyMeta, keys[0..count], Context{ .payer = payer }, Context.lessThan);
    var required: usize = 0;
    var readonly_signed: u8 = 0;
    var readonly_unsigned: u8 = 0;
    var result: Compiled = .{ .bytes = undefined, .signer_keys = undefined, .signer_count = 0 };
    for (keys[0..count]) |entry| {
        if (entry.signer) {
            if (required == result.signer_keys.len) return error.TooManySigners;
            result.signer_keys[required] = entry.key;
            required += 1;
            if (!entry.writable) readonly_signed += 1;
        } else if (!entry.writable) readonly_unsigned += 1;
    }
    result.signer_count = @intCast(required);
    var writer: Writer = .{ .out = out };
    try writer.bytes(&.{ result.signer_count, readonly_signed, readonly_unsigned });
    try writer.shortvec(count);
    for (keys[0..count]) |entry| try writer.bytes(&entry.key);
    try writer.bytes(&blockhash);
    try writer.shortvec(instructions.len);
    for (instructions) |instruction| {
        try writer.bytes(&.{try findIndex(keys[0..count], instruction.program)});
        try writer.shortvec(instruction.accounts.len);
        for (instruction.accounts) |account| try writer.bytes(&.{try findIndex(keys[0..count], account.key)});
        try writer.shortvec(instruction.data.len);
        try writer.bytes(instruction.data);
    }
    result.bytes = out[0..writer.pos];
    return result;
}

pub const LookupTable = struct { key: Key, addresses: []const Key };
const LoadedKey = struct { key: Key, table: usize, index: u8 };

pub fn compileV0(payer: Key, blockhash: Key, instructions: []const Instruction, tables: []const LookupTable, out: []u8) !Compiled {
    if (tables.len > 256) return error.TooManyLookupTables;
    var keys: [256]KeyMeta = undefined;
    var count: usize = 0;
    for (instructions) |instruction| {
        try addKey(&keys, &count, instruction.program, false, false);
        keys[try findIndex(keys[0..count], instruction.program)].invoked = true;
        for (instruction.accounts) |account| try addKey(&keys, &count, account.key, account.is_signer, account.is_writable);
    }
    try addKey(&keys, &count, payer, true, true);
    if (instructions.len != 0) {
        const first = instructions[0];
        if (std.mem.eql(u8, &first.program, &([_]u8{0} ** 32)) and first.data.len >= 4 and std.mem.eql(u8, first.data[0..4], &.{ 4, 0, 0, 0 }) and first.accounts.len != 0)
            keys[try findIndex(keys[0..count], first.accounts[0].key)].nonce = true;
    }
    const Sort = struct {
        fn lexical(_: void, left: KeyMeta, right: KeyMeta) bool {
            return std.mem.order(u8, &left.key, &right.key) == .lt;
        }
        fn staticOrder(payer_key: Key, left: KeyMeta, right: KeyMeta) bool {
            if (std.mem.eql(u8, &left.key, &payer_key)) return !std.mem.eql(u8, &right.key, &payer_key);
            if (std.mem.eql(u8, &right.key, &payer_key)) return false;
            if (category(left) != category(right)) return category(left) < category(right);
            return std.mem.order(u8, &left.key, &right.key) == .lt;
        }
    };
    std.mem.sort(KeyMeta, keys[0..count], {}, Sort.lexical);
    var writable: [256]LoadedKey = undefined;
    var readonly: [256]LoadedKey = undefined;
    var writable_count: usize = 0;
    var readonly_count: usize = 0;
    for (tables, 0..) |table, table_index| {
        if (table.addresses.len > 256) return error.LookupTableIndexOverflow;
        for (keys[0..count]) |*entry| {
            if (entry.loaded or entry.signer or entry.invoked or entry.nonce) continue;
            for (table.addresses, 0..) |key, index| {
                if (!std.mem.eql(u8, &entry.key, &key)) continue;
                const loaded: LoadedKey = .{ .key = key, .table = table_index, .index = @intCast(index) };
                if (entry.writable) {
                    writable[writable_count] = loaded;
                    writable_count += 1;
                } else {
                    readonly[readonly_count] = loaded;
                    readonly_count += 1;
                }
                entry.loaded = true;
                break;
            }
        }
    }
    var all_keys: [256]KeyMeta = undefined;
    var static_count: usize = 0;
    for (keys[0..count]) |entry| if (!entry.loaded) {
        all_keys[static_count] = entry;
        static_count += 1;
    };
    std.mem.sort(KeyMeta, all_keys[0..static_count], payer, Sort.staticOrder);
    var result: Compiled = .{ .bytes = undefined, .signer_keys = undefined, .signer_count = 0 };
    var readonly_signed: u8 = 0;
    var readonly_unsigned: u8 = 0;
    for (all_keys[0..static_count]) |entry| {
        if (entry.signer) {
            if (result.signer_count == result.signer_keys.len) return error.TooManySigners;
            result.signer_keys[result.signer_count] = entry.key;
            result.signer_count += 1;
            if (!entry.writable) readonly_signed += 1;
        } else if (!entry.writable) readonly_unsigned += 1;
    }
    var pos = static_count;
    for (writable[0..writable_count]) |entry| {
        all_keys[pos] = .{ .key = entry.key, .signer = false, .writable = true };
        pos += 1;
    }
    for (readonly[0..readonly_count]) |entry| {
        all_keys[pos] = .{ .key = entry.key, .signer = false, .writable = false };
        pos += 1;
    }
    var writer: Writer = .{ .out = out };
    try writer.bytes(&.{ 0x80, result.signer_count, readonly_signed, readonly_unsigned });
    try writer.shortvec(static_count);
    for (all_keys[0..static_count]) |entry| try writer.bytes(&entry.key);
    try writer.bytes(&blockhash);
    try writer.shortvec(instructions.len);
    for (instructions) |instruction| {
        try writer.bytes(&.{try findIndex(all_keys[0..pos], instruction.program)});
        try writer.shortvec(instruction.accounts.len);
        for (instruction.accounts) |account| try writer.bytes(&.{try findIndex(all_keys[0..pos], account.key)});
        try writer.shortvec(instruction.data.len);
        try writer.bytes(instruction.data);
    }
    var used_table_count: usize = 0;
    for (0..tables.len) |table_index| {
        var used = false;
        for (writable[0..writable_count]) |entry| used = used or entry.table == table_index;
        for (readonly[0..readonly_count]) |entry| used = used or entry.table == table_index;
        if (used) used_table_count += 1;
    }
    try writer.shortvec(used_table_count);
    for (tables, 0..) |table, table_index| {
        var writes: usize = 0;
        var reads: usize = 0;
        for (writable[0..writable_count]) |entry| if (entry.table == table_index) {
            writes += 1;
        };
        for (readonly[0..readonly_count]) |entry| if (entry.table == table_index) {
            reads += 1;
        };
        if (writes == 0 and reads == 0) continue;
        try writer.bytes(&table.key);
        try writer.shortvec(writes);
        for (writable[0..writable_count]) |entry| if (entry.table == table_index) try writer.bytes(&.{entry.index});
        try writer.shortvec(reads);
        for (readonly[0..readonly_count]) |entry| if (entry.table == table_index) try writer.bytes(&.{entry.index});
    }
    result.bytes = out[0..writer.pos];
    return result;
}

/// The driver authorizes signer keys before calling this function. Keypairs are
/// supplied as disposable 32-byte Ed25519 seeds, never read from process globals.
/// Extra, missing and duplicate signers are rejected; no signing request can add
/// an ISM-selected key implicitly. Caller must persist bytes before broadcast.
pub fn signTransaction(compiled: Compiled, seeds: []const Key, out: []u8) ![]u8 {
    if (seeds.len != compiled.signer_count or seeds.len == 0 or seeds.len > 127) return error.InvalidSignerCount;
    if (compiled.bytes.len < 4) return error.InvalidCompiledMessage;
    const version_offset: usize = if (compiled.bytes[0] == 0x80) 1 else 0;
    if (compiled.bytes.len < version_offset + 4 or compiled.bytes[version_offset] != compiled.signer_count) return error.InvalidCompiledMessage;
    var offset: usize = version_offset + 3;
    const key_count = try readShortvec(compiled.bytes, &offset);
    if (key_count < compiled.signer_count or compiled.bytes.len - offset < @as(usize, key_count) * 32 + 32) return error.InvalidCompiledMessage;
    for (compiled.signer_keys[0..compiled.signer_count], 0..) |key, i| {
        if (!std.mem.eql(u8, &key, compiled.bytes[offset + i * 32 ..][0..32])) return error.InvalidCompiledMessage;
    }
    const transaction_len = try std.math.add(usize, 1 + seeds.len * 64, compiled.bytes.len);
    if (transaction_len > packet_limit) return error.TransactionTooLarge;
    if (out.len < transaction_len) return error.BufferTooSmall;
    var key_pairs: [127]Ed25519.KeyPair = undefined;
    for (seeds, 0..) |seed, i| key_pairs[i] = try Ed25519.KeyPair.generateDeterministic(seed);
    var writer: Writer = .{ .out = out };
    try writer.shortvec(compiled.signer_count);
    for (compiled.signer_keys[0..compiled.signer_count], 0..) |key, i| {
        var found: ?usize = null;
        for (key_pairs[0..seeds.len], 0..) |pair, j| {
            if (std.mem.eql(u8, &key, &pair.public_key.toBytes())) {
                if (found != null) return error.DuplicateSigner;
                found = j;
            }
        }
        const pair = key_pairs[found orelse return error.MissingSigner];
        for (compiled.signer_keys[0..i]) |previous| if (std.mem.eql(u8, &previous, &key)) return error.DuplicateSigner;
        const signed = try pair.sign(compiled.bytes, null);
        try writer.bytes(&signed.toBytes());
    }
    try writer.bytes(compiled.bytes);
    if (writer.pos > packet_limit) return error.TransactionTooLarge;
    return out[0..writer.pos];
}

test "shortvec canonical u16 boundary roundtrip and rejection" {
    for ([_]usize{ 0, 1, 127, 128, 255, 16383, 16384, 65535 }) |value| {
        var out: [3]u8 = undefined;
        var writer: Writer = .{ .out = &out };
        try writer.shortvec(value);
        var pos: usize = 0;
        try std.testing.expectEqual(@as(u16, @intCast(value)), try readShortvec(out[0..writer.pos], &pos));
        try std.testing.expectEqual(writer.pos, pos);
    }
    var pos: usize = 0;
    try std.testing.expectError(error.NoncanonicalShortvec, readShortvec(&.{ 128, 0 }, &pos));
    pos = 0;
    try std.testing.expectError(error.ShortvecOverflow, readShortvec(&.{ 255, 255, 4 }, &pos));
}

test "legacy compilation deduplicates merges privileges and signs canonical message" {
    const seed = [_]u8{0} ** 32;
    const key_pair = try Ed25519.KeyPair.generateDeterministic(seed);
    const payer = key_pair.public_key.toBytes();
    const account: AccountMeta = .{ .key = .{1} ** 32, .is_writable = true };
    const instruction: Instruction = .{ .program = .{2} ** 32, .accounts = &.{ account, .{ .key = payer } }, .data = "test" };
    var out: [1232]u8 = undefined;
    const compiled = try compileLegacy(payer, .{3} ** 32, &.{instruction}, &out);
    try std.testing.expectEqualSlices(u8, &.{ 1, 0, 1, 3 }, compiled.bytes[0..4]);
    try std.testing.expectEqualSlices(u8, &payer, compiled.bytes[4..36]);
    var tx: [1232]u8 = undefined;
    const signed = try signTransaction(compiled, &.{seed}, &tx);
    try std.testing.expectEqual(@as(u8, 1), signed[0]);
    try Ed25519.Signature.fromBytes(signed[1..65].*).verify(compiled.bytes, key_pair.public_key);
    try std.testing.expectError(error.InvalidSignerCount, signTransaction(compiled, &.{}, &tx));
    try std.testing.expectError(error.MissingSigner, signTransaction(compiled, &.{.{1} ** 32}, &tx));
}

test "PDA seeds validate limits and canonical bump yields an offcurve key" {
    const seeds = [_][]const u8{ "hyperlane", "-", "inbox" };
    const program = [_]u8{0x11} ** 32;
    const pda = try findProgramAddress(&seeds, program);
    const bumped = [_][]const u8{ "hyperlane", "-", "inbox", &.{pda.bump} };
    try std.testing.expectEqual(pda.key, try createProgramAddress(&bumped, program));
    try std.testing.expectError(error.InvalidEncoding, std.crypto.ecc.Edwards25519.fromBytes(pda.key));
    try std.testing.expectError(error.SeedTooLong, createProgramAddress(&.{&(.{0} ** 33)}, program));
    const too_many = [_][]const u8{""} ** 16;
    try std.testing.expectError(error.TooManySeeds, findProgramAddress(&too_many, program));
}
