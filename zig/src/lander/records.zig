const std = @import("std");
const abi = @import("../evm/codecs.zig");
const types = @import("types.zig");

pub const OwnedJson = struct {
    arena: std.heap.ArenaAllocator,
    root: std.json.Value,

    pub fn init(parent_allocator: std.mem.Allocator) OwnedJson {
        return .{ .arena = std.heap.ArenaAllocator.init(parent_allocator), .root = .null };
    }

    pub fn deinit(self: *OwnedJson) void {
        self.arena.deinit();
        self.* = undefined;
    }

    pub fn allocator(self: *OwnedJson) std.mem.Allocator {
        return self.arena.allocator();
    }

    pub fn stringify(self: *OwnedJson, output_allocator: std.mem.Allocator) ![]u8 {
        return std.json.Stringify.valueAlloc(output_allocator, self.root, .{});
    }
};

pub const PayloadInput = struct {
    uuid: types.Uuid,
    metadata: []const u8,
    data_json: []const u8,
    gas_limit: u256 = 0,
    success_criteria_json: ?[]const u8 = null,
    to: types.Hash = @splat(0),
    value: ?u256 = null,
};

pub fn bytesValue(allocator: std.mem.Allocator, bytes: []const u8) !std.json.Value {
    const items = try allocator.alloc(std.json.Value, bytes.len);
    for (bytes, 0..) |byte, i| items[i] = .{ .integer = byte };
    return .{ .array = .{ .items = items, .capacity = items.len, .allocator = allocator } };
}

pub fn createPayload(owned: *OwnedJson, input: PayloadInput) !void {
    const allocator = owned.allocator();
    const data = try std.json.parseFromSliceLeaky(std.json.Value, allocator, input.data_json, .{ .duplicate_field_behavior = .@"error" });
    if (data != .array or data.array.items.len != 2) return error.InvalidEvmPayload;
    _ = try types.parseRequest(allocator, data.array.items[0]);
    if (input.success_criteria_json) |criteria| {
        const parsed = try std.json.parseFromSliceLeaky(std.json.Value, allocator, criteria, .{ .duplicate_field_behavior = .@"error" });
        if (parsed != .array or parsed.array.items.len != 2) return error.InvalidSuccessCriteria;
        _ = try types.parseRequest(allocator, parsed.array.items[0]);
    }
    var details = std.json.ObjectMap.init(allocator);
    try details.put("uuid", .{ .string = try types.uuidText(allocator, input.uuid) });
    try details.put("metadata", .{ .string = try allocator.dupe(u8, input.metadata) });
    try details.put("success_criteria", if (input.success_criteria_json) |criteria| try bytesValue(allocator, criteria) else .null);
    var root = std.json.ObjectMap.init(allocator);
    try root.put("details", .{ .object = details });
    try root.put("data", try bytesValue(allocator, input.data_json));
    try root.put("gas_limit", .{ .string = try types.quantity(allocator, input.gas_limit) });
    try root.put("to", .{ .string = try abi.hexAlloc(allocator, &input.to) });
    try root.put("status", .{ .string = "ReadyToSubmit" });
    try root.put("value", if (input.value) |value| .{ .string = try types.quantity(allocator, value) } else .null);
    try root.put("inclusion_soft_deadline", .null);
    owned.root = .{ .object = root };
}

pub fn payloadUuid(value: std.json.Value) !types.Uuid {
    const details = try types.field(value, "details");
    return types.parseUuid(try types.stringField(details, "uuid"));
}

pub fn createTransaction(owned: *OwnedJson, payload: std.json.Value, uuid: types.Uuid, signer: types.Address, chain_id: u256, timestamp_text: []const u8) !void {
    const allocator = owned.allocator();
    const data_bytes = try types.field(payload, "data");
    if (data_bytes != .array) return error.InvalidEvmPayload;
    const bytes = try allocator.alloc(u8, data_bytes.array.items.len);
    for (data_bytes.array.items, 0..) |byte, i| {
        if (byte != .integer or byte.integer < 0 or byte.integer > 255) return error.InvalidEvmPayload;
        bytes[i] = @intCast(byte.integer);
    }
    const data = try std.json.parseFromSliceLeaky(std.json.Value, allocator, bytes, .{ .duplicate_field_behavior = .@"error" });
    if (data != .array or data.array.items.len != 2) return error.InvalidEvmPayload;
    var tx = data.array.items[0];
    try types.setFrom(allocator, &tx, signer);
    if (types.optionalField(tx, "chainId")) |actual| {
        if (actual != .null and try types.uintField(tx, "chainId") != chain_id) return error.WrongChain;
    }
    if (tx == .object) try tx.object.put("chainId", .{ .string = try types.quantity(allocator, chain_id) });
    const floor = (try types.optionalUint(payload, "gas_limit")) orelse 0;
    if (floor != 0) {
        const gas = (try types.optionalUint(tx, "gas")) orelse 0;
        if (tx == .object) try tx.object.put("gas", .{ .string = try types.quantity(allocator, @max(floor, gas)) });
    }
    var precursor = std.json.ObjectMap.init(allocator);
    try precursor.put("tx", tx);
    try precursor.put("function", data.array.items[1]);
    var evm = std.json.ObjectMap.init(allocator);
    try evm.put("Evm", .{ .object = precursor });
    const details = try types.field(payload, "details");
    const details_items = try allocator.alloc(std.json.Value, 1);
    details_items[0] = details;
    const hash_items = try allocator.alloc(std.json.Value, 0);
    var root = std.json.ObjectMap.init(allocator);
    try root.put("uuid", .{ .string = try types.uuidText(allocator, uuid) });
    try root.put("tx_hashes", .{ .array = .{ .items = hash_items, .capacity = 0, .allocator = allocator } });
    try root.put("vm_specific_data", .{ .object = evm });
    try root.put("payload_details", .{ .array = .{ .items = details_items, .capacity = 1, .allocator = allocator } });
    try root.put("status", .{ .string = "PendingInclusion" });
    try root.put("submission_attempts", .{ .integer = 0 });
    try root.put("creation_timestamp", .{ .string = timestamp_text });
    try root.put("last_submission_attempt", .null);
    try root.put("last_status_check", .null);
    owned.root = .{ .object = root };
}

pub fn createBatchTransaction(owned: *OwnedJson, payloads: []const std.json.Value, uuid: types.Uuid, signer: types.Address, chain_id: u256, timestamp_text: []const u8, batch_address: types.Address, calldata: []const u8, value: u256) !void {
    if (payloads.len < 2) return error.InvalidBatch;
    try createTransaction(owned, payloads[0], uuid, signer, chain_id, timestamp_text);
    const allocator = owned.allocator();
    const details = try allocator.alloc(std.json.Value, payloads.len);
    for (payloads, 0..) |payload, i| details[i] = try types.field(payload, "details");
    try owned.root.object.put("payload_details", .{ .array = .{ .items = details, .capacity = details.len, .allocator = allocator } });
    const tx = try types.requestPtr(&owned.root);
    try tx.object.put("to", .{ .string = try abi.hexAlloc(allocator, &batch_address) });
    try tx.object.put("data", .{ .string = try abi.hexAlloc(allocator, calldata) });
    try tx.object.put("value", .{ .string = try types.quantity(allocator, value) });
    try tx.object.put("gas", .null);
    try tx.object.put("nonce", .null);
    const evm = owned.root.object.getPtr("vm_specific_data").?.object.getPtr("Evm").?;
    var function = std.json.ObjectMap.init(allocator);
    try function.put("name", .{ .string = if (value == 0) "aggregate3" else "aggregate3Value" });
    try function.put("inputs", .{ .array = .{ .items = try allocator.alloc(std.json.Value, 0), .capacity = 0, .allocator = allocator } });
    try function.put("outputs", .{ .array = .{ .items = try allocator.alloc(std.json.Value, 0), .capacity = 0, .allocator = allocator } });
    try function.put("constant", .null);
    try function.put("stateMutability", .{ .string = "nonpayable" });
    try evm.object.put("function", .{ .object = function });
}

pub fn transactionUuid(value: std.json.Value) !types.Uuid {
    return types.parseUuid(try types.stringField(value, "uuid"));
}

pub fn status(value: std.json.Value) !types.Status {
    return types.statusFromJson(try types.field(value, "status"));
}

pub fn setStatus(value: *std.json.Value, allocator: std.mem.Allocator, new_status: types.Status) !void {
    if (value.* != .object) return error.InvalidLanderRecord;
    try value.object.put("status", try types.statusJson(allocator, new_status));
}

pub fn setPayloadStatus(value: *std.json.Value, allocator: std.mem.Allocator, new_status: types.Status) !void {
    if (value.* != .object) return error.InvalidLanderRecord;
    try value.object.put("status", try types.payloadStatusJson(allocator, new_status));
}

pub fn setPayloadReverted(value: *std.json.Value, allocator: std.mem.Allocator) !void {
    if (value.* != .object) return error.InvalidLanderRecord;
    var dropped = std.json.ObjectMap.init(allocator);
    try dropped.put("Dropped", .{ .string = "Reverted" });
    try value.object.put("status", .{ .object = dropped });
}

pub fn setPayloadSimulationFailed(value: *std.json.Value, allocator: std.mem.Allocator) !void {
    if (value.* != .object) return error.InvalidLanderRecord;
    var dropped = std.json.ObjectMap.init(allocator);
    try dropped.put("Dropped", .{ .string = "FailedSimulation" });
    try value.object.put("status", .{ .object = dropped });
}

pub fn payloadTransactionUuids(allocator: std.mem.Allocator, value: std.json.Value) ![]types.Uuid {
    const details = try types.field(value, "payload_details");
    if (details != .array) return error.InvalidLanderRecord;
    const uuids = try allocator.alloc(types.Uuid, details.array.items.len);
    errdefer allocator.free(uuids);
    for (details.array.items, 0..) |detail, i| uuids[i] = try types.parseUuid(try types.stringField(detail, "uuid"));
    return uuids;
}

pub fn hashes(allocator: std.mem.Allocator, value: std.json.Value) ![]types.Hash {
    const raw = try types.field(value, "tx_hashes");
    if (raw != .array) return error.InvalidLanderRecord;
    const result = try allocator.alloc(types.Hash, raw.array.items.len);
    errdefer allocator.free(result);
    for (raw.array.items, 0..) |hash, i| {
        if (hash != .string) return error.InvalidLanderRecord;
        result[i] = try types.parseHash(hash.string);
    }
    return result;
}

pub fn appendHash(value: *std.json.Value, allocator: std.mem.Allocator, hash: types.Hash) !bool {
    if (value.* != .object) return error.InvalidLanderRecord;
    const raw = value.object.getPtr("tx_hashes") orelse return error.InvalidLanderRecord;
    if (raw.* != .array) return error.InvalidLanderRecord;
    const text = try types.wideHashText(allocator, hash);
    for (raw.array.items) |existing| if (existing == .string and std.mem.eql(u8, existing.string, text)) return false;
    const items = try allocator.alloc(std.json.Value, raw.array.items.len + 1);
    @memcpy(items[0..raw.array.items.len], raw.array.items);
    items[raw.array.items.len] = .{ .string = text };
    raw.* = .{ .array = .{ .items = items, .capacity = items.len, .allocator = allocator } };
    return true;
}

pub fn incrementAttempts(value: *std.json.Value) !void {
    const attempts = try types.uintField(value.*, "submission_attempts");
    if (attempts >= std.math.maxInt(u32)) return error.SubmissionAttemptsExhausted;
    try value.object.put("submission_attempts", .{ .integer = @intCast(attempts + 1) });
}

pub fn setTimestamp(value: *std.json.Value, name: []const u8, timestamp_text: []const u8) !void {
    if (value.* != .object) return error.InvalidLanderRecord;
    try value.object.put(name, .{ .string = timestamp_text });
}

pub fn timestamp(allocator: std.mem.Allocator, now_ms: u64) ![]const u8 {
    const seconds = std.time.epoch.EpochSeconds{ .secs = now_ms / 1000 };
    const year_day = seconds.getEpochDay().calculateYearDay();
    const month_day = year_day.calculateMonthDay();
    const day = seconds.getDaySeconds();
    return std.fmt.allocPrint(allocator, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z", .{
        year_day.year,
        month_day.month.numeric(),
        month_day.day_index + 1,
        day.getHoursIntoDay(),
        day.getMinutesIntoHour(),
        day.getSecondsIntoMinute(),
        now_ms % 1000,
    });
}

pub fn samePayloadIdentity(allocator: std.mem.Allocator, existing: std.json.Value, replacement: std.json.Value) !bool {
    if (((try types.optionalUint(existing, "gas_limit")) orelse 0) != ((try types.optionalUint(replacement, "gas_limit")) orelse 0)) return false;
    const existing_details = try types.field(existing, "details");
    const replacement_details = try types.field(replacement, "details");
    if (!std.mem.eql(u8, try types.stringField(existing_details, "uuid"), try types.stringField(replacement_details, "uuid"))) return false;
    if (!std.mem.eql(u8, try types.stringField(existing_details, "metadata"), try types.stringField(replacement_details, "metadata"))) return false;
    const existing_criteria = try std.json.Stringify.valueAlloc(allocator, types.optionalField(existing_details, "success_criteria") orelse .null, .{});
    defer allocator.free(existing_criteria);
    const replacement_criteria = try std.json.Stringify.valueAlloc(allocator, types.optionalField(replacement_details, "success_criteria") orelse .null, .{});
    defer allocator.free(replacement_criteria);
    if (!std.mem.eql(u8, existing_criteria, replacement_criteria)) return false;
    const names = [_][]const u8{ "data", "to", "value", "inclusion_soft_deadline" };
    for (names) |name| {
        const left = try std.json.Stringify.valueAlloc(allocator, try types.field(existing, name), .{});
        defer allocator.free(left);
        const right = try std.json.Stringify.valueAlloc(allocator, try types.field(replacement, name), .{});
        defer allocator.free(right);
        if (!std.mem.eql(u8, left, right)) return false;
    }
    return true;
}

test "canonical payload and transaction records retain EVM JSON" {
    var payload: OwnedJson = .init(std.testing.allocator);
    defer payload.deinit();
    const data = "[{\"type\":\"0x02\",\"from\":null,\"to\":\"0x3535353535353535353535353535353535353535\",\"gas\":\"0x5208\",\"value\":\"0x0\",\"data\":\"0x\",\"nonce\":null,\"chainId\":\"0x1\",\"maxFeePerGas\":\"0x2\",\"maxPriorityFeePerGas\":\"0x1\",\"accessList\":[]},{\"name\":\"process\",\"inputs\":[],\"outputs\":[],\"constant\":null,\"stateMutability\":\"nonpayable\"}]";
    try createPayload(&payload, .{ .uuid = @splat(1), .metadata = "message", .data_json = data, .to = @splat(2) });
    var transaction: OwnedJson = .init(std.testing.allocator);
    defer transaction.deinit();
    try createTransaction(&transaction, payload.root, @splat(3), @splat(4), 1, "2026-01-02T03:04:05.006Z");
    const tx_hashes = try hashes(std.testing.allocator, transaction.root);
    defer std.testing.allocator.free(tx_hashes);
    try std.testing.expectEqual(@as(usize, 0), tx_hashes.len);
}
