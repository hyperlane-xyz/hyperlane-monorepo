//! Distinct CosmWasm JSON and native-module protobuf query contracts. Historical
//! queries retain x-cosmos-block-height through the injected gRPC transport.
const std = @import("std");
const grpc = @import("grpc.zig");
const proto = @import("proto.zig");
const types = @import("types.zig");
const protocol = @import("../protocol/root.zig");
const tx = @import("../altvm/cosmos.zig");
const pb = @import("../altvm/protobuf.zig");
const Config = @import("config.zig").Config;
const Hash = types.Hash;
const Empty = struct {};

pub fn Owned(comptime T: type) type {
    return struct {
        response: grpc.Response,
        value: T,
        pub fn deinit(self: *@This()) void {
            self.response.deinit();
            self.* = undefined;
        }
    };
}
pub const JsonResponse = struct {
    response: grpc.Response,
    parsed: std.json.Parsed(std.json.Value),
    pub fn deinit(self: *JsonResponse) void {
        self.parsed.deinit();
        self.response.deinit();
        self.* = undefined;
    }
};
pub const ModuleType = enum { unused, routing, aggregation, message_id_multisig, merkle_root_multisig, null_metadata, ccip_read };
pub const Locations = struct {
    arena: std.heap.ArenaAllocator,
    values: []const []const []const u8,
    pub fn deinit(self: *Locations) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub const VerifyInfoKind = enum { multisig, aggregation };
pub const VerifyInfo = struct { entries: [256]Hash, len: usize, threshold: u8 };
pub const Client = struct {
    allocator: std.mem.Allocator,
    transport: grpc.Transport,
    config: Config,
    domain: u32,
    cancel: ?*const std.atomic.Value(bool) = null,
    timeout_ms: u32 = 30000,

    fn requestRpc(self: Client, requested: grpc.Request) !grpc.Response {
        var request = requested;
        request.cancel = self.cancel orelse requested.cancel;
        request.timeout_ms = @min(self.timeout_ms, requested.timeout_ms);
        return self.transport.call(self.allocator, request);
    }
    pub fn blockHeight(self: Client) !u64 {
        var response = try self.requestRpc(.{ .method = proto.paths.latest_validators, .protobuf = "" });
        defer response.deinit();
        return proto.latestValidatorHeight(response.protobuf);
    }
    pub fn finalizedHeight(self: Client) !u64 {
        const height = try self.blockHeight();
        if (height < self.config.confirmations) return error.InsufficientCosmosConfirmations;
        return height - self.config.confirmations;
    }
    pub fn smartQuery(self: Client, contract: Hash, payload: anytype, height: ?u64) !JsonResponse {
        try self.config.validate();
        var address_buffer: [90]u8 = undefined;
        const address = try types.contractAddress(self.config.bech32_prefix, contract, self.config.contract_address_bytes, &address_buffer);
        const json = try std.json.Stringify.valueAlloc(self.allocator, payload, .{});
        defer self.allocator.free(json);
        const request = try proto.smartQuery(self.allocator, address, json);
        defer self.allocator.free(request);
        var response = try self.requestRpc(.{ .method = proto.paths.smart_query, .protobuf = request, .height = height });
        errdefer response.deinit();
        const bytes = try proto.bytesField(response.protobuf, 1) orelse return error.MissingSmartQueryResponse;
        return .{ .response = response, .parsed = try std.json.parseFromSlice(std.json.Value, self.allocator, bytes, .{ .duplicate_field_behavior = .@"error" }) };
    }
    pub fn wasmNonce(self: Client, mailbox: Hash, height: u64) !u32 {
        var response = try self.smartQuery(mailbox, .{ .mailbox = .{ .nonce = Empty{} } }, height);
        defer response.deinit();
        const nonce = try types.uint(try types.field(response.parsed.value, "nonce"));
        if (nonce > std.math.maxInt(u32)) return error.ProtobufOverflow;
        return @intCast(nonce);
    }
    pub fn wasmDelivered(self: Client, mailbox: Hash, message_id: Hash) !bool {
        return self.wasmDeliveredAt(mailbox, message_id, null);
    }
    pub fn wasmDeliveredAt(self: Client, mailbox: Hash, message_id: Hash, height: ?u64) !bool {
        const id = try types.hex(self.allocator, &message_id);
        defer self.allocator.free(id);
        var response = try self.smartQuery(mailbox, .{ .mailbox = .{ .message_delivered = .{ .id = id } } }, height);
        defer response.deinit();
        const value = try types.field(response.parsed.value, "delivered");
        if (value != .bool) return error.InvalidCosmosJson;
        return value.bool;
    }
    /// Source contract-info query. Only authenticated gRPC NotFound becomes
    /// false; transport/auth/malformed responses remain errors (Rust swallows all).
    pub fn wasmIsContract(self: Client, recipient: Hash) !bool {
        try self.config.validate();
        var buffer: [90]u8 = undefined;
        const address = try types.contractAddress(self.config.bech32_prefix, recipient, self.config.contract_address_bytes, &buffer);
        const request = try proto.queryString(self.allocator, address);
        defer self.allocator.free(request);
        var response = self.requestRpc(.{ .method = proto.paths.contract_info, .protobuf = request }) catch |err| switch (err) {
            error.GrpcNotFound => return false,
            else => return err,
        };
        defer response.deinit();
        const actual = try proto.textField(response.protobuf, 1);
        if (!std.mem.eql(u8, actual, address)) return error.CosmWasmContractInfoAddressMismatch;
        const info = try proto.bytesField(response.protobuf, 2) orelse return error.EmptyCosmWasmContractInfo;
        _ = try proto.uintField(info, 1);
        for ([_]u29{ 2, 3, 4, 6 }) |tag| _ = try proto.textField(info, tag);
        if (try proto.bytesField(info, 5)) |created| {
            _ = try proto.uintField(created, 1);
            _ = try proto.uintField(created, 2);
        }
        if (try proto.bytesField(info, 7)) |extension| {
            _ = try proto.textField(extension, 1);
            _ = try proto.bytesField(extension, 2);
        }
        return true;
    }
    pub fn wasmDefaultIsm(self: Client, mailbox: Hash) !Hash {
        var response = try self.smartQuery(mailbox, .{ .mailbox = .{ .default_ism = Empty{} } }, null);
        defer response.deinit();
        return types.decodeAddress(try types.string(try types.field(response.parsed.value, "default_ism")), self.config.bech32_prefix);
    }
    pub fn wasmRecipientIsm(self: Client, mailbox: Hash, recipient: Hash) !Hash {
        var address: [90]u8 = undefined;
        var response = try self.smartQuery(mailbox, .{ .mailbox = .{ .recipient_ism = .{ .recipient_addr = try types.contractAddress(self.config.bech32_prefix, recipient, self.config.contract_address_bytes, &address) } } }, null);
        defer response.deinit();
        return types.decodeAddress(try types.string(try types.field(response.parsed.value, "ism")), self.config.bech32_prefix);
    }
    pub fn wasmTree(self: Client, hook: Hash, height: u64) !protocol.IncrementalMerkle {
        var response = try self.smartQuery(hook, .{ .merkle_hook = .{ .tree = Empty{} } }, height);
        defer response.deinit();
        const branch = try types.field(response.parsed.value, "branch");
        if (branch != .array or branch.array.items.len != 32) return error.InvalidNativeTreeBranch;
        const count = try types.uint(try types.field(response.parsed.value, "count"));
        if (count > std.math.maxInt(u32)) return error.ProtobufOverflow;
        var tree = protocol.IncrementalMerkle.init();
        tree.count = @intCast(count);
        for (&tree.branch, branch.array.items) |*hash, value| hash.* = try types.hash(try types.string(value));
        return tree;
    }
    pub fn wasmModuleType(self: Client, ism: Hash) !ModuleType {
        var response = try self.smartQuery(ism, .{ .ism = .{ .module_type = Empty{} } }, null);
        defer response.deinit();
        const text = try types.string(try types.field(response.parsed.value, "type"));
        if (std.mem.eql(u8, text, "legacy_multisig")) return .message_id_multisig;
        if (std.mem.eql(u8, text, "null")) return .null_metadata;
        return std.meta.stringToEnum(ModuleType, text) orelse error.UnsupportedCosmWasmIsmType;
    }
    pub fn wasmVerify(self: Client, ism: Hash, message: protocol.Message, metadata: []const u8) !bool {
        const encoded = try message.encodeAlloc(self.allocator);
        defer self.allocator.free(encoded);
        const message_hex = try types.hex(self.allocator, encoded);
        defer self.allocator.free(message_hex);
        const metadata_hex = try types.hex(self.allocator, metadata);
        defer self.allocator.free(metadata_hex);
        var response = try self.smartQuery(ism, .{ .ism = .{ .verify = .{ .metadata = metadata_hex, .message = message_hex } } }, null);
        defer response.deinit();
        const value = try types.field(response.parsed.value, "verified");
        if (value != .bool) return error.InvalidCosmosJson;
        return value.bool;
    }
    pub fn wasmVerifyInfo(self: Client, ism: Hash, message: protocol.Message, kind: VerifyInfoKind) !VerifyInfo {
        const encoded = try message.encodeAlloc(self.allocator);
        defer self.allocator.free(encoded);
        const message_hex = try types.hex(self.allocator, encoded);
        defer self.allocator.free(message_hex);
        var response = try self.smartQuery(ism, .{ .ism = .{ .verify_info = .{ .message = message_hex } } }, null);
        defer response.deinit();
        const threshold = try types.uint(try types.field(response.parsed.value, "threshold"));
        const entries = try types.field(response.parsed.value, "validators");
        if (entries != .array or entries.array.items.len > 256 or threshold == 0 or threshold > 255 or threshold > entries.array.items.len) return error.InvalidThreshold;
        var result: VerifyInfo = .{ .entries = undefined, .len = entries.array.items.len, .threshold = @intCast(threshold) };
        for (entries.array.items, 0..) |entry, i| {
            const text = try types.string(entry);
            const hex = if (std.mem.startsWith(u8, text, "0x")) text[2..] else text;
            if (hex.len != 40 and (kind != .aggregation or hex.len != 64)) return error.InvalidNativeValidators;
            result.entries[i] = .{0} ** 32;
            _ = try std.fmt.hexToBytes(result.entries[i][32 - hex.len / 2 ..], hex);
        }
        return result;
    }
    pub fn wasmRoute(self: Client, ism: Hash, message: protocol.Message) !Hash {
        const encoded = try message.encodeAlloc(self.allocator);
        defer self.allocator.free(encoded);
        const message_hex = try types.hex(self.allocator, encoded);
        defer self.allocator.free(message_hex);
        var response = try self.smartQuery(ism, .{ .routing_ism = .{ .route = .{ .message = message_hex } } }, null);
        defer response.deinit();
        return types.decodeAddress(try types.string(try types.field(response.parsed.value, "ism")), self.config.bech32_prefix);
    }
    /// Query errors propagate. Missing announcements must be distinguished from
    /// transport failures before deciding whether to retry metadata retrieval.
    pub fn wasmLocations(self: Client, announce: Hash, validators: []const [20]u8) !Locations {
        return self.wasmLocationsAt(announce, validators, null);
    }
    pub fn wasmLocationsAt(self: Client, announce: Hash, validators: []const [20]u8, height: ?u64) !Locations {
        if (validators.len > 256) return error.TooManyValidators;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        errdefer arena.deinit();
        const allocator = arena.allocator();
        const encoded = try allocator.alloc([]const u8, validators.len);
        for (validators, encoded) |validator, *text| text.* = try types.hex(allocator, &validator);
        var response = try self.smartQuery(announce, .{ .get_announce_storage_locations = .{ .validators = encoded } }, height);
        defer response.deinit();
        const entries = try types.field(response.parsed.value, "storage_locations");
        if (entries != .array or entries.array.items.len != validators.len) return error.InvalidValidatorLocations;
        const result = try allocator.alloc([]const []const u8, validators.len);
        for (entries.array.items, validators, result) |entry, validator, *locations| {
            if (entry != .array or entry.array.items.len != 2) return error.InvalidValidatorLocations;
            const actual = try types.string(entry.array.items[0]);
            const expected = try types.hex(allocator, &validator);
            if (!std.ascii.eqlIgnoreCase(actual, expected)) return error.WrongAnnouncedValidator;
            const list = entry.array.items[1];
            if (list != .array or list.array.items.len > 1024) return error.InvalidValidatorLocations;
            const copied = try allocator.alloc([]const u8, list.array.items.len);
            for (list.array.items, copied) |location, *out| out.* = try allocator.dupe(u8, try types.string(location));
            locations.* = copied;
        }
        return .{ .arena = arena, .values = result };
    }
    /// Production native adapter treats an individual validator query failure
    /// as no locations, preserving other validators and the caller's order.
    pub fn nativeLocations(self: Client, mailbox: Hash, validators: []const [20]u8) !Locations {
        return self.nativeLocationsAt(mailbox, validators, null);
    }
    /// Pinned absence proofs must propagate every query failure. Latest callers
    /// preserve Rust's per-validator graceful degradation, never used as proof.
    pub fn nativeLocationsAt(self: Client, mailbox: Hash, validators: []const [20]u8, height: ?u64) !Locations {
        if (validators.len > 256) return error.TooManyValidators;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        errdefer arena.deinit();
        const allocator = arena.allocator();
        const id = try types.hex(allocator, &mailbox);
        const result = try allocator.alloc([]const []const u8, validators.len);
        var total_bytes: usize = 0;
        var total_count: usize = 0;
        for (validators, result) |validator, *locations| {
            var scratch = std.heap.ArenaAllocator.init(self.allocator);
            defer scratch.deinit();
            const found = self.nativeValidatorLocations(scratch.allocator(), id, validator, height) catch |err| {
                // Cancellation/allocation/cooperative read replay are control
                // boundaries, not a remote validator's absent announcement.
                if (height != null or err == error.OutOfMemory or err == error.RequestCancelled or err == error.PendingReadIo) return err;
                std.log.warn("Cosmos native validator locations unavailable: {s}", .{@errorName(err)});
                locations.* = &.{};
                continue;
            };
            total_count = try std.math.add(usize, total_count, found.len);
            if (total_count > 4096) return error.TooManyAnnouncedLocations;
            const copied = try allocator.alloc([]const u8, found.len);
            for (found, copied) |location, *out| {
                total_bytes = try std.math.add(usize, total_bytes, location.len);
                if (total_bytes > 2 * 1024 * 1024) return error.AnnouncementLocationsByteLimit;
                out.* = try allocator.dupe(u8, location);
            }
            locations.* = copied;
        }
        return .{ .arena = arena, .values = result };
    }
    fn nativeValidatorLocations(self: Client, allocator: std.mem.Allocator, id: []const u8, validator: [20]u8, height: ?u64) ![]const []const u8 {
        const text = try types.hex(allocator, &validator);
        const request = try proto.queryPair(allocator, id, text);
        var response = try self.requestRpc(.{ .method = proto.paths.validator_locations, .protobuf = request, .height = height });
        defer response.deinit();
        var list: std.ArrayList([]const u8) = .empty;
        var decoder: pb.Decoder = .{ .input = response.protobuf };
        while (try decoder.next()) |field| if (field.number == 1) {
            if (field.value != .bytes or list.items.len == 1024 or !std.unicode.utf8ValidateSlice(field.value.bytes)) return error.InvalidValidatorLocations;
            try list.append(allocator, try allocator.dupe(u8, field.value.bytes));
        };
        return list.toOwnedSlice(allocator);
    }
    pub fn nativeMailbox(self: Client, mailbox: Hash, height: ?u64) !Owned(proto.NativeMailbox) {
        const id = try types.hex(self.allocator, &mailbox);
        defer self.allocator.free(id);
        const request = try proto.queryString(self.allocator, id);
        defer self.allocator.free(request);
        var response = try self.requestRpc(.{ .method = proto.paths.mailbox, .protobuf = request, .height = height });
        errdefer response.deinit();
        const value = try proto.NativeMailbox.queryResponse(response.protobuf);
        if (!std.mem.eql(u8, &try types.hash(value.id), &mailbox) or value.domain != self.domain) return error.WrongNativeMailbox;
        return .{ .response = response, .value = value };
    }
    pub fn nativeDelivered(self: Client, mailbox: Hash, message_id: Hash) !bool {
        return self.nativeDeliveredAt(mailbox, message_id, null);
    }
    pub fn nativeDeliveredAt(self: Client, mailbox: Hash, message_id: Hash, height: ?u64) !bool {
        const id = try types.hex(self.allocator, &mailbox);
        defer self.allocator.free(id);
        const message_hex = try types.hex(self.allocator, &message_id);
        defer self.allocator.free(message_hex);
        const request = try proto.queryPair(self.allocator, id, message_hex);
        defer self.allocator.free(request);
        var response = try self.requestRpc(.{ .method = proto.paths.delivered, .protobuf = request, .height = height });
        defer response.deinit();
        return proto.boolField(response.protobuf, 1);
    }
    pub fn nativeRecipientIsm(self: Client, recipient: Hash) !Hash {
        const id = try types.hex(self.allocator, &recipient);
        defer self.allocator.free(id);
        const request = try proto.queryString(self.allocator, id);
        defer self.allocator.free(request);
        var response = try self.requestRpc(.{ .method = proto.paths.recipient_ism, .protobuf = request });
        defer response.deinit();
        return types.hash(try proto.textField(response.protobuf, 1));
    }
    pub fn nativeTree(self: Client, hook: Hash, mailbox: Hash, height: u64) !protocol.IncrementalMerkle {
        const id = try types.hex(self.allocator, &hook);
        defer self.allocator.free(id);
        const request = try proto.queryString(self.allocator, id);
        defer self.allocator.free(request);
        var response = try self.requestRpc(.{ .method = proto.paths.tree, .protobuf = request, .height = height });
        defer response.deinit();
        const value = try proto.NativeTree.queryResponse(response.protobuf);
        if (!std.mem.eql(u8, &try types.hash(value.id), &hook) or !std.mem.eql(u8, &try types.hash(value.mailbox_id), &mailbox)) return error.WrongNativeTree;
        return value.tree;
    }
    pub fn nativeIsm(self: Client, ism: Hash) !Owned(proto.Any) {
        const id = try types.hex(self.allocator, &ism);
        defer self.allocator.free(id);
        const request = try proto.queryString(self.allocator, id);
        defer self.allocator.free(request);
        var response = try self.requestRpc(.{ .method = proto.paths.ism, .protobuf = request });
        errdefer response.deinit();
        const any = try proto.Any.decode(try proto.bytesField(response.protobuf, 1) orelse return error.MissingNativeIsm);
        if (!std.mem.eql(u8, &try types.hash(try proto.textField(any.value, 1)), &ism)) return error.WrongNativeIsm;
        return .{ .response = response, .value = any };
    }
    pub fn encodeNativeProcess(self: Client, mailbox: Hash, relayer: []const u8, message: protocol.Message, metadata: []const u8) ![]u8 {
        if (message.destination != self.domain) return error.WrongMessageDestination;
        const id = try std.fmt.allocPrint(self.allocator, "0x{s}", .{std.fmt.bytesToHex(&mailbox, .lower)});
        defer self.allocator.free(id);
        const encoded = try message.encodeAlloc(self.allocator);
        defer self.allocator.free(encoded);
        const message_hex = try types.hex(self.allocator, encoded);
        defer self.allocator.free(message_hex);
        const metadata_hex = try types.hex(self.allocator, metadata);
        defer self.allocator.free(metadata_hex);
        return proto.nativeProcess(self.allocator, id, relayer, metadata_hex, message_hex);
    }
    pub fn encodeWasmProcess(self: Client, mailbox: Hash, relayer: []const u8, message: protocol.Message, metadata: []const u8) ![]u8 {
        if (message.destination != self.domain) return error.WrongMessageDestination;
        var address_buffer: [90]u8 = undefined;
        const address = try types.contractAddress(self.config.bech32_prefix, mailbox, self.config.contract_address_bytes, &address_buffer);
        const encoded = try message.encodeAlloc(self.allocator);
        defer self.allocator.free(encoded);
        const message_hex = try types.hex(self.allocator, encoded);
        defer self.allocator.free(message_hex);
        const metadata_hex = try types.hex(self.allocator, metadata);
        defer self.allocator.free(metadata_hex);
        const payload = try std.json.Stringify.valueAlloc(self.allocator, .{ .process = .{ .metadata = metadata_hex, .message = message_hex } }, .{});
        defer self.allocator.free(payload);
        return tx.executeContract(self.allocator, relayer, address, payload, &.{});
    }
};

pub fn nativeModuleType(any: proto.Any) !ModuleType {
    const prefix = "/hyperlane.core.interchain_security.v1.";
    if (std.mem.eql(u8, any.type_url, prefix ++ "MessageIdMultisigISM")) return .message_id_multisig;
    if (std.mem.eql(u8, any.type_url, prefix ++ "MerkleRootMultisigISM")) return .merkle_root_multisig;
    if (std.mem.eql(u8, any.type_url, prefix ++ "RoutingISM")) return .routing;
    if (std.mem.eql(u8, any.type_url, prefix ++ "NoopISM")) return .null_metadata;
    return error.UnsupportedNativeIsmType;
}
pub const Multisig = struct { validators: [256][20]u8, len: usize, threshold: u8 };
pub fn nativeMultisig(any: proto.Any) !Multisig {
    const typ = try nativeModuleType(any);
    if (typ != .message_id_multisig and typ != .merkle_root_multisig) return error.NotNativeMultisig;
    const threshold = try proto.uint32Field(any.value, 4);
    if (threshold == 0 or threshold > 255) return error.InvalidThreshold;
    var result: Multisig = .{ .validators = undefined, .len = 0, .threshold = @intCast(threshold) };
    var decoder: pb.Decoder = .{ .input = any.value };
    while (try decoder.next()) |field| if (field.number == 3) {
        if (field.value != .bytes or result.len == 256) return error.InvalidNativeValidators;
        const text = field.value.bytes;
        const hex = if (std.mem.startsWith(u8, text, "0x")) text[2..] else text;
        if (hex.len != 40) return error.InvalidNativeValidators;
        _ = try std.fmt.hexToBytes(&result.validators[result.len], hex);
        result.len += 1;
    };
    if (result.threshold > result.len) return error.InvalidThreshold;
    return result;
}
pub fn nativeRoute(any: proto.Any, origin: u32) !Hash {
    if (try nativeModuleType(any) != .routing) return error.NotNativeRoutingIsm;
    var result: ?Hash = null;
    var decoder: pb.Decoder = .{ .input = any.value };
    while (try decoder.next()) |field| if (field.number == 3) {
        if (field.value != .bytes) return error.WrongProtobufWireType;
        if (try proto.uint32Field(field.value.bytes, 2) != origin) continue;
        if (result != null) return error.DuplicateNativeRoute;
        result = try types.hash(try proto.textField(field.value.bytes, 1));
    };
    return result orelse error.MissingNativeRoute;
}

test "typed Cosmos clients compile with the injected gRPC transport" {
    std.testing.refAllDecls(Client);
}

test "Cosmos delivered historical queries retain and authenticate requested height" {
    const Mock = struct {
        mismatch: bool = false,
        fn call(context: *anyopaque, a: std.mem.Allocator, request: grpc.Request) !grpc.Response {
            const self: *@This() = @ptrCast(@alignCast(context));
            try std.testing.expectEqual(@as(?u64, 123), request.height);
            const bytes = if (std.mem.eql(u8, request.method, proto.paths.delivered)) try a.dupe(u8, &.{ 8, 1 }) else blk: {
                if (!std.mem.eql(u8, request.method, proto.paths.smart_query)) return error.UnexpectedMethod;
                const json = try proto.bytesField(request.protobuf, 2) orelse return error.MissingSmartQuery;
                if (std.mem.indexOf(u8, json, "message_delivered") == null) return error.WrongDeliveredQuery;
                break :blk try proto.queryString(a, "{\"delivered\":true}");
            };
            return .{ .allocator = a, .protobuf = bytes, .height = if (self.mismatch) 122 else 123 };
        }
    };
    var mock: Mock = .{};
    const client: Client = .{ .allocator = std.testing.allocator, .transport = .{ .context = &mock, .call_fn = Mock.call }, .domain = 2000, .config = .{ .chain_id = "fixture-1", .bech32_prefix = "cosmos", .canonical_asset = "uatom", .contract_address_bytes = 32, .gas_price = try @import("config.zig").Decimal.parse("0.025"), .gas_multiplier = 1.3, .confirmations = 2 } };
    try std.testing.expect(try client.nativeDeliveredAt(.{1} ** 32, .{2} ** 32, 123));
    try std.testing.expect(try client.wasmDeliveredAt(.{1} ** 32, .{2} ** 32, 123));
    mock.mismatch = true;
    try std.testing.expectError(error.GrpcQueryHeightMismatch, client.nativeDeliveredAt(.{1} ** 32, .{2} ** 32, 123));
    try std.testing.expectError(error.GrpcQueryHeightMismatch, client.wasmDeliveredAt(.{1} ** 32, .{2} ** 32, 123));
}

test "CosmWasm contract-info distinguishes NotFound from transport and validates recipient" {
    const Mock = struct {
        mode: enum { ok, missing, transport, wrong_address, malformed } = .ok,
        fn call(context: *anyopaque, a: std.mem.Allocator, request: grpc.Request) anyerror!grpc.Response {
            const self: *@This() = @ptrCast(@alignCast(context));
            if (self.mode == .missing) return error.GrpcNotFound;
            if (self.mode == .transport) return error.FixtureTransportFailure;
            try std.testing.expectEqualStrings(proto.paths.contract_info, request.method);
            const address = try proto.textField(request.protobuf, 1);
            var out: [256]u8 = undefined;
            var writer: pb.Encoder = .{ .out = &out };
            try writer.bytes(1, if (self.mode == .wrong_address) "cosmos1wrong" else address);
            try writer.bytes(2, if (self.mode == .malformed) &.{ 10, 1, 0 } else &.{ 8, 1 });
            return .{ .allocator = a, .protobuf = try a.dupe(u8, writer.written()) };
        }
    };
    var mock: Mock = .{};
    const client: Client = .{ .allocator = std.testing.allocator, .transport = .{ .context = &mock, .call_fn = Mock.call }, .domain = 2000, .config = .{ .chain_id = "fixture-1", .bech32_prefix = "cosmos", .canonical_asset = "uatom", .contract_address_bytes = 32, .gas_price = try @import("config.zig").Decimal.parse("0.025"), .gas_multiplier = 1.3, .confirmations = 2 } };
    try std.testing.expect(try client.wasmIsContract(.{1} ** 32));
    mock.mode = .missing;
    try std.testing.expect(!try client.wasmIsContract(.{1} ** 32));
    mock.mode = .transport;
    try std.testing.expectError(error.FixtureTransportFailure, client.wasmIsContract(.{1} ** 32));
    mock.mode = .wrong_address;
    try std.testing.expectError(error.CosmWasmContractInfoAddressMismatch, client.wasmIsContract(.{1} ** 32));
    mock.mode = .malformed;
    try std.testing.expectError(error.WrongProtobufWireType, client.wasmIsContract(.{1} ** 32));
}

test "Cosmos announcement historical absence authenticates height and never masks pinned failure" {
    const Mock = struct {
        fail: bool = false,
        mismatch: bool = false,
        fn call(context: *anyopaque, a: std.mem.Allocator, request: grpc.Request) !grpc.Response {
            const self: *@This() = @ptrCast(@alignCast(context));
            try std.testing.expectEqual(@as(?u64, 123), request.height);
            if (self.fail) return error.GrpcNotFound;
            const bytes = if (std.mem.eql(u8, request.method, proto.paths.validator_locations)) try a.alloc(u8, 0) else blk: {
                if (!std.mem.eql(u8, request.method, proto.paths.smart_query)) return error.UnexpectedMethod;
                break :blk try proto.queryString(a, "{\"storage_locations\":[[\"0101010101010101010101010101010101010101\",[]]]}");
            };
            return .{ .allocator = a, .protobuf = bytes, .height = if (self.mismatch) 122 else 123 };
        }
    };
    var mock: Mock = .{};
    const client: Client = .{ .allocator = std.testing.allocator, .transport = .{ .context = &mock, .call_fn = Mock.call }, .domain = 2000, .config = .{ .chain_id = "fixture-1", .bech32_prefix = "cosmos", .canonical_asset = "uatom", .contract_address_bytes = 32, .gas_price = try @import("config.zig").Decimal.parse("0.025"), .gas_multiplier = 1.3, .confirmations = 2 } };
    var native = try client.nativeLocationsAt(.{2} ** 32, &.{.{1} ** 20}, 123);
    defer native.deinit();
    try std.testing.expectEqual(@as(usize, 0), native.values[0].len);
    var wasm = try client.wasmLocationsAt(.{2} ** 32, &.{.{1} ** 20}, 123);
    defer wasm.deinit();
    try std.testing.expectEqual(@as(usize, 0), wasm.values[0].len);
    mock.mismatch = true;
    try std.testing.expectError(error.GrpcQueryHeightMismatch, client.nativeLocationsAt(.{2} ** 32, &.{.{1} ** 20}, 123));
    try std.testing.expectError(error.GrpcQueryHeightMismatch, client.wasmLocationsAt(.{2} ** 32, &.{.{1} ** 20}, 123));
    mock.fail = true;
    try std.testing.expectError(error.GrpcNotFound, client.nativeLocationsAt(.{2} ** 32, &.{.{1} ** 20}, 123));
}
