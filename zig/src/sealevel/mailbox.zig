//! Read-only mailbox adapter and unsigned process-instruction preparation.
//! No private-key access, signing or network submission occurs here.
const std = @import("std");
const provider = @import("provider.zig");
const accounts = @import("accounts.zig");
const instructions = @import("instructions.zig");
const protocol = @import("../protocol/root.zig");
const solana = @import("../altvm/solana.zig");
const base58 = @import("../altvm/base58.zig");
pub const Key = [32]u8;
pub const OwnedDispatch = struct {
    account: provider.Account,
    key: Key,
    context_slot: u64,
    value: accounts.DispatchedMessage,
    pub fn deinit(self: *OwnedDispatch) void {
        self.account.deinit();
        self.* = undefined;
    }
};

pub const Mailbox = struct {
    client: *provider.Client,
    program: Key,
    domain: u32,
    payer: ?Key = null,

    pub fn inbox(self: Mailbox) !struct { slot: u64, value: accounts.Inbox } {
        const key = (try accounts.inboxPda(self.program)).key;
        var response = try self.client.account(key);
        defer response.deinit();
        const account = response.account orelse return error.MissingMailboxInbox;
        if (account.executable) return error.ExecutableMailboxAccount;
        const value = try accounts.Inbox.decode(account.data);
        try value.verify(self.program, key, account.owner);
        if (value.local_domain != self.domain) return error.WrongMailboxDomain;
        return .{ .slot = response.slot, .value = value };
    }
    pub fn outbox(self: Mailbox) !struct { slot: u64, value: accounts.Outbox } {
        const key = (try accounts.outboxPda(self.program)).key;
        var response = try self.client.account(key);
        defer response.deinit();
        const account = response.account orelse return error.MissingMailboxOutbox;
        if (account.executable) return error.ExecutableMailboxAccount;
        const value = try accounts.Outbox.decode(account.data);
        try value.verify(self.program, key, account.owner);
        if (value.local_domain != self.domain) return error.WrongMailboxDomain;
        return .{ .slot = response.slot, .value = value };
    }
    pub fn delivered(self: Mailbox, message_id: Key) !bool {
        const key = (try accounts.processedPda(self.program, message_id)).key;
        var response = try self.client.account(key);
        defer response.deinit();
        const account = response.account orelse return false;
        if (account.executable) return error.ExecutableMailboxAccount;
        const processed = try accounts.ProcessedMessage.decode(account.data);
        try processed.verify(self.program, key, account.owner);
        if (!std.mem.eql(u8, &processed.message_id, &message_id)) return error.WrongProcessedMessage;
        if (processed.slot > response.slot) return error.FutureMailboxAccount;
        return true;
    }
    /// Exact nonce lookup, bounded by transport response bytes. Accounts persist
    /// on chain, so an absent nonce below authenticated outbox.count is a gap.
    pub fn dispatchedByNonce(self: Mailbox, nonce: u32) !?OwnedDispatch {
        const allocator = self.client.rpc_client.allocator;
        const discriminator = try base58.encode(allocator, "DISPATCH");
        defer allocator.free(discriminator);
        var nonce_bytes: [4]u8 = undefined;
        std.mem.writeInt(u32, &nonce_bytes, nonce, .little);
        const nonce_text = try base58.encode(allocator, &nonce_bytes);
        defer allocator.free(nonce_text);
        const Filter = struct { memcmp: struct { offset: usize, bytes: []const u8 } };
        const filters = [_]Filter{ .{ .memcmp = .{ .offset = 1, .bytes = discriminator } }, .{ .memcmp = .{ .offset = 9, .bytes = nonce_text } } };
        var response = try self.client.programAccounts(self.program, &filters);
        defer response.deinit();
        const entries = (try provider.field(response.value(), "value")).array.items;
        if (entries.len == 0) return null;
        if (entries.len != 1) return error.DuplicateDispatchedNonce;
        const key = try provider.decodeKey(allocator, try provider.string(try provider.field(entries[0], "pubkey")));
        var account = try provider.decodeAccount(allocator, try provider.field(entries[0], "account"));
        errdefer account.deinit();
        if (account.executable) return error.ExecutableMailboxAccount;
        const value = try accounts.DispatchedMessage.decode(account.data);
        try value.verify(self.program, key, account.owner, self.domain);
        if (value.nonce != nonce) return error.WrongDispatchedNonce;
        const slot = try provider.uint(try provider.field(try provider.field(response.value(), "context"), "slot"));
        if (value.slot > slot) return error.FutureMailboxAccount;
        return .{ .account = account, .key = key, .context_slot = slot, .value = value };
    }

    pub fn simulateInstruction(self: Mailbox, instruction: solana.Instruction) !provider.Simulation {
        const payer = self.payer orelse return error.MissingSimulationPayer;
        var message_buffer: [1232]u8 = undefined;
        const compiled = try solana.compileLegacy(payer, .{0} ** 32, &.{instruction}, &message_buffer);
        var tx: [1232]u8 = undefined;
        var writer: solana.Writer = .{ .out = &tx };
        try writer.shortvec(compiled.signer_count);
        const zero_signature = [_]u8{0} ** 64;
        for (0..compiled.signer_count) |_| try writer.bytes(&zero_signature);
        try writer.bytes(compiled.bytes);
        return self.client.simulate(tx[0..writer.pos], .replace_blockhash);
    }

    fn queryMetas(self: Mailbox, program: Key, data: []const u8, metas: []const solana.AccountMeta) ![]solana.AccountMeta {
        var simulation = try self.simulateInstruction(.{ .program = program, .data = data, .accounts = metas });
        defer simulation.deinit();
        const returned = try simulation.returnData(program) orelse return self.client.rpc_client.allocator.alloc(solana.AccountMeta, 0);
        defer self.client.rpc_client.allocator.free(returned);
        return instructions.decodeAccountMetas(self.client.rpc_client.allocator, returned);
    }

    fn recipientIsm(self: Mailbox, recipient: Key, getter_metas: []const solana.AccountMeta) !Key {
        const allocator = self.client.rpc_client.allocator;
        const metas = try allocator.alloc(solana.AccountMeta, getter_metas.len + 2);
        defer allocator.free(metas);
        metas[0] = .{ .key = (try accounts.inboxPda(self.program)).key };
        metas[1] = .{ .key = recipient };
        @memcpy(metas[2..], getter_metas);
        var data: [33]u8 = undefined;
        data[0] = 3; // InboxGetRecipientIsm(Pubkey)
        data[1..33].* = recipient;
        var simulation = try self.simulateInstruction(.{ .program = self.program, .data = &data, .accounts = metas });
        defer simulation.deinit();
        const returned = try simulation.returnData(self.program) orelse return error.MissingRecipientIsmReturnData;
        defer allocator.free(returned);
        return instructions.decodeKeyReturn(returned);
    }

    pub fn verifyMetas(self: Mailbox, ism: Key, metadata: []const u8, message: []const u8, identity: ?Key) ![]solana.AccountMeta {
        const allocator = self.client.rpc_client.allocator;
        const payer = self.payer orelse return error.MissingSimulationPayer;
        var current = try allocator.alloc(solana.AccountMeta, 1);
        defer allocator.free(current);
        current[0] = .{ .key = (try instructions.verifyAccountsPda(ism)).key, .is_writable = true };
        const data = try allocator.alloc(u8, try std.math.add(usize, try std.math.add(usize, metadata.len, message.len), 16));
        defer allocator.free(data);
        _ = try instructions.verifyData(instructions.verify_accounts_discriminator, metadata, message, data);
        for (0..10) |_| {
            const next = try self.queryMetas(ism, data, current);
            errdefer allocator.free(next);
            var equal = next.len == current.len;
            if (equal) for (next, current) |left, right| {
                if (!std.meta.eql(left, right)) equal = false;
            };
            if (equal) {
                try instructions.sanitizeDynamic(next, payer, identity, null);
                return next;
            }
            allocator.free(current);
            current = next;
        }
        return error.AccountMetasDidNotConverge;
    }

    /// Public recipient ISM resolution used before selecting a metadata builder.
    pub fn recipientModule(self: Mailbox, recipient: Key) !Key {
        const allocator = self.client.rpc_client.allocator;
        const payer = self.payer orelse return error.MissingSimulationPayer;
        const pda = try instructions.recipientIsmAccountsPda(recipient);
        const metas = try self.queryMetas(recipient, &instructions.recipient_ism_accounts_discriminator, &.{.{ .key = pda.key, .is_writable = true }});
        defer allocator.free(metas);
        try instructions.sanitizeDynamic(metas, payer, null, null);
        return self.recipientIsm(recipient, metas);
    }

    /// Resolves recipient ISM and the full account-meta fixpoint. Every returned
    /// key/flag participates in convergence before signer privilege is stripped.
    /// Caller must simulate the final process instruction and enforce payment
    /// policy before authorizing a signature or persisting a transaction.
    pub fn processInstruction(self: Mailbox, message: protocol.Message, metadata: []const u8, noop: Key, identity: ?Key, forced_readonly: ?Key) !instructions.ProcessInstruction {
        const allocator = self.client.rpc_client.allocator;
        const payer = self.payer orelse return error.MissingSimulationPayer;
        if (message.destination != self.domain) return error.WrongMessageDestination;
        const getter_pda = try instructions.recipientIsmAccountsPda(message.recipient);
        const getter_metas = try self.queryMetas(message.recipient, &instructions.recipient_ism_accounts_discriminator, &.{.{ .key = getter_pda.key, .is_writable = true }});
        defer allocator.free(getter_metas);
        try instructions.sanitizeDynamic(getter_metas, payer, null, null);
        const ism = try self.recipientIsm(message.recipient, getter_metas);
        const encoded = try message.encodeAlloc(allocator);
        defer allocator.free(encoded);
        const verify_metas = try self.verifyMetas(ism, metadata, encoded, identity);
        defer allocator.free(verify_metas);
        const handle_data = try allocator.alloc(u8, try std.math.add(usize, message.body.len, 48));
        defer allocator.free(handle_data);
        const used = try instructions.handleData(message, true, handle_data);
        const handle_pda = try instructions.handleAccountsPda(message.recipient);
        const handle_metas = try self.queryMetas(message.recipient, used, &.{.{ .key = handle_pda.key, .is_writable = true }});
        defer allocator.free(handle_metas);
        try instructions.sanitizeDynamic(handle_metas, payer, null, forced_readonly);
        return instructions.buildProcess(allocator, .{ .mailbox = self.program, .payer = payer, .noop = noop, .ism = ism, .identity = identity, .destination_domain = self.domain, .message = message, .metadata = metadata, .ism_getter = getter_metas, .ism_verify = verify_metas, .handle = handle_metas, .handle_force_readonly = forced_readonly });
    }
};

test "mailbox adapter declarations typecheck with concrete read-only client" {
    std.testing.refAllDecls(Mailbox);
}

const SimulationFixture = struct {
    server: std.net.Server,
    cases: []const struct { program: Key, data: []const u8 },
    failure: ?anyerror = null,
    fn serve(self: *SimulationFixture) void {
        self.run() catch |err| {
            self.failure = err;
        };
    }
    fn run(self: *SimulationFixture) !void {
        const allocator = std.testing.allocator;
        for (self.cases, 1..) |case, id| {
            var poll_fds = [_]std.posix.pollfd{.{ .fd = self.server.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&poll_fds, 5000) == 0) return error.FixtureTimeout;
            const connection = try self.server.accept();
            defer connection.stream.close();
            var request: [8192]u8 = undefined;
            var used: usize = 0;
            while (true) {
                if (used == request.len) return error.FixtureRequestTooLarge;
                const count = try connection.stream.read(request[used..]);
                if (count == 0) return error.FixtureEof;
                used += count;
                if (std.mem.indexOf(u8, request[0..used], "\r\n\r\n")) |header_end| {
                    const prefix = "content-length: ";
                    const start = (std.mem.indexOf(u8, request[0..header_end], prefix) orelse return error.FixtureMissingLength) + prefix.len;
                    const end = std.mem.indexOfPos(u8, request[0..used], start, "\r\n") orelse return error.FixtureMissingLength;
                    const length = try std.fmt.parseInt(usize, request[start..end], 10);
                    if (used < header_end + 4 + length) continue;
                    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, request[header_end + 4 ..][0..length], .{});
                    defer parsed.deinit();
                    try std.testing.expectEqualStrings("simulateTransaction", try provider.string(try provider.field(parsed.value, "method")));
                    break;
                }
            }
            const program = try base58.encode(allocator, &case.program);
            defer allocator.free(program);
            const data = try allocator.alloc(u8, std.base64.standard.Encoder.calcSize(case.data.len));
            defer allocator.free(data);
            _ = std.base64.standard.Encoder.encode(data, case.data);
            const body = try std.json.Stringify.valueAlloc(allocator, .{ .jsonrpc = "2.0", .id = id, .result = .{ .context = .{ .slot = 8 }, .value = .{ .err = @as(?u8, null), .unitsConsumed = 1000, .returnData = .{ .programId = program, .data = .{ data, "base64" } } } } }, .{});
            defer allocator.free(body);
            var buffer: [160]u8 = undefined;
            try connection.stream.writeAll(try std.fmt.bufPrint(&buffer, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{body.len}));
            try connection.stream.writeAll(body);
        }
    }
};

test "HTTP process preparation resolves recipient ISM and account-meta fixpoint without keys" {
    const allocator = std.testing.allocator;
    const program = [_]u8{0x11} ** 32;
    const recipient = [_]u8{0x22} ** 32;
    const ism = [_]u8{0x14} ** 32;
    const empty = [_]u8{ 0, 0, 0, 0, 255 };
    var ism_return: [33]u8 = undefined;
    ism_return[0..32].* = ism;
    ism_return[32] = 255;
    var verify_first: [39]u8 = .{0} ** 39;
    std.mem.writeInt(u32, verify_first[0..4], 1, .little);
    verify_first[4..36].* = .{0x15} ** 32;
    verify_first[38] = 255;
    var verify_final = verify_first;
    verify_final[37] = 1; // same key, newly writable: requires another simulation
    var fixture: SimulationFixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .cases = &.{ .{ .program = recipient, .data = &empty }, .{ .program = program, .data = &ism_return }, .{ .program = ism, .data = &verify_first }, .{ .program = ism, .data = &verify_final }, .{ .program = ism, .data = &verify_final }, .{ .program = recipient, .data = &empty } } };
    defer fixture.server.deinit();
    const url = try std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}/", .{fixture.server.listen_address.getPort()});
    defer allocator.free(url);
    var client = try provider.Client.init(allocator, url, .{ .max_response_bytes = 8192 });
    defer client.deinit();
    const thread = try std.Thread.spawn(.{}, SimulationFixture.serve, .{&fixture});
    defer thread.join();
    const mailbox: Mailbox = .{ .client = &client, .program = program, .domain = 2000, .payer = .{0x12} ** 32 };
    var process = try mailbox.processInstruction(.{ .origin = 1000, .destination = 2000, .recipient = recipient, .body = "payload" }, &.{ 1, 2, 3 }, .{0x13} ** 32, null, null);
    defer process.deinit();
    try std.testing.expectEqual(@as(usize, 9), process.metas.len);
    try std.testing.expectEqual(ism, process.metas[6].key);
    try std.testing.expectEqual([_]u8{0x15} ** 32, process.metas[7].key);
    try std.testing.expect(process.metas[7].is_writable);
    try std.testing.expectEqual(recipient, process.metas[8].key);
    try std.testing.expectEqual(@as(i64, 7), client.rpc_client.next_id);
}

test "HTTP recipient cannot smuggle payer into dynamic CPI accounts" {
    const allocator = std.testing.allocator;
    const payer = [_]u8{0x12} ** 32;
    const recipient = [_]u8{0x22} ** 32;
    var malicious: [39]u8 = .{0} ** 39;
    std.mem.writeInt(u32, malicious[0..4], 1, .little);
    malicious[4..36].* = payer;
    malicious[38] = 255;
    var fixture: SimulationFixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .cases = &.{.{ .program = recipient, .data = &malicious }} };
    defer fixture.server.deinit();
    const url = try std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}/", .{fixture.server.listen_address.getPort()});
    defer allocator.free(url);
    var client = try provider.Client.init(allocator, url, .{ .max_response_bytes = 8192 });
    defer client.deinit();
    const thread = try std.Thread.spawn(.{}, SimulationFixture.serve, .{&fixture});
    defer thread.join();
    const mailbox: Mailbox = .{ .client = &client, .program = .{0x11} ** 32, .domain = 2000, .payer = payer };
    try std.testing.expectError(error.DynamicAccountContainsPayer, mailbox.processInstruction(.{ .origin = 1000, .destination = 2000, .recipient = recipient }, &.{}, .{0x13} ** 32, null, null));
    try std.testing.expectEqual(@as(i64, 2), client.rpc_client.next_id);
}
