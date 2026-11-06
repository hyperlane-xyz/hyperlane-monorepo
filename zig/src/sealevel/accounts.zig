//! Exact on-chain account layouts from rust/sealevel/{programs,libraries}.
//! Decode does not establish trust: verify owner, PDA and finalized RPC context.
const std = @import("std");
const borsh = @import("borsh.zig");
const solana = @import("../altvm/solana.zig");
const protocol = @import("../protocol/root.zig");
pub const Key = [32]u8;

pub fn inboxPda(program: Key) !solana.ProgramAddress {
    return solana.findProgramAddress(&.{ "hyperlane", "-", "inbox" }, program);
}
pub fn outboxPda(program: Key) !solana.ProgramAddress {
    return solana.findProgramAddress(&.{ "hyperlane", "-", "outbox" }, program);
}
pub fn dispatchedPda(program: Key, unique: Key) !solana.ProgramAddress {
    return solana.findProgramAddress(&.{ "hyperlane", "-", "dispatched_message", "-", &unique }, program);
}
pub fn processedPda(program: Key, message_id: Key) !solana.ProgramAddress {
    return solana.findProgramAddress(&.{ "hyperlane", "-", "processed_message", "-", &message_id }, program);
}
pub fn processAuthorityPda(program: Key, recipient: Key) !solana.ProgramAddress {
    return solana.findProgramAddress(&.{ "hyperlane", "-", "process_authority", "-", &recipient }, program);
}
pub fn gasPaymentPda(program: Key, unique: Key) !solana.ProgramAddress {
    return solana.findProgramAddress(&.{ "hyperlane_igp", "-", "gas_payment", "-", &unique }, program);
}

fn verifyKey(program: Key, key: Key, owner: Key, expected: Key) !void {
    if (!std.mem.eql(u8, &program, &owner)) return error.WrongAccountOwner;
    if (!std.mem.eql(u8, &key, &expected)) return error.WrongAccountAddress;
}

pub const Inbox = struct {
    local_domain: u32,
    bump: u8,
    default_ism: Key,
    processed_count: u64,
    pub fn decode(data: []const u8) !Inbox {
        var reader: borsh.Reader = .{ .bytes = data };
        try reader.initialized();
        return .{ .local_domain = try reader.uint(u32), .bump = try reader.uint(u8), .default_ism = try reader.key(), .processed_count = try reader.uint(u64) };
    }
    pub fn verify(self: Inbox, program: Key, key: Key, owner: Key) !void {
        const expected = try solana.createProgramAddress(&.{ "hyperlane", "-", "inbox", &.{self.bump} }, program);
        try verifyKey(program, key, owner, expected);
    }
};

pub const Outbox = struct {
    local_domain: u32,
    bump: u8,
    owner: ?Key,
    tree: protocol.IncrementalMerkle,
    max_protocol_fee: u64,
    protocol_fee: u64,
    beneficiary: Key,
    pub fn decode(data: []const u8) !Outbox {
        var reader: borsh.Reader = .{ .bytes = data };
        try reader.initialized();
        const domain = try reader.uint(u32);
        const bump = try reader.uint(u8);
        const owner = if (try reader.boolean()) try reader.key() else null;
        var tree = protocol.IncrementalMerkle.init();
        for (&tree.branch) |*hash| hash.* = try reader.key();
        const count = try reader.uint(u64);
        if (count > std.math.maxInt(u32)) return error.InvalidMerkleCount;
        tree.count = @intCast(count);
        return .{ .local_domain = domain, .bump = bump, .owner = owner, .tree = tree, .max_protocol_fee = try reader.uint(u64), .protocol_fee = try reader.uint(u64), .beneficiary = try reader.key() };
    }
    pub fn verify(self: *const Outbox, program: Key, key: Key, account_owner: Key) !void {
        const expected = try solana.createProgramAddress(&.{ "hyperlane", "-", "outbox", &.{self.bump} }, program);
        try verifyKey(program, key, account_owner, expected);
    }
};

pub const DispatchedMessage = struct {
    nonce: u32,
    slot: u64,
    unique: Key,
    message: protocol.Message,
    pub fn decode(data: []const u8) !DispatchedMessage {
        var reader: borsh.Reader = .{ .bytes = data };
        try reader.initialized();
        try reader.discriminator("DISPATCH");
        const nonce = try reader.uint(u32);
        const slot = try reader.uint(u64);
        const unique = try reader.key();
        const message = try protocol.Message.decode(data[reader.pos..]);
        if (message.nonce != nonce) return error.MessageNonceMismatch;
        if (message.version != 3) return error.UnsupportedMessageVersion;
        return .{ .nonce = nonce, .slot = slot, .unique = unique, .message = message };
    }
    pub fn verify(self: DispatchedMessage, program: Key, key: Key, owner: Key, origin: u32) !void {
        if (self.message.origin != origin) return error.WrongMessageOrigin;
        try verifyKey(program, key, owner, (try dispatchedPda(program, self.unique)).key);
    }
};

pub const ProcessedMessage = struct {
    sequence: u64,
    message_id: Key,
    slot: u64,
    pub fn decode(data: []const u8) !ProcessedMessage {
        var reader: borsh.Reader = .{ .bytes = data };
        try reader.initialized();
        try reader.discriminator("PROCESSD");
        return .{ .sequence = try reader.uint(u64), .message_id = try reader.key(), .slot = try reader.uint(u64) };
    }
    pub fn verify(self: ProcessedMessage, program: Key, key: Key, owner: Key) !void {
        try verifyKey(program, key, owner, (try processedPda(program, self.message_id)).key);
    }
};

pub const GasPayment = struct {
    sequence: u64,
    igp: Key,
    destination: u32,
    message_id: Key,
    gas_amount: u64,
    payment: u64,
    unique: Key,
    slot: u64,
    pub fn decode(data: []const u8) !GasPayment {
        var reader: borsh.Reader = .{ .bytes = data };
        try reader.initialized();
        try reader.discriminator("GASPAYMT");
        return .{ .sequence = try reader.uint(u64), .igp = try reader.key(), .destination = try reader.uint(u32), .message_id = try reader.key(), .gas_amount = try reader.uint(u64), .payment = try reader.uint(u64), .unique = try reader.key(), .slot = try reader.uint(u64) };
    }
    pub fn verify(self: GasPayment, program: Key, key: Key, owner: Key) !void {
        try verifyKey(program, key, owner, (try gasPaymentPda(program, self.unique)).key);
    }
};

pub const lookup_table_program: Key = blk: {
    var key: Key = undefined;
    _ = std.fmt.hexToBytes(&key, "0277a6af97339b7ac88d1892c90446f5" ++ "0002309266f62e53c118244982000000") catch unreachable;
    break :blk key;
};

/// Solana ALT accounts use bincode ProgramState rather than AccountData/Borsh.
pub const AddressLookupTable = struct {
    key: Key,
    deactivation_slot: u64,
    last_extended_slot: u64,
    last_extended_start_index: u8,
    authority: ?Key,
    addresses: [256]Key,
    len: usize,

    pub fn decode(key: Key, owner: Key, data: []const u8) !AddressLookupTable {
        if (!std.mem.eql(u8, &owner, &lookup_table_program)) return error.WrongLookupTableOwner;
        if (data.len < 56 or (data.len - 56) % 32 != 0) return error.InvalidLookupTableLength;
        const count = (data.len - 56) / 32;
        if (count > 256) return error.LookupTableTooLarge;
        var reader: borsh.Reader = .{ .bytes = data };
        if (try reader.uint(u32) != 1) return error.UninitializedLookupTable;
        var table: AddressLookupTable = .{ .key = key, .deactivation_slot = try reader.uint(u64), .last_extended_slot = try reader.uint(u64), .last_extended_start_index = try reader.uint(u8), .authority = if (try reader.boolean()) try reader.key() else null, .addresses = undefined, .len = count };
        _ = try reader.uint(u16); // alignment padding, not a discriminator
        if (table.last_extended_start_index > count) return error.InvalidLookupTableExtension;
        for (0..count) |i| table.addresses[i] = data[56 + i * 32 ..][0..32].*;
        return table;
    }

    /// Deactivating tables remain usable while their deactivation slot is in
    /// SlotHashes. Same-slot extensions are hidden until the following bank.
    pub fn active(self: *const AddressLookupTable, current_slot: u64, recent_slots: []const u64) !solana.LookupTable {
        if (current_slot < self.last_extended_slot) return error.FutureLookupTable;
        if (self.deactivation_slot != std.math.maxInt(u64) and self.deactivation_slot != current_slot and std.mem.indexOfScalar(u64, recent_slots, self.deactivation_slot) == null)
            return error.DeactivatedLookupTable;
        const count = if (current_slot == self.last_extended_slot) self.last_extended_start_index else self.len;
        return .{ .key = self.key, .addresses = self.addresses[0..count] };
    }
};

test "mailbox account decoders reject every truncated prefix and wrong discriminator" {
    const message: protocol.Message = .{ .origin = 1000, .nonce = 4, .body = "body" };
    var encoded: [81]u8 = undefined;
    _ = try message.encode(&encoded);
    var data: [134]u8 = undefined;
    var writer: borsh.Writer = .{ .out = &data };
    try writer.uint(u8, 1);
    try writer.raw("DISPATCH");
    try writer.uint(u32, 4);
    try writer.uint(u64, 20);
    try writer.raw(&(.{2} ** 32));
    try writer.raw(&encoded);
    const dispatched = try DispatchedMessage.decode(&data);
    try std.testing.expectEqual(@as(u32, 4), dispatched.nonce);
    for (0..130) |len| try std.testing.expectError(if (len < 53) error.TruncatedAccount else error.TruncatedMessage, DispatchedMessage.decode(data[0..len]));
    data[1] ^= 1;
    try std.testing.expectError(error.InvalidDiscriminator, DispatchedMessage.decode(&data));
    data[1] ^= 1;
    data[9] = 5;
    try std.testing.expectError(error.MessageNonceMismatch, DispatchedMessage.decode(&data));
    data[0] = 0;
    try std.testing.expectError(error.UninitializedAccount, DispatchedMessage.decode(&data));
}

test "inbox verifies canonical PDA and account owner" {
    const program = [_]u8{0x11} ** 32;
    const pda = try inboxPda(program);
    const inbox: Inbox = .{ .local_domain = 1000, .bump = pda.bump, .default_ism = .{2} ** 32, .processed_count = 8 };
    try inbox.verify(program, pda.key, program);
    try std.testing.expectError(error.WrongAccountOwner, inbox.verify(program, pda.key, .{0} ** 32));
    try std.testing.expectError(error.WrongAccountAddress, inbox.verify(program, .{0} ** 32, program));
}
