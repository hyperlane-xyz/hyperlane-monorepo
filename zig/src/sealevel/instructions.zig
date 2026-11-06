const std = @import("std");
const solana = @import("../altvm/solana.zig");
const Message = @import("../protocol/root.zig").Message;
const borsh = @import("borsh.zig");
const accounts = @import("accounts.zig");
pub const Key = [32]u8;
pub const type_discriminator = [_]u8{ 105, 97, 97, 88, 63, 124, 106, 18 };
pub const verify_discriminator = [_]u8{ 243, 53, 214, 0, 208, 18, 231, 67 };
pub const verify_accounts_discriminator = [_]u8{ 200, 65, 157, 12, 89, 255, 131, 216 };
pub const verify_spec_discriminator = [_]u8{ 49, 24, 22, 218, 134, 132, 63, 155 };
pub const recipient_ism_discriminator = [_]u8{ 45, 18, 245, 87, 234, 46, 246, 15 };
pub const recipient_ism_accounts_discriminator = [_]u8{ 190, 214, 218, 129, 67, 97, 4, 76 };
pub const handle_discriminator = [_]u8{ 33, 210, 5, 66, 196, 212, 239, 142 };
pub const handle_accounts_discriminator = [_]u8{ 194, 141, 30, 82, 241, 41, 169, 52 };

pub fn verifyAccountsPda(program: Key) !solana.ProgramAddress {
    return solana.findProgramAddress(&.{ "hyperlane_ism", "-", "verify", "-", "account_metas" }, program);
}
pub fn recipientIsmAccountsPda(program: Key) !solana.ProgramAddress {
    return solana.findProgramAddress(&.{ "hyperlane_message_recipient", "-", "interchain_security_module", "-", "account_metas" }, program);
}
pub fn handleAccountsPda(program: Key) !solana.ProgramAddress {
    return solana.findProgramAddress(&.{ "hyperlane_message_recipient", "-", "handle", "-", "account_metas" }, program);
}

pub fn processData(metadata: []const u8, message: []const u8, out: []u8) ![]u8 {
    var writer: borsh.Writer = .{ .out = out };
    try writer.uint(u8, 1); // MailboxIxn::InboxProcess
    try writer.vec(metadata);
    try writer.vec(message);
    return out[0..writer.pos];
}
pub fn verifyData(discriminator: [8]u8, metadata: []const u8, message: []const u8, out: []u8) ![]u8 {
    var writer: borsh.Writer = .{ .out = out };
    try writer.raw(&discriminator);
    try writer.vec(metadata);
    try writer.vec(message);
    return out[0..writer.pos];
}
pub fn metadataSpecData(message: []const u8, out: []u8) ![]u8 {
    var writer: borsh.Writer = .{ .out = out };
    try writer.raw(&verify_spec_discriminator);
    try writer.vec(message);
    return out[0..writer.pos];
}
pub fn handleData(message: Message, query_accounts: bool, out: []u8) ![]u8 {
    var writer: borsh.Writer = .{ .out = out };
    try writer.raw(if (query_accounts) &handle_accounts_discriminator else &handle_discriminator);
    try writer.uint(u32, message.origin);
    try writer.raw(&message.sender);
    try writer.vec(message.body);
    return out[0..writer.pos];
}

/// Dynamic recipient/ISM accounts may never contain the payer: CPI would
/// inherit transaction signer privilege even if the requested flag is false.
/// Only a separately configured identity-only key can retain signer authority.
pub fn sanitizeDynamic(metas: []solana.AccountMeta, payer: Key, identity: ?Key, force_readonly: ?Key) !void {
    if (identity) |key| if (std.mem.eql(u8, &payer, &key)) return error.IdentityIsPayer;
    for (metas) |*meta| {
        if (std.mem.eql(u8, &meta.key, &payer)) return error.DynamicAccountContainsPayer;
        meta.is_signer = meta.is_signer and if (identity) |key| std.mem.eql(u8, &meta.key, &key) else false;
        if (force_readonly) |key| if (std.mem.eql(u8, &meta.key, &key)) {
            meta.is_writable = false;
        };
    }
}

pub const ProcessArgs = struct {
    mailbox: Key,
    payer: Key,
    noop: Key,
    ism: Key,
    identity: ?Key = null,
    destination_domain: u32,
    message: Message,
    metadata: []const u8,
    ism_getter: []const solana.AccountMeta,
    ism_verify: []const solana.AccountMeta,
    handle: []const solana.AccountMeta,
    handle_force_readonly: ?Key = null,
};
pub const ProcessInstruction = struct {
    allocator: std.mem.Allocator,
    program: Key,
    data: []u8,
    metas: []solana.AccountMeta,
    pub fn instruction(self: ProcessInstruction) solana.Instruction {
        return .{ .program = self.program, .accounts = self.metas, .data = self.data };
    }
    pub fn deinit(self: *ProcessInstruction) void {
        self.allocator.free(self.data);
        self.allocator.free(self.metas);
        self.* = undefined;
    }
};

pub fn buildProcess(allocator: std.mem.Allocator, args: ProcessArgs) !ProcessInstruction {
    if (args.message.destination != args.destination_domain) return error.WrongMessageDestination;
    if (args.message.version != 3) return error.UnsupportedMessageVersion;
    const message = try args.message.encodeAlloc(allocator);
    defer allocator.free(message);
    const data_len = try std.math.add(usize, try std.math.add(usize, message.len, args.metadata.len), 9);
    const data = try allocator.alloc(u8, data_len);
    errdefer allocator.free(data);
    _ = try processData(args.metadata, message, data);
    var meta_count = try std.math.add(usize, args.ism_getter.len, args.ism_verify.len);
    meta_count = try std.math.add(usize, try std.math.add(usize, meta_count, args.handle.len), 8);
    const metas = try allocator.alloc(solana.AccountMeta, meta_count);
    errdefer allocator.free(metas);
    const process = try accounts.processAuthorityPda(args.mailbox, args.message.recipient);
    const processed = try accounts.processedPda(args.mailbox, args.message.id());
    metas[0] = .{ .key = args.payer, .is_signer = true };
    metas[1] = .{ .key = .{0} ** 32 }; // system program
    metas[2] = .{ .key = (try accounts.inboxPda(args.mailbox)).key, .is_writable = true };
    metas[3] = .{ .key = process.key };
    metas[4] = .{ .key = processed.key, .is_writable = true };
    var pos: usize = 5;
    @memcpy(metas[pos..][0..args.ism_getter.len], args.ism_getter);
    try sanitizeDynamic(metas[pos..][0..args.ism_getter.len], args.payer, null, null);
    pos += args.ism_getter.len;
    metas[pos] = .{ .key = args.noop };
    metas[pos + 1] = .{ .key = args.ism };
    pos += 2;
    @memcpy(metas[pos..][0..args.ism_verify.len], args.ism_verify);
    try sanitizeDynamic(metas[pos..][0..args.ism_verify.len], args.payer, args.identity, null);
    pos += args.ism_verify.len;
    metas[pos] = .{ .key = args.message.recipient };
    pos += 1;
    @memcpy(metas[pos..][0..args.handle.len], args.handle);
    try sanitizeDynamic(metas[pos..][0..args.handle.len], args.payer, null, args.handle_force_readonly);
    return .{ .allocator = allocator, .program = args.mailbox, .data = data, .metas = metas };
}

/// Decode Borsh SimulationReturnData<Vec<SerializableAccountMeta>>. The trailing
/// byte is consumed exactly as Rust does; it is a transport truncation sentinel,
/// not a discriminator or signature. Authenticate the returning program in RPC.
pub fn decodeAccountMetas(allocator: std.mem.Allocator, data: []const u8) ![]solana.AccountMeta {
    var reader: borsh.Reader = .{ .bytes = data };
    const count = try reader.uint(u32);
    if (count > (data.len - reader.pos) / 34) return error.TruncatedAccount;
    const metas = try allocator.alloc(solana.AccountMeta, count);
    errdefer allocator.free(metas);
    for (metas) |*meta| meta.* = .{ .key = try reader.key(), .is_signer = try reader.boolean(), .is_writable = try reader.boolean() };
    try reader.simulationEnd();
    return metas;
}

pub fn decodeRecipientIsm(data: []const u8) !?Key {
    var reader: borsh.Reader = .{ .bytes = data };
    const key = if (try reader.boolean()) try reader.key() else null;
    try reader.simulationEnd();
    return key;
}

pub fn decodeModuleType(data: []const u8) !u32 {
    var reader: borsh.Reader = .{ .bytes = data };
    const module = try reader.uint(u32);
    try reader.simulationEnd();
    return module;
}

pub fn decodeKeyReturn(data: []const u8) !Key {
    var reader: borsh.Reader = .{ .bytes = data };
    const key = try reader.key();
    try reader.simulationEnd();
    return key;
}

pub const MetadataSpec = union(enum) {
    null_metadata,
    multisig_message_id: struct { validators: []const [20]u8, threshold: u8 },
    aggregation: struct { threshold: u8, children: []const MetadataSpec },
    trusted_relayer: Key,
    cannot_verify,
};
pub const SpecResult = struct {
    arena: std.heap.ArenaAllocator,
    spec: ?MetadataSpec,
    accounts: []const Key,
    pub fn deinit(self: *SpecResult) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub const SpecLimits = struct { max_depth: usize = 16, max_nodes: usize = 256 };

fn readSpec(reader: *borsh.Reader, allocator: std.mem.Allocator, limits: SpecLimits, remaining: *usize, depth: usize) anyerror!MetadataSpec {
    if (depth > limits.max_depth or remaining.* == 0) return error.MetadataSpecLimit;
    remaining.* -= 1;
    return switch (try reader.uint(u8)) {
        0 => .null_metadata,
        1 => blk: {
            const count = try reader.uint(u32);
            if (count > limits.max_nodes or count > (reader.bytes.len - reader.pos) / 20) return error.MetadataSpecLimit;
            const validators = try allocator.alloc([20]u8, count);
            for (validators) |*validator| validator.* = (try reader.take(20))[0..20].*;
            const threshold = try reader.uint(u8);
            if (threshold == 0 or threshold > validators.len) return error.InvalidThreshold;
            break :blk .{ .multisig_message_id = .{ .validators = validators, .threshold = threshold } };
        },
        2 => blk: {
            const threshold = try reader.uint(u8);
            const count = try reader.uint(u32);
            if (count > remaining.* or threshold == 0 or threshold > count) return error.MetadataSpecLimit;
            const children = try allocator.alloc(MetadataSpec, count);
            for (children) |*child| child.* = try readSpec(reader, allocator, limits, remaining, depth + 1);
            break :blk .{ .aggregation = .{ .threshold = threshold, .children = children } };
        },
        3 => .{ .trusted_relayer = try reader.key() },
        4 => .cannot_verify,
        else => error.UnknownMetadataSpec,
    };
}

pub fn decodeMetadataSpec(allocator: std.mem.Allocator, data: []const u8, limits: SpecLimits) !SpecResult {
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    var reader: borsh.Reader = .{ .bytes = data };
    var remaining = limits.max_nodes;
    const spec = if (try reader.boolean()) try readSpec(&reader, arena.allocator(), limits, &remaining, 0) else null;
    const count = try reader.uint(u32);
    if (count > limits.max_nodes or count > (data.len - reader.pos) / 32) return error.MetadataSpecLimit;
    if (spec != null and count != 0) return error.MetadataSpecNotConverged;
    const extra = try arena.allocator().alloc(Key, count);
    for (extra) |*key| key.* = try reader.key();
    try reader.simulationEnd();
    return .{ .arena = arena, .spec = spec, .accounts = extra };
}

test "instruction discriminators match production SHA256 domain strings" {
    const cases = .{
        .{ type_discriminator, "hyperlane-interchain-security-module:type" },
        .{ verify_discriminator, "hyperlane-interchain-security-module:verify" },
        .{ verify_accounts_discriminator, "hyperlane-interchain-security-module:verify-account-metas" },
        .{ verify_spec_discriminator, "hyperlane-interchain-security-module:verify-metadata-spec" },
        .{ handle_discriminator, "hyperlane-message-recipient:handle" },
        .{ handle_accounts_discriminator, "hyperlane-message-recipient:handle-account-metas" },
    };
    inline for (cases) |case| {
        var hash: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(case[1], &hash, .{});
        const expected: [8]u8 = case[0];
        try std.testing.expectEqualSlices(u8, &expected, hash[0..8]);
    }
}

test "dynamic account sanitizer preserves only explicitly separate identity" {
    const payer = [_]u8{1} ** 32;
    const identity = [_]u8{2} ** 32;
    var metas = [_]solana.AccountMeta{ .{ .key = identity, .is_signer = true }, .{ .key = .{3} ** 32, .is_signer = true, .is_writable = true } };
    try sanitizeDynamic(&metas, payer, identity, null);
    try std.testing.expect(metas[0].is_signer);
    try std.testing.expect(!metas[1].is_signer);
    try std.testing.expect(metas[1].is_writable);
    metas[1].key = payer;
    try std.testing.expectError(error.DynamicAccountContainsPayer, sanitizeDynamic(&metas, payer, null, null));
    try std.testing.expectError(error.IdentityIsPayer, sanitizeDynamic(&metas, payer, payer, null));
}

test "metadata spec recursion cannot bypass node depth or threshold limits" {
    // Some(Aggregation {threshold:1, [Null, CannotVerify]}), accounts=[], sentinel.
    const data = [_]u8{ 1, 2, 1, 2, 0, 0, 0, 0, 4, 0, 0, 0, 0, 255 };
    var result = try decodeMetadataSpec(std.testing.allocator, &data, .{});
    defer result.deinit();
    try std.testing.expectEqual(@as(usize, 2), result.spec.?.aggregation.children.len);
    try std.testing.expectEqual(MetadataSpec.cannot_verify, result.spec.?.aggregation.children[1]);
    try std.testing.expectError(error.MetadataSpecLimit, decodeMetadataSpec(std.testing.allocator, &data, .{ .max_depth = 0 }));
    try std.testing.expectError(error.MetadataSpecLimit, decodeMetadataSpec(std.testing.allocator, &data, .{ .max_nodes = 2 }));
}
