//! Tendermint/CometBFT JSON-RPC. ABCI proofs are retained as unverified proof
//! operations; authenticated light-client/ICS23 verification is a separate gate.
const std = @import("std");
const rpc = @import("../evm/provider.zig");
const types = @import("types.zig");
const Hash = types.Hash;
pub const Compat = enum { v034, v037, v038 };
pub const Status = struct { height: u64, block_hash: Hash, catching_up: bool };
pub const ProofOp = struct { typ: []u8, key: []u8, data: []u8 };
pub const QueryResponse = struct {
    allocator: std.mem.Allocator,
    height: u64,
    key: []u8,
    value: []u8,
    unverified_proof_ops: []ProofOp,
    pub fn deinit(self: *QueryResponse) void {
        self.allocator.free(self.key);
        self.allocator.free(self.value);
        for (self.unverified_proof_ops) |op| {
            self.allocator.free(op.typ);
            self.allocator.free(op.key);
            self.allocator.free(op.data);
        }
        self.allocator.free(self.unverified_proof_ops);
        self.* = undefined;
    }
};
fn base64(allocator: std.mem.Allocator, value: std.json.Value) ![]u8 {
    if (value == .null) return allocator.alloc(u8, 0); // cometbft-rs Option<CowStr> default
    const text = try types.string(value);
    const decoder = std.base64.standard.Decoder;
    const bytes = try allocator.alloc(u8, try decoder.calcSizeForSlice(text));
    errdefer allocator.free(bytes);
    try decoder.decode(bytes, text);
    return bytes;
}

pub const Client = struct {
    rpc_client: *rpc.RpcClient,
    chain_id: []const u8,
    compat: Compat,

    pub fn status(self: Client) !Status {
        var response = try self.rpc_client.call("status", .{});
        defer response.deinit();
        const network = try types.string(try types.field(try types.field(response.value(), "node_info"), "network"));
        if (!std.mem.eql(u8, network, self.chain_id)) return error.WrongCosmosChainId;
        const info = try types.field(response.value(), "sync_info");
        const catching_up = try types.field(info, "catching_up");
        if (catching_up != .bool) return error.InvalidCosmosJson;
        return .{ .height = try types.uint(try types.field(info, "latest_block_height")), .block_hash = try types.hash(try types.string(try types.field(info, "latest_block_hash"))), .catching_up = catching_up.bool };
    }
    pub fn block(self: Client, height: u64) !rpc.RpcResponse {
        if (height == 0) return error.InvalidCosmosHeight;
        var buffer: [20]u8 = undefined;
        var response = try self.rpc_client.call("block", .{ .height = try std.fmt.bufPrint(&buffer, "{d}", .{height}) });
        errdefer response.deinit();
        const header = try types.field(try types.field(response.value(), "block"), "header");
        if (!std.mem.eql(u8, try types.string(try types.field(header, "chain_id")), self.chain_id)) return error.WrongCosmosChainId;
        if (try types.uint(try types.field(header, "height")) != height) return error.WrongCosmosBlockHeight;
        _ = try types.hash(try types.string(try types.field(try types.field(response.value(), "block_id"), "hash")));
        return response;
    }
    pub fn blockResults(self: Client, height: u64) !rpc.RpcResponse {
        if (height == 0) return error.InvalidCosmosHeight;
        var buffer: [20]u8 = undefined;
        var response = try self.rpc_client.call("block_results", .{ .height = try std.fmt.bufPrint(&buffer, "{d}", .{height}) });
        errdefer response.deinit();
        if (try types.uint(try types.field(response.value(), "height")) != height) return error.WrongCosmosBlockHeight;
        const tx_results = try types.field(response.value(), "txs_results");
        if (tx_results != .null and tx_results != .array) return error.InvalidCosmosJson;
        return response;
    }
    pub fn tx(self: Client, hash: Hash, prove: bool) !rpc.RpcResponse {
        const allocator = self.rpc_client.allocator;
        // cometbft-rs tx::Request serializes its hash as base64, unlike
        // the hexadecimal hash returned in tx::Response.
        var hash_text: [44]u8 = undefined;
        _ = std.base64.standard.Encoder.encode(&hash_text, &hash);
        var response = try self.rpc_client.call("tx", .{ .hash = hash_text[0..], .prove = prove });
        errdefer response.deinit();
        const returned = try types.hash(try types.string(try types.field(response.value(), "hash")));
        if (!std.mem.eql(u8, &hash, &returned)) return error.WrongCosmosTxHash;
        const bytes = try base64(allocator, try types.field(response.value(), "tx"));
        defer allocator.free(bytes);
        var expected: Hash = undefined;
        std.crypto.hash.sha2.Sha256.hash(bytes, &expected, .{});
        if (!std.mem.eql(u8, &expected, &hash)) return error.WrongCosmosTxHash;
        _ = try types.uint(try types.field(response.value(), "height"));
        _ = try types.uint(try types.field(try types.field(response.value(), "tx_result"), "code"));
        return response;
    }
    pub fn abciQuery(self: Client, path: []const u8, request: []const u8, height: ?u64, prove: bool) !QueryResponse {
        if (path.len == 0 or path[0] != '/' or path.len > 256) return error.InvalidAbciPath;
        const allocator = self.rpc_client.allocator;
        const data = try types.hex(allocator, request);
        defer allocator.free(data);
        // The production cometbft-rs serializer uses uppercase hex, no 0x prefix.
        for (data) |*char| char.* = std.ascii.toUpper(char.*);
        var buffer: [20]u8 = undefined;
        const height_text: ?[]const u8 = if (height) |number| try std.fmt.bufPrint(&buffer, "{d}", .{number}) else null;
        var response = if (height_text) |actual|
            try self.rpc_client.call("abci_query", .{ .path = path, .data = data, .height = actual, .prove = prove })
        else
            try self.rpc_client.call("abci_query", .{ .path = path, .data = data, .prove = prove });
        defer response.deinit();
        const value = try types.field(response.value(), "response");
        if (try types.uint(try types.field(value, "code")) != 0) return error.AbciQueryFailed;
        const actual_height = try types.uint(try types.field(value, "height"));
        if (height) |expected| if (actual_height != expected) return error.WrongCosmosQueryHeight;
        const key = try base64(allocator, value.object.get("key") orelse .null);
        errdefer allocator.free(key);
        const bytes = try base64(allocator, value.object.get("value") orelse .null);
        errdefer allocator.free(bytes);
        var ops: std.ArrayList(ProofOp) = .empty;
        errdefer {
            for (ops.items) |op| {
                allocator.free(op.typ);
                allocator.free(op.key);
                allocator.free(op.data);
            }
            ops.deinit(allocator);
        }
        const proof_camel = if (value == .object) value.object.get("proofOps") else null;
        const proof_snake = if (value == .object) value.object.get("proof_ops") else null;
        const proof = if (value == .object) value.object.get("proof") else null;
        if (@as(usize, @intFromBool(proof != null)) + @intFromBool(proof_camel != null) + @intFromBool(proof_snake != null) > 1) return error.AmbiguousCosmosProof;
        const proofs = proof orelse proof_camel orelse proof_snake orelse .null;
        if (proofs != .null) {
            const entries = try types.field(proofs, "ops");
            if (entries != .array) return error.InvalidCosmosProof;
            for (entries.array.items) |entry| {
                const typ = try allocator.dupe(u8, try types.string(try types.field(entry, "type")));
                errdefer allocator.free(typ);
                const op_key = try base64(allocator, try types.field(entry, "key"));
                errdefer allocator.free(op_key);
                const op_data = try base64(allocator, try types.field(entry, "data"));
                errdefer allocator.free(op_data);
                try ops.append(allocator, .{ .typ = typ, .key = op_key, .data = op_data });
            }
        }
        if (prove and ops.items.len == 0) return error.MissingCosmosProof;
        return .{ .allocator = allocator, .height = actual_height, .key = key, .value = bytes, .unverified_proof_ops = try ops.toOwnedSlice(allocator) };
    }
    /// Explicit broadcast API for already authorized, durably stored tx bytes.
    /// Callers must reconcile ambiguous failures by the same SHA256 transaction
    /// hash before signing any replacement account sequence.
    pub fn broadcastCommit(self: Client, raw: []const u8) !rpc.RpcResponse {
        const allocator = self.rpc_client.allocator;
        const text = try allocator.alloc(u8, std.base64.standard.Encoder.calcSize(raw.len));
        defer allocator.free(text);
        _ = std.base64.standard.Encoder.encode(text, raw);
        var response = try self.rpc_client.call("broadcast_tx_commit", .{ .tx = text });
        errdefer response.deinit();
        const value = response.value();
        if (try types.uint(try types.field(try types.field(value, "check_tx"), "code")) != 0) return error.CosmosCheckTxRejected;
        const delivered = try types.field(value, if (self.compat == .v038) "tx_result" else "deliver_tx");
        if (try types.uint(try types.field(delivered, "code")) != 0) return error.CosmosDeliverTxFailed;
        const hash = try types.hash(try types.string(try types.field(value, "hash")));
        var expected: Hash = undefined;
        std.crypto.hash.sha2.Sha256.hash(raw, &expected, .{});
        if (!std.mem.eql(u8, &hash, &expected)) return error.WrongCosmosTxHash;
        if (try types.uint(try types.field(value, "height")) == 0) return error.InvalidCosmosHeight;
        return response;
    }
};

test "Tendermint concrete client declarations typecheck" {
    std.testing.refAllDecls(Client);
}

const Fixture = struct {
    server: std.net.Server,
    method: []const u8,
    result: []const u8,
    fn serve(self: *Fixture) void {
        self.run() catch @panic("Cosmos RPC fixture failed");
    }
    fn run(self: *Fixture) !void {
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
                const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, request[header_end + 4 ..][0..length], .{});
                defer parsed.deinit();
                try std.testing.expectEqualStrings(self.method, try types.string(try types.field(parsed.value, "method")));
                if (std.mem.eql(u8, self.method, "tx")) {
                    const params = try types.field(parsed.value, "params");
                    try std.testing.expectEqualStrings("oShx/uIQ+4YZKR6uoZRYHL0lMeSyN1nSJfaAaSP2MiI=", try types.string(try types.field(params, "hash")));
                }
                if (std.mem.eql(u8, self.method, "abci_query")) {
                    const params = try types.field(parsed.value, "params");
                    try std.testing.expectEqualStrings("ABCD", try types.string(try types.field(params, "data")));
                    try std.testing.expectEqualStrings("100", try types.string(try types.field(params, "height")));
                }
                break;
            }
        }
        const body = try std.fmt.allocPrint(std.testing.allocator, "{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{s}}}", .{self.result});
        defer std.testing.allocator.free(body);
        var buffer: [160]u8 = undefined;
        try connection.stream.writeAll(try std.fmt.bufPrint(&buffer, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{body.len}));
        try connection.stream.writeAll(body);
    }
};
const FixtureOperation = enum { status, abci, proof, broadcast, tx };
fn loopback(result: []const u8, operation: FixtureOperation) !u64 {
    const methods = [_][]const u8{ "status", "abci_query", "abci_query", "broadcast_tx_commit", "tx" };
    var fixture: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .method = methods[@intFromEnum(operation)], .result = result };
    defer fixture.server.deinit();
    const url = try std.fmt.allocPrint(std.testing.allocator, "http://127.0.0.1:{d}/", .{fixture.server.listen_address.getPort()});
    defer std.testing.allocator.free(url);
    var rpc_client = try rpc.RpcClient.init(std.testing.allocator, url, .{ .max_response_bytes = 8192 });
    defer rpc_client.deinit();
    const client: Client = .{ .rpc_client = &rpc_client, .chain_id = "test-1", .compat = .v038 };
    const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
    defer thread.join();
    return switch (operation) {
        .status => (try client.status()).height,
        .abci, .proof => blk: {
            var response = try client.abciQuery("/cosmos.auth.v1beta1.Query/Account", &.{ 0xab, 0xcd }, 100, operation == .proof);
            defer response.deinit();
            break :blk if (operation == .proof) @intCast(response.unverified_proof_ops.len) else @intCast(response.value.len);
        },
        .tx => blk: {
            var response = try client.tx(try types.hash("a12871fee210fb8619291eaea194581c" ++ "bd2531e4b23759d225f6806923f63222"), false);
            defer response.deinit();
            break :blk try types.uint(try types.field(response.value(), "height"));
        },
        .broadcast => blk: {
            var response = try client.broadcastCommit(&.{ 1, 2 });
            defer response.deinit();
            break :blk try types.uint(try types.field(response.value(), "height"));
        },
    };
}

test "Tendermint HTTP ABI schema height and unverified proof decoding" {
    const status = "{\"node_info\":{\"network\":\"test-1\"},\"sync_info\":{\"latest_block_height\":\"100\",\"latest_block_hash\":\"11111111111111111111111111111111" ++ "11111111111111111111111111111111\",\"catching_up\":false}}";
    try std.testing.expectEqual(@as(u64, 100), try loopback(status, .status));
    const abci = "{\"response\":{\"code\":0,\"height\":\"100\",\"key\":\"\",\"value\":\"AQID\",\"proofOps\":null}}";
    try std.testing.expectEqual(@as(u64, 3), try loopback(abci, .abci));
    try std.testing.expectError(error.MissingCosmosProof, loopback(abci, .proof));
    const proved = "{\"response\":{\"code\":0,\"height\":\"100\",\"key\":\"\",\"value\":\"AQID\",\"proof\":{\"ops\":[{\"type\":\"ics23:iavl\",\"key\":\"AA==\",\"data\":\"AQ==\"}]}}}";
    try std.testing.expectEqual(@as(u64, 1), try loopback(proved, .proof));
    try std.testing.expectError(error.WrongCosmosQueryHeight, loopback("{\"response\":{\"code\":0,\"height\":\"101\"}}", .abci));
    try std.testing.expectError(error.AbciQueryFailed, loopback("{\"response\":{\"code\":17}}", .abci));
    const committed = "{\"check_tx\":{\"code\":0},\"tx_result\":{\"code\":0},\"hash\":\"a12871fee210fb8619291eaea194581c" ++ "bd2531e4b23759d225f6806923f63222\",\"height\":\"10\"}";
    try std.testing.expectEqual(@as(u64, 10), try loopback(committed, .broadcast));
    try std.testing.expectError(error.CosmosCheckTxRejected, loopback("{\"check_tx\":{\"code\":17}}", .broadcast));
    const transaction = "{\"hash\":\"a12871fee210fb8619291eaea194581c" ++ "bd2531e4b23759d225f6806923f63222\",\"height\":\"10\",\"tx\":\"AQI=\",\"tx_result\":{\"code\":0}}";
    try std.testing.expectEqual(@as(u64, 10), try loopback(transaction, .tx));
}
