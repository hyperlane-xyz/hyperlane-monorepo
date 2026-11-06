//! Source universal_router_reveal.rs wire/PDA/instruction boundary. HTTP, chain
//! reads and durable scheduling are explicit; helpers never sign or broadcast.
const std = @import("std");
const sol = @import("../../altvm/solana.zig");
const b58 = @import("../../altvm/base58.zig");
const abi = @import("../../evm/codecs.zig");
const rpc = @import("../../net/json_rpc.zig");
const http = @import("../../cloud/http.zig");
const protocol = @import("../../protocol/root.zig");
const ccip = @import("../../relayer/ccip.zig");
const A = std.mem.Allocator;
pub const Key = [32]u8;
pub const reveal_units = 600000;
pub const close_units = 200000;
pub const close_expiry_seconds = 60;
pub const raydium = fixed("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
pub const ata_program = fixed("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const wsol = fixed("So11111111111111111111111111111111111111112");
pub const token_program = fixed("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const token_2022 = fixed("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
fn fixed(comptime text: []const u8) Key {
    @setEvalBranchQuota(100000);
    var value: u256 = 0;
    for (text) |char| {
        const index = std.mem.indexOfScalar(u8, "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz", char) orelse @compileError("invalid reveal fixed program");
        value = value * 58 + index;
    }
    var key: Key = undefined;
    std.mem.writeInt(u256, &key, value, .big);
    return key;
}
pub const Commit = struct {
    id: Key,
    program: Key,
    origin: u32,
    sender: Key,
    commitment: Key,
    user_salt: Key,
    recipient: Key,
    pub fn message(program: Key, value: protocol.Message) ?Commit {
        if (value.body.len != 96 or !std.mem.eql(u8, &program, &value.recipient)) return null;
        return .{ .id = value.id(), .program = program, .origin = value.origin, .sender = value.sender, .commitment = value.body[0..32].*, .user_salt = value.body[32..64].*, .recipient = value.body[64..96].* };
    }
    pub fn pending(self: Commit) !sol.ProgramAddress {
        var origin: [4]u8 = undefined;
        std.mem.writeInt(u32, &origin, self.origin, .little);
        return sol.findProgramAddress(&.{ "pending_swap", &origin, &self.sender, &self.user_salt, &self.commitment }, self.program);
    }
};
pub fn feePayer(program: Key) !sol.ProgramAddress {
    return sol.findProgramAddress(&.{"hyperlane_fee_payer"}, program);
}
pub fn associated(owner: Key, mint: Key, token: Key) !Key {
    return (try sol.findProgramAddress(&.{ &owner, &token, &mint }, ata_program)).key;
}
pub fn tickStart(current: i32, spacing: i16) !i32 {
    if (spacing <= 0) return error.InvalidRevealTickSpacing;
    const width = @as(i32, spacing) *| 60;
    var start = @divTrunc(current, width) *| width;
    if (current < 0 and @rem(current, width) != 0) start -|= width;
    return start;
}
pub fn tickArray(pool: Key, start: i32) !Key {
    var bytes: [4]u8 = undefined;
    std.mem.writeInt(i32, &bytes, start, .big);
    return (try sol.findProgramAddress(&.{ "tick_array", &pool, &bytes }, raydium)).key;
}
pub const Pool = struct {
    key: Key,
    amm_config: Key,
    mint0: Key,
    mint1: Key,
    vault0: Key,
    vault1: Key,
    observation: Key,
    tick_spacing: i16,
    tick_current: i32,
    pub fn decode(key: Key, owner: Key, data: []const u8) !Pool {
        if (!std.mem.eql(u8, &owner, &raydium)) return error.WrongRevealPoolOwner;
        if (data.len < 273) return error.TruncatedRevealPool;
        const spacing = std.mem.readInt(i16, data[235..237], .little);
        if (spacing <= 0) return error.InvalidRevealTickSpacing;
        return .{ .key = key, .amm_config = data[9..41].*, .mint0 = data[73..105].*, .mint1 = data[105..137].*, .vault0 = data[137..169].*, .vault1 = data[169..201].*, .observation = data[201..233].*, .tick_spacing = spacing, .tick_current = std.mem.readInt(i32, data[269..273], .little) };
    }
};
pub fn pendingCommitTime(commit: Commit, owner: Key, data: []const u8) !i64 {
    if (!std.mem.eql(u8, &owner, &commit.program)) return error.WrongPendingSwapOwner;
    if (data.len < 45) return error.TruncatedPendingSwap;
    if (!std.mem.eql(u8, data[0..32], &commit.recipient) or std.mem.readInt(u32, data[32..36], .little) != commit.origin or data[36] != (try commit.pending()).bump) return error.WrongPendingSwapContext;
    const time = std.mem.readInt(i64, data[37..45], .little);
    if (time < 0) return error.InvalidPendingSwapTime;
    return time;
}
pub fn tokenBalance(owner_program: Key, expected_program: Key, mint: Key, owner: Key, data: []const u8) !u64 {
    if (!validToken(expected_program) or !std.mem.eql(u8, &owner_program, &expected_program)) return error.WrongRevealTokenProgram;
    if (data.len < 165 or !std.mem.eql(u8, data[0..32], &mint) or !std.mem.eql(u8, data[32..64], &owner) or (data[108] != 1 and data[108] != 2)) return error.InvalidRevealTokenAccount;
    return std.mem.readInt(u64, data[64..72], .little);
}
fn validToken(key: Key) bool {
    return std.mem.eql(u8, &key, &token_program) or std.mem.eql(u8, &key, &token_2022);
}
pub const Ccs = struct {
    arena: std.heap.ArenaAllocator,
    data: []const u8,
    salt: Key,
    accounts: []sol.AccountMeta,
    pub const max_bytes = 1024 * 1024;
    pub fn parse(a: A, commit: Commit, input: []const u8) !Ccs {
        if (input.len == 0 or input.len > max_bytes) return error.InvalidCcsSize;
        var arena = std.heap.ArenaAllocator.init(a);
        errdefer arena.deinit();
        const owned = arena.allocator();
        const value = try std.json.parseFromSliceLeaky(std.json.Value, owned, input, .{ .duplicate_field_behavior = .@"error" });
        const data = try decodeHex(owned, try rpc.string(try rpc.field(value, "data")), 16384);
        const salt_bytes = try decodeHex(owned, try rpc.string(try rpc.field(value, "salt")), 32);
        if (salt_bytes.len != 32) return error.InvalidCcsSalt;
        var hash = std.crypto.hash.sha3.Keccak256.init(.{});
        hash.update(salt_bytes);
        hash.update(data);
        var commitment: Key = undefined;
        hash.final(&commitment);
        if (!std.mem.eql(u8, &commitment, &commit.commitment)) return error.CcsCommitmentMismatch;
        const list = try rpc.field(value, "revealAccounts");
        if (list != .array or list.array.items.len < 3 or list.array.items.len > 256) return error.InvalidCcsAccounts;
        const accounts = try owned.alloc(sol.AccountMeta, list.array.items.len);
        for (list.array.items, accounts) |item, *out| {
            const writable = try rpc.field(item, "isWritable");
            const signer = try rpc.field(item, "isSigner");
            if (writable != .bool or signer != .bool) return error.InvalidCcsAccounts;
            const key = try b58.decode(owned, try rpc.string(try rpc.field(item, "pubkey")));
            if (key.len != 32) return error.InvalidCcsPublicKey;
            out.* = .{ .key = key[0..32].*, .is_signer = signer.bool, .is_writable = writable.bool };
        }
        return .{ .arena = arena, .data = data, .salt = salt_bytes[0..32].*, .accounts = accounts };
    }
    pub fn deinit(self: *Ccs) void {
        self.arena.deinit();
    }
};
fn decodeHex(a: A, text: []const u8, maximum: usize) ![]u8 {
    const raw = if (std.mem.startsWith(u8, text, "0x")) text[2..] else text;
    if (raw.len % 2 != 0 or raw.len / 2 > maximum) return error.InvalidCcsHex;
    const result = try a.alloc(u8, raw.len / 2);
    errdefer a.free(result);
    _ = try std.fmt.hexToBytes(result, raw);
    return result;
}
pub fn validateUrl(url: []const u8, allow_loopback_fixture: bool) !void {
    const uri = try std.Uri.parse(url);
    if (uri.host == null or uri.user != null or uri.password != null or uri.query != null or uri.fragment != null) return error.InvalidCcsUrl;
    if (!std.mem.eql(u8, uri.scheme, "https")) {
        const host = switch (uri.host.?) {
            .raw => |v| v,
            .percent_encoded => |v| v,
        };
        if (!allow_loopback_fixture or !std.mem.eql(u8, uri.scheme, "http") or !(std.mem.eql(u8, host, "127.0.0.1") or std.mem.eql(u8, host, "::1"))) return error.InsecureCcsUrl;
    }
}
pub fn authenticationHash(a: A, base_url: []const u8, commit: Commit, signer: [20]u8, allow_loopback_fixture: bool) !Key {
    try validateUrl(base_url, allow_loopback_fixture);
    const template = try std.fmt.allocPrint(a, "{s}/calldata", .{std.mem.trimEnd(u8, base_url, "/")});
    defer a.free(template);
    return protocol.ethSignedMessageHash(ccip.requestHash(signer, &commit.commitment, template));
}
pub const Read = struct {
    arena: std.heap.ArenaAllocator,
    request: http.Request,
    pub fn deinit(self: *Read) void {
        self.arena.deinit();
    }
};
pub fn prepareRead(a: A, base_url: []const u8, commit: Commit, signer: [20]u8, signature: [65]u8, allow_loopback_fixture: bool) !Read {
    try validateUrl(base_url, allow_loopback_fixture);
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const owned = arena.allocator();
    const url = try std.fmt.allocPrint(owned, "{s}/calldata/{s}", .{ std.mem.trimEnd(u8, base_url, "/"), try abi.hexAlloc(owned, &commit.commitment) });
    const headers = try owned.alloc(http.Header, 2);
    headers[0] = .{ .name = "Authorization", .value = try std.fmt.allocPrint(owned, "Hyperlane-Signature {s}", .{try abi.hexAlloc(owned, &signature)}) };
    headers[1] = .{ .name = "X-Hyperlane-Sender", .value = try abi.hexAlloc(owned, &signer) };
    return .{ .arena = arena, .request = .{ .url = url, .method = .GET, .headers = headers, .max_response_bytes = Ccs.max_bytes + 1 } };
}
pub const CloseAccounts = struct { mint: Key, token: Key };
pub const Instructions = struct {
    arena: std.heap.ArenaAllocator,
    values: []const sol.Instruction,
    close: ?CloseAccounts = null,
    pub fn deinit(self: *Instructions) void {
        self.arena.deinit();
    }
};
fn ata(a: A, payer: Key, owner: Key, mint: Key, token: Key) !sol.Instruction {
    if (!validToken(token)) return error.WrongRevealTokenProgram;
    const accounts = try a.dupe(sol.AccountMeta, &.{ .{ .key = payer, .is_signer = true, .is_writable = true }, .{ .key = try associated(owner, mint, token), .is_writable = true }, .{ .key = owner }, .{ .key = mint }, .{ .key = .{0} ** 32 }, .{ .key = token } });
    return .{ .program = ata_program, .accounts = accounts, .data = &.{1} };
}
pub fn closeInstructions(a: A, commit: Commit, payer: Key, input: CloseAccounts) !Instructions {
    if (!validToken(input.token)) return error.WrongRevealTokenProgram;
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const owned = arena.allocator();
    const pending = (try commit.pending()).key;
    const fee = (try feePayer(commit.program)).key;
    const pending_ata = try associated(pending, input.mint, input.token);
    const recipient_ata = try associated(commit.recipient, input.mint, input.token);
    const data = try owned.alloc(u8, 101);
    data[0] = 3;
    std.mem.writeInt(u32, data[1..5], commit.origin, .little);
    data[5..37].* = commit.sender;
    data[37..69].* = commit.user_salt;
    data[69..101].* = commit.commitment;
    const metas = try owned.dupe(sol.AccountMeta, &.{ .{ .key = pending, .is_writable = true }, .{ .key = payer, .is_signer = true, .is_writable = true }, .{ .key = pending_ata, .is_writable = true }, .{ .key = recipient_ata, .is_writable = true }, .{ .key = input.token }, .{ .key = input.mint }, .{ .key = commit.recipient, .is_writable = true }, .{ .key = fee, .is_writable = true } });
    const values = try owned.alloc(sol.Instruction, 3);
    values[0] = try ata(owned, payer, pending, input.mint, input.token);
    values[1] = try ata(owned, payer, commit.recipient, input.mint, input.token);
    values[2] = .{ .program = commit.program, .accounts = metas, .data = data };
    return .{ .arena = arena, .values = values };
}
pub fn build(a: A, commit: Commit, ccs: Ccs, payer: Key, pool: ?Pool) !Instructions {
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const owned = arena.allocator();
    const pending = (try commit.pending()).key;
    const fee = (try feePayer(commit.program)).key;
    const metas = try owned.dupe(sol.AccountMeta, ccs.accounts);
    if (metas.len < 3) return error.InvalidCcsAccounts;
    metas[0].key = pending;
    metas[2].key = fee;
    // Transaction payer privileges are global in Solana's compiled message.
    // Even isSigner=false cannot safely pass that key to an untrusted CPI tree.
    for (metas) |meta| {
        if (std.mem.eql(u8, &meta.key, &payer)) return error.DynamicAccountContainsPayer;
        if (meta.is_signer) return error.UnconfiguredRevealSigner;
    }
    const data = try owned.alloc(u8, 105 + ccs.data.len);
    data[0] = 2;
    std.mem.writeInt(u32, data[1..5], commit.origin, .little);
    data[5..37].* = commit.sender;
    data[37..69].* = commit.user_salt;
    std.mem.writeInt(u32, data[69..73], @intCast(ccs.data.len), .little);
    @memcpy(data[73..][0..ccs.data.len], ccs.data);
    data[73 + ccs.data.len ..][0..32].* = ccs.salt;
    var values: std.ArrayList(sol.Instruction) = .empty;
    if (metas.len > 23) {
        const live = pool orelse return error.RevealPoolRequired;
        if (!std.mem.eql(u8, &metas[5].key, &live.key)) return error.WrongRevealPool;
        const forward = if (std.mem.eql(u8, &metas[14].key, &live.mint0)) true else if (std.mem.eql(u8, &metas[14].key, &live.mint1)) false else return error.CcsInputMintMismatch;
        const input_mint = if (forward) live.mint0 else live.mint1;
        const output_mint = if (forward) live.mint1 else live.mint0;
        metas[4].key = live.amm_config;
        metas[8].key = if (forward) live.vault0 else live.vault1;
        metas[9].key = if (forward) live.vault1 else live.vault0;
        metas[10].key = live.observation;
        metas[14].key = input_mint;
        metas[15].key = output_mint;
        metas[22].key = output_mint;
        const width = @as(i32, live.tick_spacing) *| 60;
        const start = try tickStart(live.tick_current, live.tick_spacing);
        metas[16].key = try tickArray(live.key, start);
        metas[17].key = try tickArray(live.key, start +| width);
        metas[18].key = try tickArray(live.key, start +| (2 *| width));
        const input_token = metas[11].key;
        const output_token = metas[23].key;
        if (!validToken(input_token) or !validToken(output_token)) return error.WrongRevealTokenProgram;
        metas[1].key = try associated(pending, input_mint, input_token);
        metas[6].key = metas[1].key;
        metas[7].key = try associated(pending, output_mint, output_token);
        metas[20].key = metas[7].key;
        const native = std.mem.eql(u8, &output_mint, &wsol);
        metas[21].key = if (native) try associated(payer, wsol, token_program) else try associated(commit.recipient, output_mint, output_token);
        try values.append(owned, try ata(owned, payer, pending, output_mint, output_token));
        try values.append(owned, try ata(owned, payer, if (native) payer else commit.recipient, output_mint, if (native) token_program else output_token));
        try values.append(owned, .{ .program = commit.program, .accounts = metas, .data = data });
        if (native) {
            const close_metas = try owned.dupe(sol.AccountMeta, &.{ .{ .key = metas[21].key, .is_writable = true }, .{ .key = commit.recipient, .is_writable = true }, .{ .key = payer, .is_signer = true } });
            try values.append(owned, .{ .program = token_program, .accounts = close_metas, .data = &.{9} });
        }
    } else {
        try values.append(owned, .{ .program = commit.program, .accounts = metas, .data = data });
    }
    const close: ?CloseAccounts = if (metas.len > 14) .{ .mint = metas[14].key, .token = metas[11].key } else null;
    const output = try values.toOwnedSlice(owned);
    return .{ .arena = arena, .values = output, .close = close };
}

test "SVM reveal source tick arithmetic URLs and ownership reject malformed inputs" {
    const a = std.testing.allocator;
    try std.testing.expectEqual(@as(i32, -600), try tickStart(-1, 10));
    try std.testing.expectEqual(@as(i32, -600), try tickStart(-600, 10));
    try std.testing.expectEqual(@as(i32, 600), try tickStart(1199, 10));
    try std.testing.expectError(error.InvalidRevealTickSpacing, tickStart(0, 0));
    try std.testing.expectError(error.InsecureCcsUrl, validateUrl("http://example.invalid/ccs", false));
    try std.testing.expectError(error.InvalidCcsUrl, validateUrl("https://user:pass@example.invalid/ccs", false));
    try std.testing.expectError(error.InvalidCcsUrl, validateUrl("https://example.invalid/ccs?token=invalid", false));
    try validateUrl("https://example.invalid/ccs", false);
    var data: [273]u8 = .{0} ** 273;
    std.mem.writeInt(i16, data[235..237], 10, .little);
    const pool = try Pool.decode(.{3} ** 32, raydium, &data);
    try std.testing.expectEqual(@as(i16, 10), pool.tick_spacing);
    try std.testing.expectError(error.WrongRevealPoolOwner, Pool.decode(.{3} ** 32, .{4} ** 32, &data));
    const commit: Commit = .{ .id = .{1} ** 32, .program = .{2} ** 32, .origin = 5, .sender = .{3} ** 32, .commitment = .{4} ** 32, .user_salt = .{5} ** 32, .recipient = .{6} ** 32 };
    var pending_data: [45]u8 = .{0} ** 45;
    pending_data[0..32].* = commit.recipient;
    std.mem.writeInt(u32, pending_data[32..36], commit.origin, .little);
    pending_data[36] = (try commit.pending()).bump;
    std.mem.writeInt(i64, pending_data[37..45], 100, .little);
    try std.testing.expectEqual(@as(i64, 100), try pendingCommitTime(commit, commit.program, &pending_data));
    try std.testing.expectError(error.WrongPendingSwapOwner, pendingCommitTime(commit, .{9} ** 32, &pending_data));
    var instructions = try closeInstructions(a, commit, .{7} ** 32, .{ .mint = .{8} ** 32, .token = token_program });
    defer instructions.deinit();
    try std.testing.expectEqual(@as(usize, 3), instructions.values.len);
    try std.testing.expectEqual(@as(u8, 3), instructions.values[2].data[0]);
    try std.testing.expectEqual(@as(usize, 101), instructions.values[2].data.len);
    try std.testing.expect(instructions.values[2].accounts[1].is_signer);
}

test {
    std.testing.refAllDecls(@This());
}

fn fixtureBuild(a: A, negatives: bool) !void {
    const data = "fixture route";
    const salt: Key = .{3} ** 32;
    var hash = std.crypto.hash.sha3.Keccak256.init(.{});
    hash.update(&salt);
    hash.update(data);
    var commitment: Key = undefined;
    hash.final(&commitment);
    const commit: Commit = .{ .id = .{1} ** 32, .program = .{2} ** 32, .origin = 5, .sender = .{3} ** 32, .commitment = commitment, .user_salt = .{5} ** 32, .recipient = .{6} ** 32 };
    const Meta = struct { pubkey: []const u8, isWritable: bool, isSigner: bool };
    var accounts: [24]Meta = undefined;
    var used: usize = 0;
    defer for (accounts[0..used]) |meta| a.free(meta.pubkey);
    for (&accounts, 0..) |*meta, i| {
        const key: Key = switch (i) {
            11, 23 => token_program,
            14 => .{4} ** 32,
            else => .{@as(u8, @intCast(i + 1))} ** 32,
        };
        meta.* = .{ .pubkey = try b58.encode(a, &key), .isWritable = true, .isSigner = false };
        used += 1;
    }
    const data_hex = try abi.hexAlloc(a, data);
    defer a.free(data_hex);
    const salt_hex = try abi.hexAlloc(a, &salt);
    defer a.free(salt_hex);
    const json = try std.json.Stringify.valueAlloc(a, .{ .data = data_hex, .salt = salt_hex, .revealAccounts = accounts }, .{});
    defer a.free(json);
    var ccs = try Ccs.parse(a, commit, json);
    defer ccs.deinit();
    const pool: Pool = .{ .key = .{6} ** 32, .amm_config = .{7} ** 32, .mint0 = .{4} ** 32, .mint1 = wsol, .vault0 = .{8} ** 32, .vault1 = .{9} ** 32, .observation = .{10} ** 32, .tick_current = -1, .tick_spacing = 10 };
    const payer = (try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(.{7} ** 32)).public_key.toBytes();
    var built = try build(a, commit, ccs, payer, pool);
    defer built.deinit();
    try std.testing.expectEqual(@as(usize, 4), built.values.len);
    const instruction = built.values[2];
    try std.testing.expectEqual((try commit.pending()).key, instruction.accounts[0].key);
    try std.testing.expectEqual((try feePayer(commit.program)).key, instruction.accounts[2].key);
    try std.testing.expectEqual(pool.amm_config, instruction.accounts[4].key);
    try std.testing.expectEqual(try tickArray(pool.key, -600), instruction.accounts[16].key);
    try std.testing.expectEqual(try tickArray(pool.key, 0), instruction.accounts[17].key);
    try std.testing.expectEqual(try tickArray(pool.key, 600), instruction.accounts[18].key);
    try std.testing.expectEqual(@as(u8, 2), instruction.data[0]);
    try std.testing.expectEqual(@as(usize, 105 + data.len), instruction.data.len);
    try std.testing.expectEqual(@as(u8, 9), built.values[3].data[0]);
    if (negatives) {
        var wrong = commit;
        wrong.commitment[0] ^= 1;
        try std.testing.expectError(error.CcsCommitmentMismatch, Ccs.parse(a, wrong, json));
        const old = ccs.accounts[3];
        ccs.accounts[3].key = payer;
        ccs.accounts[3].is_signer = false;
        try std.testing.expectError(error.DynamicAccountContainsPayer, build(a, commit, ccs, payer, pool));
        ccs.accounts[3] = old;
        ccs.accounts[3].is_signer = true;
        try std.testing.expectError(error.UnconfiguredRevealSigner, build(a, commit, ccs, payer, pool));
        ccs.accounts[3] = old;
    }
    const signer = try protocol.signature.secretKeyAddress(.{0x11} ** 32);
    const digest = try authenticationHash(a, "https://ccs.fixture/base", commit, signer, false);
    const signature = try protocol.signature.signDigest(.{0x11} ** 32, digest, null);
    try std.testing.expectEqual(signer, try protocol.signature.recover(digest, signature));
    var request = try prepareRead(a, "https://ccs.fixture/base/", commit, signer, signature, false);
    defer request.deinit();
    try std.testing.expect(std.mem.startsWith(u8, request.request.url, "https://ccs.fixture/base/calldata/0x"));
    try std.testing.expectEqualStrings("Authorization", request.request.headers[0].name);
    try std.testing.expect(std.mem.startsWith(u8, request.request.headers[0].value, "Hyperlane-Signature 0x"));
}
test "SVM reveal commitment CLMM overrides ATAs wrapped SOL and CCS authentication survive allocation failures" {
    try fixtureBuild(std.testing.allocator, true);
    try std.testing.checkAllAllocationFailures(std.testing.allocator, fixtureBuild, .{false});
}

pub const SimulationFailure = struct { instruction: u32, code: u32 };
pub const SimulationWitness = struct {
    failure: ?SimulationFailure = null,
    pub fn observer(self: *SimulationWitness) @import("../../sealevel/transaction.zig").SimulationObserver {
        return .{ .context = self, .observe = observe };
    }
    fn observe(ctx: *anyopaque, value: std.json.Value) void {
        const self: *SimulationWitness = @ptrCast(@alignCast(ctx));
        self.failure = simulationFailure(value);
    }
};
pub fn simulationFailure(value: std.json.Value) ?SimulationFailure {
    const inner = rpc.field(value, "value") catch return null;
    const err = rpc.field(inner, "err") catch return null;
    if (err == .null or err != .object) return null;
    const instruction = err.object.get("InstructionError") orelse return null;
    if (instruction != .array or instruction.array.items.len != 2 or instruction.array.items[1] != .object) return null;
    const custom = instruction.array.items[1].object.get("Custom") orelse return null;
    return .{ .instruction = rpc.integer(u32, instruction.array.items[0]) catch return null, .code = rpc.integer(u32, custom) catch return null };
}
const SimulationFixture = struct {
    calls: usize = 0,
    fn exchange(ctx: *anyopaque, a: A, input: []const u8, _: @import("../../evm/provider.zig").Options) !@import("../../evm/provider.zig").WireResponse {
        const self: *SimulationFixture = @ptrCast(@alignCast(ctx));
        self.calls += 1;
        var document = try std.json.parseFromSlice(std.json.Value, a, input, .{});
        defer document.deinit();
        try std.testing.expectEqualStrings("simulateTransaction", try rpc.string(try rpc.field(document.value, "method")));
        const id = try rpc.integer(u64, try rpc.field(document.value, "id"));
        const body = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .context = .{ .slot = 1 }, .value = .{ .err = .{ .InstructionError = .{ @as(u32, 2), .{ .Custom = @as(u32, 10) } } }, .unitsConsumed = 1000, .logs = [_][]const u8{} } } }, .{});
        return .{ .bytes = body, .len = body.len };
    }
};
test "SVM reveal observes genuine process Custom10 before shared preparation returns simulation failure" {
    const a = std.testing.allocator;
    var fixture: SimulationFixture = .{};
    var client = try @import("../../sealevel/provider.zig").Client.init(a, "https://fixture/rpc", .{ .exchange = .{ .context = &fixture, .fetch_fn = SimulationFixture.exchange } });
    defer client.deinit();
    var witness: SimulationWitness = .{};
    const payer = (try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(.{7} ** 32)).public_key.toBytes();
    try std.testing.expectError(error.SvmSimulationFailed, @import("../../sealevel/transaction.zig").prepare(a, &client, .{ .payer = payer, .process = .{ .program = .{9} ** 32, .accounts = &.{}, .data = "fixture" }, .simulation_observer = witness.observer() }));
    try std.testing.expectEqual(SimulationFailure{ .instruction = 2, .code = 10 }, witness.failure.?);
    try std.testing.expectEqual(@as(usize, 1), fixture.calls);
}

test {
    _ = @import("reveal_oracle_test.zig");
}
