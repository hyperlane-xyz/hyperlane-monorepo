//! Read-only Solana JSON-RPC with explicit finalized contexts. The shared
//! transport bounds bytes, validates JSON-RPC IDs, forbids redirects and verifies
//! HTTPS certificates. Account ownership/PDA validation remains mandatory.
const std = @import("std");
const rpc = @import("../evm/provider.zig");
const base58 = @import("../altvm/base58.zig");
pub const Key = [32]u8;
const Value = std.json.Value;
const Allocator = std.mem.Allocator;
pub const Commitment = enum { confirmed, finalized };

pub fn field(value: Value, name: []const u8) !Value {
    if (value != .object) return error.InvalidSvmResponse;
    return value.object.get(name) orelse error.MissingSvmField;
}
pub fn string(value: Value) ![]const u8 {
    if (value != .string) return error.InvalidSvmResponse;
    return value.string;
}
pub fn uint(value: Value) !u64 {
    return switch (value) {
        .integer => |number| if (number >= 0) @intCast(number) else error.InvalidSvmInteger,
        .number_string => |text| std.fmt.parseInt(u64, text, 10),
        else => error.InvalidSvmInteger,
    };
}
fn boolean(value: Value) !bool {
    if (value != .bool) return error.InvalidSvmResponse;
    return value.bool;
}

pub fn decodeKey(allocator: Allocator, text: []const u8) !Key {
    if (text.len < 32 or text.len > 44) return error.InvalidSvmPublicKey;
    const bytes = try base58.decode(allocator, text);
    defer allocator.free(bytes);
    if (bytes.len != 32) return error.InvalidSvmPublicKey;
    return bytes[0..32].*;
}
fn validateSignature(allocator: Allocator, text: []const u8) !void {
    if (text.len < 64 or text.len > 88) return error.InvalidSvmSignature;
    const bytes = try base58.decode(allocator, text);
    defer allocator.free(bytes);
    if (bytes.len != 64) return error.InvalidSvmSignature;
}
fn base64Data(allocator: Allocator, value: Value) ![]u8 {
    if (value != .array or value.array.items.len != 2) return error.InvalidSvmAccountEncoding;
    const text = try string(value.array.items[0]);
    if (!std.mem.eql(u8, try string(value.array.items[1]), "base64")) return error.InvalidSvmAccountEncoding;
    const decoder = std.base64.standard.Decoder;
    const bytes = try allocator.alloc(u8, try decoder.calcSizeForSlice(text));
    errdefer allocator.free(bytes);
    try decoder.decode(bytes, text);
    return bytes;
}
fn contextSlot(value: Value, minimum: ?u64) !u64 {
    const slot = try uint(try field(try field(value, "context"), "slot"));
    if (minimum) |min| if (slot < min) return error.StaleSvmContext;
    return slot;
}

pub const Account = struct {
    allocator: Allocator,
    owner: Key,
    executable: bool,
    lamports: u64,
    data: []u8,
    pub fn deinit(self: *Account) void {
        self.allocator.free(self.data);
        self.* = undefined;
    }
};
pub const AccountResult = struct {
    slot: u64,
    account: ?Account,
    pub fn deinit(self: *AccountResult) void {
        if (self.account) |*account| account.deinit();
        self.* = undefined;
    }
};
pub fn decodeAccount(allocator: Allocator, value: Value) !Account {
    const owner = try decodeKey(allocator, try string(try field(value, "owner")));
    const executable = try boolean(try field(value, "executable"));
    const lamports = try uint(try field(value, "lamports"));
    const data = try base64Data(allocator, try field(value, "data"));
    return .{ .allocator = allocator, .owner = owner, .executable = executable, .lamports = lamports, .data = data };
}

pub const Simulation = struct {
    response: rpc.RpcResponse,
    slot: u64,
    units_consumed: ?u64,
    pub fn deinit(self: *Simulation) void {
        self.response.deinit();
        self.* = undefined;
    }
    pub fn succeeded(self: Simulation) !bool {
        const value = try field(self.response.value(), "value");
        return (try field(value, "err")) == .null;
    }
    /// Return data is trusted only when the returning program exactly matches
    /// the program that was simulated. Caller owns returned bytes.
    pub fn returnData(self: Simulation, expected_program: Key) !?[]u8 {
        if (!try self.succeeded()) return error.SvmSimulationFailed;
        const value = try field(self.response.value(), "value");
        const returned = try field(value, "returnData");
        if (returned == .null) return null;
        const program = try decodeKey(self.response.allocator, try string(try field(returned, "programId")));
        if (!std.mem.eql(u8, &program, &expected_program)) return error.WrongReturnDataProgram;
        return try base64Data(self.response.allocator, try field(returned, "data"));
    }
};
pub const SimulationMode = enum { verify_signatures, replace_blockhash };
pub const Blockhash = struct { context_slot: u64, hash: Key, last_valid_block_height: u64 };
pub const Confirmation = enum { processed, confirmed, finalized };
pub const SignatureStatus = struct { slot: u64, failed: bool, confirmation: Confirmation };
pub const SignatureStatuses = struct {
    allocator: Allocator,
    context_slot: u64,
    values: []?SignatureStatus,
    pub fn deinit(self: *SignatureStatuses) void {
        self.allocator.free(self.values);
        self.* = undefined;
    }
};

pub fn decodeSignatureStatus(value: Value) !?SignatureStatus {
    if (value == .null) return null;
    const confirmation = std.meta.stringToEnum(Confirmation, try string(try field(value, "confirmationStatus"))) orelse return error.InvalidConfirmationStatus;
    return .{ .slot = try uint(try field(value, "slot")), .failed = (try field(value, "err")) != .null, .confirmation = confirmation };
}

pub const Client = struct {
    rpc_client: rpc.RpcClient,
    commitment: Commitment = .finalized,
    minimum_slot: ?u64 = null,
    /// Absolute monotonic job deadline, shared by all getter/fixpoint/ALT RPCs.
    /// The client is exclusively owned by one retained job while this is set.
    deadline_ns: ?u64 = null,

    pub fn nowNs() !u64 {
        const instant = try std.time.Instant.now();
        return try std.math.add(u64, try std.math.mul(u64, std.math.cast(u64, instant.timestamp.sec) orelse return error.UnsupportedClock, 1_000_000_000), @intCast(instant.timestamp.nsec));
    }
    fn remaining(self: *Client) !?u32 {
        const deadline = self.deadline_ns orelse return null;
        const now = try nowNs();
        if (now >= deadline) return error.SvmRequestDeadline;
        return @intCast(@min(std.math.maxInt(u32), (deadline - now + 999_999) / 1_000_000));
    }
    pub fn call(self: *Client, method: []const u8, params: anytype) !rpc.RpcResponse {
        const saved = self.rpc_client.options;
        defer self.rpc_client.options = saved;
        if (try self.remaining()) |ms| {
            self.rpc_client.options.timeout_ms = @min(saved.timeout_ms, ms);
            self.rpc_client.options.connect_timeout_ms = @min(saved.connect_timeout_ms, self.rpc_client.options.timeout_ms);
        }
        if (self.deadline_ns) |deadline| self.rpc_client.options.owner_deadline_ns = @min(saved.owner_deadline_ns orelse deadline, deadline);
        var response = try self.rpc_client.call(method, params);
        errdefer response.deinit();
        _ = try self.remaining();
        return response;
    }

    pub fn init(allocator: Allocator, url: []const u8, options: rpc.Options) !Client {
        var scoped = options;
        scoped.protocol = .sealevel;
        return .{ .rpc_client = try rpc.RpcClient.init(allocator, url, scoped) };
    }
    pub fn deinit(self: *Client) void {
        self.rpc_client.deinit();
        self.* = undefined;
    }
    pub fn checkGenesis(self: *Client, expected: Key) !void {
        var response = try self.call("getGenesisHash", .{});
        defer response.deinit();
        const actual = try decodeKey(self.rpc_client.allocator, try string(response.value()));
        if (!std.mem.eql(u8, &expected, &actual)) return error.WrongSvmGenesis;
    }
    pub fn slot(self: *Client) !u64 {
        var response = try self.call("getSlot", .{.{ .commitment = @tagName(self.commitment) }});
        defer response.deinit();
        const number = try uint(response.value());
        if (self.minimum_slot) |minimum| if (number < minimum) return error.StaleSvmContext;
        return number;
    }
    pub fn blockHeight(self: *Client) !u64 {
        var response = try self.call("getBlockHeight", .{.{ .commitment = @tagName(self.commitment) }});
        defer response.deinit();
        return uint(response.value());
    }
    pub fn latestBlockhash(self: *Client) !Blockhash {
        var response = try self.call("getLatestBlockhash", .{.{ .commitment = @tagName(self.commitment), .minContextSlot = self.minimum_slot }});
        defer response.deinit();
        const slot_number = try contextSlot(response.value(), self.minimum_slot);
        const value = try field(response.value(), "value");
        return .{ .context_slot = slot_number, .hash = try decodeKey(self.rpc_client.allocator, try string(try field(value, "blockhash"))), .last_valid_block_height = try uint(try field(value, "lastValidBlockHeight")) };
    }
    /// History search is mandatory for restart/expiry recovery; a missing recent
    /// status alone does not establish that a previously submitted tx failed.
    pub fn signatureStatuses(self: *Client, signatures_text: []const []const u8) !SignatureStatuses {
        if (signatures_text.len == 0 or signatures_text.len > 256) return error.InvalidSignatureLimit;
        for (signatures_text) |signature| try validateSignature(self.rpc_client.allocator, signature);
        var response = try self.call("getSignatureStatuses", .{ signatures_text, .{ .searchTransactionHistory = true } });
        defer response.deinit();
        const slot_number = try contextSlot(response.value(), self.minimum_slot);
        const value = try field(response.value(), "value");
        if (value != .array or value.array.items.len != signatures_text.len) return error.InvalidSvmResponse;
        const values = try self.rpc_client.allocator.alloc(?SignatureStatus, signatures_text.len);
        errdefer self.rpc_client.allocator.free(values);
        for (value.array.items, values) |entry, *status| status.* = try decodeSignatureStatus(entry);
        return .{ .allocator = self.rpc_client.allocator, .context_slot = slot_number, .values = values };
    }
    pub fn account(self: *Client, key: Key) !AccountResult {
        const text = try base58.encode(self.rpc_client.allocator, &key);
        defer self.rpc_client.allocator.free(text);
        var response = try self.call("getAccountInfo", .{ text, .{ .encoding = "base64", .commitment = @tagName(self.commitment), .minContextSlot = self.minimum_slot } });
        defer response.deinit();
        const slot_number = try contextSlot(response.value(), self.minimum_slot);
        const value = try field(response.value(), "value");
        return .{ .slot = slot_number, .account = if (value == .null) null else try decodeAccount(self.rpc_client.allocator, value) };
    }
    /// Result borrows its JSON response until deinit. Each account's owner,
    /// pubkey, lamports, executable and base64 payload is validated first.
    pub fn programAccounts(self: *Client, program: Key, filters: anytype) !rpc.RpcResponse {
        const text = try base58.encode(self.rpc_client.allocator, &program);
        defer self.rpc_client.allocator.free(text);
        var response = try self.call("getProgramAccounts", .{ text, .{ .encoding = "base64", .commitment = @tagName(self.commitment), .minContextSlot = self.minimum_slot, .withContext = true, .filters = filters } });
        errdefer response.deinit();
        _ = try contextSlot(response.value(), self.minimum_slot);
        const value = try field(response.value(), "value");
        if (value != .array) return error.InvalidSvmResponse;
        for (value.array.items) |entry| {
            _ = try decodeKey(self.rpc_client.allocator, try string(try field(entry, "pubkey")));
            var decoded = try decodeAccount(self.rpc_client.allocator, try field(entry, "account"));
            defer decoded.deinit();
            if (!std.mem.eql(u8, &decoded.owner, &program)) return error.WrongProgramAccountOwner;
        }
        return response;
    }
    pub fn signatures(self: *Client, key: Key, limit: u16, before: ?[]const u8) !rpc.RpcResponse {
        if (limit == 0 or limit > 1000) return error.InvalidSignatureLimit;
        if (before) |signature| try validateSignature(self.rpc_client.allocator, signature);
        const text = try base58.encode(self.rpc_client.allocator, &key);
        defer self.rpc_client.allocator.free(text);
        var response = try self.call("getSignaturesForAddress", .{ text, .{ .commitment = @tagName(self.commitment), .limit = limit, .before = before, .minContextSlot = self.minimum_slot } });
        errdefer response.deinit();
        const value = response.value();
        if (value != .array or value.array.items.len > limit) return error.InvalidSvmResponse;
        for (value.array.items) |entry| {
            try validateSignature(self.rpc_client.allocator, try string(try field(entry, "signature")));
            _ = try uint(try field(entry, "slot"));
            _ = try field(entry, "err");
            const status = try string(try field(entry, "confirmationStatus"));
            if (self.commitment == .finalized and !std.mem.eql(u8, status, "finalized")) return error.UnfinalizedSignature;
            if (!std.mem.eql(u8, status, "confirmed") and !std.mem.eql(u8, status, "finalized")) return error.UnfinalizedSignature;
        }
        return response;
    }
    pub fn transaction(self: *Client, signature: []const u8) !rpc.RpcResponse {
        try validateSignature(self.rpc_client.allocator, signature);
        var response = try self.call("getTransaction", .{ signature, .{ .encoding = "json", .commitment = @tagName(self.commitment), .maxSupportedTransactionVersion = 0 } });
        errdefer response.deinit();
        if (response.value() != .null) {
            _ = try uint(try field(response.value(), "slot"));
            const meta = try field(response.value(), "meta");
            if (meta != .null) _ = try field(meta, "err");
            _ = try field(response.value(), "transaction");
        }
        return response;
    }
    pub fn simulate(self: *Client, transaction_bytes: []const u8, mode: SimulationMode) !Simulation {
        if (transaction_bytes.len == 0 or transaction_bytes.len > 1232) return error.InvalidSimulationTransactionSize;
        const codec = std.base64.standard.Encoder;
        const text = try self.rpc_client.allocator.alloc(u8, codec.calcSize(transaction_bytes.len));
        defer self.rpc_client.allocator.free(text);
        _ = codec.encode(text, transaction_bytes);
        var response = try self.call("simulateTransaction", .{ text, .{ .encoding = "base64", .commitment = @tagName(self.commitment), .sigVerify = mode == .verify_signatures, .replaceRecentBlockhash = mode == .replace_blockhash, .minContextSlot = self.minimum_slot } });
        errdefer response.deinit();
        const slot_number = try contextSlot(response.value(), self.minimum_slot);
        const value = try field(response.value(), "value");
        _ = try field(value, "err");
        const units = try field(value, "unitsConsumed");
        return .{ .response = response, .slot = slot_number, .units_consumed = if (units == .null) null else try uint(units) };
    }
};

test "Solana account JSON validates owner data encoding and bounded uint" {
    const text = "{\"owner\":\"11111111111111111111111111111111\",\"lamports\":12,\"executable\":false,\"data\":[\"AQID\",\"base64\"]}";
    const parsed = try std.json.parseFromSlice(Value, std.testing.allocator, text, .{});
    defer parsed.deinit();
    var account_value = try decodeAccount(std.testing.allocator, parsed.value);
    defer account_value.deinit();
    try std.testing.expectEqualSlices(u8, &.{ 1, 2, 3 }, account_value.data);
    try std.testing.expectEqual([_]u8{0} ** 32, account_value.owner);
    try std.testing.expectError(error.InvalidSvmInteger, uint(.{ .integer = -1 }));
    try std.testing.expectError(error.InvalidSvmInteger, uint(.{ .float = 10.5 }));
    try std.testing.expectError(error.InvalidSvmPublicKey, decodeKey(std.testing.allocator, "111"));
}

const Fixture = struct {
    server: std.net.Server,
    result: []const u8,
    method: []const u8,
    failure: ?anyerror = null,

    fn serve(self: *Fixture) void {
        self.run() catch |err| {
            self.failure = err;
        };
    }
    fn run(self: *Fixture) !void {
        const connection = try self.server.accept();
        defer connection.stream.close();
        var request: [8192]u8 = undefined;
        var used: usize = 0;
        while (true) {
            if (used == request.len) return error.FixtureRequestTooLarge;
            const count = try connection.stream.read(request[used..]);
            if (count == 0) return error.FixtureUnexpectedEof;
            used += count;
            if (std.mem.indexOf(u8, request[0..used], "\r\n\r\n")) |header_end| {
                const prefix = "content-length: ";
                const length_start = (std.mem.indexOf(u8, request[0..header_end], prefix) orelse return error.FixtureMissingLength) + prefix.len;
                const length_end = std.mem.indexOfPos(u8, request[0..used], length_start, "\r\n") orelse return error.FixtureMissingLength;
                const length = try std.fmt.parseInt(usize, request[length_start..length_end], 10);
                if (used < header_end + 4 + length) continue;
                const parsed = try std.json.parseFromSlice(Value, std.testing.allocator, request[header_end + 4 ..][0..length], .{});
                defer parsed.deinit();
                try std.testing.expectEqualStrings(self.method, try string(try field(parsed.value, "method")));
                const params = try field(parsed.value, "params");
                if (params != .array) return error.InvalidFixtureParams;
                if (std.mem.eql(u8, self.method, "getSignatureStatuses")) {
                    try std.testing.expect(try boolean(try field(params.array.items[1], "searchTransactionHistory")));
                } else if (!std.mem.eql(u8, self.method, "getGenesisHash")) {
                    const config = params.array.items[params.array.items.len - 1];
                    try std.testing.expectEqualStrings("finalized", try string(try field(config, "commitment")));
                }
                break;
            }
        }
        const body = try std.fmt.allocPrint(std.testing.allocator, "{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{s}}}", .{self.result});
        defer std.testing.allocator.free(body);
        var header_buffer: [160]u8 = undefined;
        const header = try std.fmt.bufPrint(&header_buffer, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{body.len});
        try connection.stream.writeAll(header);
        try connection.stream.writeAll(body);
    }
};
const FixtureOperation = enum { genesis, slot, account, programs, signatures, transaction, simulate, height, blockhash, statuses };
fn loopback(result: []const u8, operation: FixtureOperation, minimum: ?u64) !u64 {
    const methods = [_][]const u8{ "getGenesisHash", "getSlot", "getAccountInfo", "getProgramAccounts", "getSignaturesForAddress", "getTransaction", "simulateTransaction", "getBlockHeight", "getLatestBlockhash", "getSignatureStatuses" };
    var fixture: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .result = result, .method = methods[@intFromEnum(operation)] };
    defer fixture.server.deinit();
    const url = try std.fmt.allocPrint(std.testing.allocator, "http://127.0.0.1:{d}/", .{fixture.server.listen_address.getPort()});
    defer std.testing.allocator.free(url);
    var client = try Client.init(std.testing.allocator, url, .{ .max_response_bytes = 8192 });
    defer client.deinit();
    client.minimum_slot = minimum;
    const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
    defer thread.join();
    const signature = "11111111111111111111111111111111" ++ "11111111111111111111111111111111";
    return switch (operation) {
        .genesis => blk: {
            try client.checkGenesis(.{0} ** 32);
            break :blk 1;
        },
        .slot => client.slot(),
        .height => client.blockHeight(),
        .blockhash => (try client.latestBlockhash()).last_valid_block_height,
        .statuses => blk: {
            var response = try client.signatureStatuses(&.{signature});
            defer response.deinit();
            break :blk if (response.values[0]) |status| status.slot else 0;
        },
        .account => blk: {
            var response = try client.account(.{0} ** 32);
            defer response.deinit();
            break :blk if (response.account) |value| value.lamports else 0;
        },
        .programs => blk: {
            var response = try client.programAccounts(.{0} ** 32, .{});
            defer response.deinit();
            break :blk @intCast((try field(response.value(), "value")).array.items.len);
        },
        .signatures => blk: {
            var response = try client.signatures(.{0} ** 32, 10, null);
            defer response.deinit();
            break :blk @intCast(response.value().array.items.len);
        },
        .transaction => blk: {
            var response = try client.transaction(signature);
            defer response.deinit();
            break :blk if (response.value() == .null) 0 else 1;
        },
        .simulate => blk: {
            var response = try client.simulate(&.{ 1, 2 }, .replace_blockhash);
            defer response.deinit();
            const returned = try response.returnData(.{0} ** 32);
            if (returned) |bytes| std.testing.allocator.free(bytes);
            break :blk response.units_consumed orelse 0;
        },
    };
}

test "SVM HTTP requests preserve finality genesis account context and schemas" {
    try std.testing.expectEqual(@as(u64, 1), try loopback("\"11111111111111111111111111111111\"", .genesis, null));
    try std.testing.expectError(error.WrongSvmGenesis, loopback("\"11111111111111111111111111111112\"", .genesis, null));
    try std.testing.expectEqual(@as(u64, 8), try loopback("8", .slot, null));
    try std.testing.expectEqual(@as(u64, 8), try loopback("8", .height, null));
    try std.testing.expectEqual(@as(u64, 100), try loopback("{\"context\":{\"slot\":8},\"value\":{\"blockhash\":\"11111111111111111111111111111111\",\"lastValidBlockHeight\":100}}", .blockhash, null));
    try std.testing.expectEqual(@as(u64, 7), try loopback("{\"context\":{\"slot\":8},\"value\":[{\"slot\":7,\"confirmationStatus\":\"finalized\",\"err\":null}]}", .statuses, null));
    try std.testing.expectError(error.InvalidConfirmationStatus, loopback("{\"context\":{\"slot\":8},\"value\":[{\"slot\":7,\"confirmationStatus\":\"unknown\",\"err\":null}]}", .statuses, null));
    try std.testing.expectError(error.StaleSvmContext, loopback("8", .slot, 9));
    try std.testing.expectEqual(@as(u64, 0), try loopback("{\"context\":{\"slot\":8},\"value\":null}", .account, null));
    try std.testing.expectEqual(@as(u64, 12), try loopback("{\"context\":{\"slot\":8},\"value\":{\"owner\":\"11111111111111111111111111111111\",\"lamports\":12,\"executable\":false,\"data\":[\"AQID\",\"base64\"]}}", .account, null));
    try std.testing.expectError(error.StaleSvmContext, loopback("{\"context\":{\"slot\":8},\"value\":null}", .account, 9));
    try std.testing.expectEqual(@as(u64, 0), try loopback("{\"context\":{\"slot\":8},\"value\":[]}", .programs, null));
    try std.testing.expectEqual(@as(u64, 0), try loopback("[]", .signatures, null));
    try std.testing.expectEqual(@as(u64, 0), try loopback("null", .transaction, null));
    const simulated = "{\"context\":{\"slot\":8},\"value\":{\"err\":null,\"unitsConsumed\":10,\"returnData\":{\"programId\":\"11111111111111111111111111111111\",\"data\":[\"AQID\",\"base64\"]}}}";
    try std.testing.expectEqual(@as(u64, 10), try loopback(simulated, .simulate, null));
    const wrong_program = "{\"context\":{\"slot\":8},\"value\":{\"err\":null,\"unitsConsumed\":10,\"returnData\":{\"programId\":\"11111111111111111111111111111112\",\"data\":[\"AQID\",\"base64\"]}}}";
    try std.testing.expectError(error.WrongReturnDataProgram, loopback(wrong_program, .simulate, null));
    try std.testing.expectError(error.SvmSimulationFailed, loopback("{\"context\":{\"slot\":8},\"value\":{\"err\":{\"InstructionError\":[0,1]},\"unitsConsumed\":10,\"returnData\":null}}", .simulate, null));
}
