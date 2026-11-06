//! Source-backed simulated SVM ISM interfaces. Return data is authenticated by
//! returning program; simulations never request private keys or broadcast.
const std = @import("std");
const Mailbox = @import("mailbox.zig").Mailbox;
const svm = @import("provider.zig");
const sol = @import("../altvm/solana.zig");
const ix = @import("instructions.zig");
const borsh = @import("borsh.zig");
const Message = @import("../protocol/root.zig").Message;
const A = std.mem.Allocator;
const Key = sol.Key;
pub const validators_discriminator = [_]u8{ 82, 96, 5, 220, 241, 173, 13, 50 };
pub const validators_accounts_discriminator = [_]u8{ 113, 7, 132, 85, 239, 247, 157, 204 };
pub fn validatorsAccountsPda(program: Key) !sol.ProgramAddress {
    return sol.findProgramAddress(&.{ "hyperlane_multisig_ism", "-", "validators_and_threshold", "-", "account_metas" }, program);
}
pub fn domainPda(program: Key, domain: u32) !sol.ProgramAddress {
    var bytes: [4]u8 = undefined;
    std.mem.writeInt(u32, &bytes, domain, .little);
    return sol.findProgramAddress(&.{ "domain_ism", &bytes }, program);
}
pub const Validators = struct {
    allocator: A,
    addresses: [][20]u8,
    threshold: u8,
    pub fn deinit(self: *Validators) void {
        self.allocator.free(self.addresses);
        self.* = undefined;
    }
};
pub fn decodeValidators(a: A, bytes: []const u8) !Validators {
    var reader: borsh.Reader = .{ .bytes = bytes };
    const count = try reader.uint(u32);
    if (count == 0 or count > 256) return error.InvalidThreshold;
    const addresses = try a.alloc([20]u8, count);
    errdefer a.free(addresses);
    for (addresses) |*address| address.* = (try reader.take(20))[0..20].*;
    const threshold = try reader.uint(u8);
    if (threshold == 0 or threshold > count) return error.InvalidThreshold;
    try reader.simulationEnd();
    return .{ .allocator = a, .addresses = addresses, .threshold = threshold };
}
pub const Client = struct {
    mailbox: *Mailbox,
    identity: ?Key = null,
    fn query(self: Client, program: Key, data: []const u8, metas: []const sol.AccountMeta) ![]u8 {
        var simulation = try self.mailbox.simulateInstruction(.{ .program = program, .data = data, .accounts = metas });
        defer simulation.deinit();
        return try simulation.returnData(program) orelse error.MissingIsmReturnData;
    }
    pub fn moduleType(self: Client, program: Key) !u32 {
        const a = self.mailbox.client.rpc_client.allocator;
        const meta: sol.AccountMeta = .{ .key = (try ix.verifyAccountsPda(program)).key };
        // Missing successful return data must not trigger a different call.
        var simulation = self.mailbox.simulateInstruction(.{ .program = program, .data = &ix.type_discriminator, .accounts = &.{meta} }) catch |err| switch (err) {
            error.OutOfMemory, error.RequestCancelled, error.PendingReadIo => return err,
            else => return self.typeWithoutAccounts(program),
        };
        defer simulation.deinit();
        if (!try simulation.succeeded()) return self.typeWithoutAccounts(program);
        const returned = (simulation.returnData(program) catch |err| switch (err) {
            error.OutOfMemory, error.WrongReturnDataProgram => return err,
            else => return self.typeWithoutAccounts(program),
        }) orelse return error.MissingIsmReturnData;
        defer a.free(returned);
        const value = ix.decodeModuleType(returned) catch return self.typeWithoutAccounts(program);
        return if (value <= 13) value else 0;
    }
    fn typeWithoutAccounts(self: Client, program: Key) !u32 {
        const a = self.mailbox.client.rpc_client.allocator;
        const returned = try self.query(program, &ix.type_discriminator, &.{});
        defer a.free(returned);
        const value = try ix.decodeModuleType(returned);
        return if (value <= 13) value else 0;
    }
    pub fn validatorsAndThreshold(self: Client, a: A, program: Key, message: Message) !Validators {
        const rpc_a = self.mailbox.client.rpc_client.allocator;
        const encoded = try message.encodeAlloc(a);
        defer a.free(encoded);
        const data = try a.alloc(u8, 8 + encoded.len);
        defer a.free(data);
        @memcpy(data[8..], encoded);
        data[0..8].* = validators_accounts_discriminator;
        const meta: sol.AccountMeta = .{ .key = (try validatorsAccountsPda(program)).key };
        const returned = try self.query(program, data, &.{meta});
        defer rpc_a.free(returned);
        const metas = try ix.decodeAccountMetas(a, returned);
        defer a.free(metas);
        // Preserve getter account flags exactly as production Rust does. This
        // is unsigned simulation only; final process CPI metas are separately
        // sanitized before any real signing authority is requested.
        data[0..8].* = validators_discriminator;
        const configuration = try self.query(program, data, metas);
        defer rpc_a.free(configuration);
        return decodeValidators(a, configuration);
    }
    pub fn metadataSpec(self: Client, a: A, program: Key, message: Message) !ix.SpecResult {
        const rpc_a = self.mailbox.client.rpc_client.allocator;
        const encoded = try message.encodeAlloc(a);
        defer a.free(encoded);
        const data = try a.alloc(u8, 12 + encoded.len);
        defer a.free(data);
        _ = try ix.metadataSpecData(encoded, data);
        const vam = (try ix.verifyAccountsPda(program)).key;
        var current = try a.alloc(sol.AccountMeta, 2);
        defer a.free(current);
        current[0] = .{ .key = vam };
        current[1] = .{ .key = (try domainPda(program, message.origin)).key };
        for (0..10) |_| {
            const returned = try self.query(program, data, current);
            defer rpc_a.free(returned);
            var result = try ix.decodeMetadataSpec(a, returned, .{});
            if (result.spec != null) return result;
            defer result.deinit();
            if (result.accounts.len == 0 or !std.mem.eql(u8, &vam, &result.accounts[0])) return error.InvalidMetadataSpecAccounts;
            const next = try a.alloc(sol.AccountMeta, result.accounts.len);
            for (next, result.accounts) |*meta, key| meta.* = .{ .key = key };
            a.free(current);
            current = next;
        }
        return error.MetadataSpecDidNotConverge;
    }
    pub fn verify(self: Client, program: Key, message: Message, metadata: []const u8) !bool {
        const a = self.mailbox.client.rpc_client.allocator;
        const encoded = try message.encodeAlloc(a);
        defer a.free(encoded);
        const metas = try self.mailbox.verifyMetas(program, metadata, encoded, self.identity);
        defer a.free(metas);
        const data = try a.alloc(u8, 16 + encoded.len + metadata.len);
        defer a.free(data);
        const used = try ix.verifyData(ix.verify_discriminator, metadata, encoded, data);
        var simulation = try self.mailbox.simulateInstruction(.{ .program = program, .accounts = metas, .data = used });
        defer simulation.deinit();
        return simulation.succeeded();
    }
};

test "SVM validators Borsh rejects every truncated prefix" {
    const a = std.testing.allocator;
    var data: [46]u8 = .{0} ** 46;
    std.mem.writeInt(u32, data[0..4], 2, .little);
    data[44] = 1;
    data[45] = 0;
    var result = try decodeValidators(a, &data);
    defer result.deinit();
    try std.testing.expectEqual(@as(usize, 2), result.addresses.len);
    for (0..45) |n| {
        if (decodeValidators(a, data[0..n])) |owned| {
            var unexpected = owned;
            unexpected.deinit();
            return error.ExpectedTruncation;
        } else |_| {}
    }
    data[44] = 3;
    try std.testing.expectError(error.InvalidThreshold, decodeValidators(a, &data));
}
