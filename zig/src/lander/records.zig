const std = @import("std");
const abi = @import("../evm/codecs.zig");
const types = @import("types.zig");
const json_view = @import("json_view.zig");

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

/// The checks `createPayload` applies to its input, without building the
/// record: both JSON tuples must decode to an EVM request.
pub fn validatePayload(scratch: std.mem.Allocator, input: PayloadInput) !void {
    var arena = std.heap.ArenaAllocator.init(scratch);
    defer arena.deinit();
    const allocator = arena.allocator();
    const data = try std.json.parseFromSliceLeaky(std.json.Value, allocator, input.data_json, .{ .duplicate_field_behavior = .@"error" });
    if (data != .array or data.array.items.len != 2) return error.InvalidEvmPayload;
    _ = try types.parseRequest(allocator, data.array.items[0]);
    if (input.success_criteria_json) |criteria| {
        const parsed = try std.json.parseFromSliceLeaky(std.json.Value, allocator, criteria, .{ .duplicate_field_behavior = .@"error" });
        if (parsed != .array or parsed.array.items.len != 2) return error.InvalidSuccessCriteria;
        _ = try types.parseRequest(allocator, parsed.array.items[0]);
    }
}

/// The canonical payload row `createPayload` + stringify produce, written
/// directly (no per-byte JSON values). Validates the input first.
pub fn payloadJson(allocator: std.mem.Allocator, input: PayloadInput) ![]u8 {
    try validatePayload(allocator, input);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    const uuid_text = try types.uuidText(allocator, input.uuid);
    defer allocator.free(uuid_text);
    try out.appendSlice(allocator, "{\"details\":{\"uuid\":\"");
    try out.appendSlice(allocator, uuid_text);
    try out.appendSlice(allocator, "\",\"metadata\":");
    const metadata = try std.json.Stringify.valueAlloc(allocator, input.metadata, .{});
    defer allocator.free(metadata);
    try out.appendSlice(allocator, metadata);
    try out.appendSlice(allocator, ",\"success_criteria\":");
    if (input.success_criteria_json) |criteria| try json_view.writeByteArray(&out, allocator, criteria) else try out.appendSlice(allocator, "null");
    try out.appendSlice(allocator, "},\"data\":");
    try json_view.writeByteArray(&out, allocator, input.data_json);
    try out.print(allocator, ",\"gas_limit\":\"0x{x}\",\"to\":\"0x{s}\",\"status\":\"ReadyToSubmit\",\"value\":", .{ input.gas_limit, &std.fmt.bytesToHex(input.to, .lower) });
    if (input.value) |value| try out.print(allocator, "\"0x{x}\"", .{value}) else try out.appendSlice(allocator, "null");
    try out.appendSlice(allocator, ",\"inclusion_soft_deadline\":null}");
    return out.toOwnedSlice(allocator);
}

/// Borrowed view of a stored payload row. Fields are raw JSON value slices of
/// `json`; the per-byte `data` and `success_criteria` arrays are decoded on
/// demand straight to bytes. Rewrites splice only the status value.
pub const PayloadView = struct {
    json: []const u8,
    details: []const u8,
    data: []const u8,
    gas_limit: ?[]const u8,
    to: ?[]const u8,
    status: []const u8,
    value: ?[]const u8,
    inclusion_soft_deadline: ?[]const u8,
    uuid_raw: []const u8,
    metadata: []const u8,
    success_criteria: ?[]const u8,

    pub fn parse(scratch: std.mem.Allocator, json: []const u8) !PayloadView {
        const top = try json_view.fields(7, scratch, json, .{ "details", "data", "gas_limit", "to", "status", "value", "inclusion_soft_deadline" });
        const details = top[0] orelse return error.InvalidLanderRecord;
        const inner = try json_view.fields(3, scratch, details, .{ "uuid", "metadata", "success_criteria" });
        return .{
            .json = json,
            .details = details,
            .data = top[1] orelse return error.InvalidLanderRecord,
            .gas_limit = top[2],
            .to = top[3],
            .status = top[4] orelse return error.InvalidLanderRecord,
            .value = top[5],
            .inclusion_soft_deadline = top[6],
            .uuid_raw = inner[0] orelse return error.InvalidLanderRecord,
            .metadata = inner[1] orelse return error.InvalidLanderRecord,
            .success_criteria = inner[2],
        };
    }

    pub fn uuid(self: PayloadView, scratch: std.mem.Allocator) !types.Uuid {
        return types.parseUuid(try json_view.string(scratch, self.uuid_raw));
    }

    /// `gas_limit` as `optionalUint` reads it (absent or null: 0).
    pub fn gasLimit(self: PayloadView, scratch: std.mem.Allocator) !u256 {
        const raw = self.gas_limit orelse return 0;
        return (try types.uintOf(try json_view.parseValue(scratch, raw))) orelse 0;
    }

    pub fn toText(self: PayloadView, scratch: std.mem.Allocator) ![]const u8 {
        return json_view.string(scratch, self.to orelse return error.InvalidLanderRecord);
    }

    pub fn dataBytes(self: PayloadView, allocator: std.mem.Allocator) ![]u8 {
        return json_view.byteArray(allocator, self.data);
    }

    /// Null when absent or JSON null.
    pub fn successCriteriaBytes(self: PayloadView, allocator: std.mem.Allocator) !?[]u8 {
        const raw = self.success_criteria orelse return null;
        if (std.mem.eql(u8, raw, "null")) return null;
        return try json_view.byteArray(allocator, raw);
    }

    pub fn statusValue(self: PayloadView, scratch: std.mem.Allocator) !std.json.Value {
        return json_view.parseValue(scratch, self.status);
    }

    /// The row with its status value replaced by `status_json`.
    pub fn withStatus(self: PayloadView, allocator: std.mem.Allocator, status_json: []const u8) ![]u8 {
        return json_view.splice(allocator, self.json, self.status, status_json);
    }

    /// The EVM request tuple stored in `data`.
    pub fn dataTuple(self: PayloadView, allocator: std.mem.Allocator) !std.json.Value {
        const bytes = try self.dataBytes(allocator);
        const tuple = try std.json.parseFromSliceLeaky(std.json.Value, allocator, bytes, .{});
        if (tuple != .array or tuple.array.items.len != 2) return error.InvalidEvmPayload;
        return tuple;
    }
};

/// Compact JSON text of a payload's `InTransaction` status.
pub fn payloadStatusText(allocator: std.mem.Allocator, new_status: types.Status) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    return std.json.Stringify.valueAlloc(allocator, try types.payloadStatusJson(arena.allocator(), new_status), .{});
}

pub const payload_reverted_status = "{\"Dropped\":\"Reverted\"}";
pub const payload_simulation_failed_status = "{\"Dropped\":\"FailedSimulation\"}";

pub fn payloadUuid(value: std.json.Value) !types.Uuid {
    const details = try types.field(value, "details");
    return types.parseUuid(try types.stringField(details, "uuid"));
}

/// A validated raw JSON value (borrowed) that Stringify writes verbatim:
/// payload details carry per-byte `success_criteria` arrays that would
/// otherwise be decoded into one Value per byte only to be re-encoded.
/// Never read back as a tree; the stored row is reparsed when needed.
fn rawValue(raw: []const u8) std.json.Value {
    return .{ .number_string = raw };
}

pub fn createTransaction(owned: *OwnedJson, payload: PayloadView, uuid: types.Uuid, signer: types.Address, chain_id: u256, timestamp_text: []const u8) !void {
    owned.root = try transactionValue(owned.allocator(), payload, uuid, signer, chain_id, timestamp_text);
}

/// The new transaction row of `payload`. Every value lives in `allocator`
/// except `payload_details`, which borrow the payload's raw spans (see
/// `ownDetails`).
pub fn transactionValue(allocator: std.mem.Allocator, payload: PayloadView, uuid: types.Uuid, signer: types.Address, chain_id: u256, timestamp_text: []const u8) !std.json.Value {
    const bytes = json_view.byteArray(allocator, payload.data) catch return error.InvalidEvmPayload;
    const data = try std.json.parseFromSliceLeaky(std.json.Value, allocator, bytes, .{ .duplicate_field_behavior = .@"error" });
    if (data != .array or data.array.items.len != 2) return error.InvalidEvmPayload;
    var tx = data.array.items[0];
    try types.setFrom(allocator, &tx, signer);
    if (types.optionalField(tx, "chainId")) |actual| {
        if (actual != .null and try types.uintField(tx, "chainId") != chain_id) return error.WrongChain;
    }
    if (tx == .object) try tx.object.put("chainId", .{ .string = try types.quantity(allocator, chain_id) });
    const floor = try payload.gasLimit(allocator);
    if (floor != 0) {
        const gas = (try types.optionalUint(tx, "gas")) orelse 0;
        if (tx == .object) try tx.object.put("gas", .{ .string = try types.quantity(allocator, @max(floor, gas)) });
    }
    var precursor = std.json.ObjectMap.init(allocator);
    try precursor.put("tx", tx);
    try precursor.put("function", data.array.items[1]);
    var evm = std.json.ObjectMap.init(allocator);
    try evm.put("Evm", .{ .object = precursor });
    const details_items = try allocator.alloc(std.json.Value, 1);
    details_items[0] = rawValue(payload.details);
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
    return .{ .object = root };
}

pub fn createBatchTransaction(owned: *OwnedJson, payloads: []const PayloadView, uuid: types.Uuid, signer: types.Address, chain_id: u256, timestamp_text: []const u8, batch_address: types.Address, calldata: []const u8, value: u256) !void {
    owned.root = try batchTransactionValue(owned.allocator(), payloads, uuid, signer, chain_id, timestamp_text, batch_address, calldata, value);
}

pub fn batchTransactionValue(allocator: std.mem.Allocator, payloads: []const PayloadView, uuid: types.Uuid, signer: types.Address, chain_id: u256, timestamp_text: []const u8, batch_address: types.Address, calldata: []const u8, value: u256) !std.json.Value {
    if (payloads.len < 2) return error.InvalidBatch;
    var root = try transactionValue(allocator, payloads[0], uuid, signer, chain_id, timestamp_text);
    const details = try allocator.alloc(std.json.Value, payloads.len);
    for (payloads, 0..) |payload, i| details[i] = rawValue(payload.details);
    try root.object.put("payload_details", .{ .array = .{ .items = details, .capacity = details.len, .allocator = allocator } });
    const tx = try types.requestPtr(&root);
    try tx.object.put("to", .{ .string = try abi.hexAlloc(allocator, &batch_address) });
    try tx.object.put("data", .{ .string = try abi.hexAlloc(allocator, calldata) });
    try tx.object.put("value", .{ .string = try types.quantity(allocator, value) });
    try tx.object.put("gas", .null);
    try tx.object.put("nonce", .null);
    const evm = root.object.getPtr("vm_specific_data").?.object.getPtr("Evm").?;
    var function = std.json.ObjectMap.init(allocator);
    try function.put("name", .{ .string = if (value == 0) "aggregate3" else "aggregate3Value" });
    try function.put("inputs", .{ .array = .{ .items = try allocator.alloc(std.json.Value, 0), .capacity = 0, .allocator = allocator } });
    try function.put("outputs", .{ .array = .{ .items = try allocator.alloc(std.json.Value, 0), .capacity = 0, .allocator = allocator } });
    try function.put("constant", .null);
    try function.put("stateMutability", .{ .string = "nonpayable" });
    try evm.object.put("function", .{ .object = function });
    return root;
}

/// Replaces the borrowed raw `payload_details` spans of a new transaction
/// row with their decoded values (allocated in `allocator`): the row a
/// reader decodes from the bytes the raw spans were written as.
pub fn ownDetails(value: *std.json.Value, allocator: std.mem.Allocator) !void {
    if (value.* != .object) return error.InvalidLanderRecord;
    const details = value.object.getPtr("payload_details") orelse return error.InvalidLanderRecord;
    if (details.* != .array) return error.InvalidLanderRecord;
    const decoded = try allocator.alloc(std.json.Value, details.array.items.len);
    for (details.array.items, decoded) |item, *out| {
        out.* = if (item == .number_string) try std.json.parseFromSliceLeaky(std.json.Value, allocator, item.number_string, .{ .duplicate_field_behavior = .@"error", .allocate = .alloc_always }) else item;
    }
    details.* = .{ .array = .{ .items = decoded, .capacity = decoded.len, .allocator = allocator } };
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

/// Same identity as a re-enqueued payload: compared field by field after
/// decoding, so equal values written with different JSON spacing match.
pub fn samePayloadIdentity(scratch: std.mem.Allocator, existing: PayloadView, replacement: PayloadView) !bool {
    var arena = std.heap.ArenaAllocator.init(scratch);
    defer arena.deinit();
    const allocator = arena.allocator();
    if (try existing.gasLimit(allocator) != try replacement.gasLimit(allocator)) return false;
    if (!std.mem.eql(u8, try json_view.string(allocator, existing.uuid_raw), try json_view.string(allocator, replacement.uuid_raw))) return false;
    if (!std.mem.eql(u8, try json_view.string(allocator, existing.metadata), try json_view.string(allocator, replacement.metadata))) return false;
    if (!try sameCanonical(allocator, existing.success_criteria orelse "null", replacement.success_criteria orelse "null")) return false;
    if (!try sameCanonical(allocator, existing.data, replacement.data)) return false;
    const pairs = [_][2]?[]const u8{ .{ existing.to, replacement.to }, .{ existing.value, replacement.value }, .{ existing.inclusion_soft_deadline, replacement.inclusion_soft_deadline } };
    for (pairs) |pair| {
        const left = pair[0] orelse return error.InvalidLanderRecord;
        const right = pair[1] orelse return error.InvalidLanderRecord;
        if (!try sameCanonical(allocator, left, right)) return false;
    }
    return true;
}

/// Equal raw values, or equal after re-encoding (byte arrays compare decoded).
fn sameCanonical(allocator: std.mem.Allocator, left: []const u8, right: []const u8) !bool {
    if (std.mem.eql(u8, left, right)) return true;
    if (left.len > 0 and left[0] == '[' and right.len > 0 and right[0] == '[') {
        const a = json_view.byteArray(allocator, left) catch null;
        const b = json_view.byteArray(allocator, right) catch null;
        if (a != null and b != null) return std.mem.eql(u8, a.?, b.?);
    }
    const a = try std.json.Stringify.valueAlloc(allocator, try json_view.parseValue(allocator, left), .{});
    const b = try std.json.Stringify.valueAlloc(allocator, try json_view.parseValue(allocator, right), .{});
    return std.mem.eql(u8, a, b);
}

test "canonical payload and transaction records retain EVM JSON" {
    const a = std.testing.allocator;
    const data = "[{\"type\":\"0x02\",\"from\":null,\"to\":\"0x3535353535353535353535353535353535353535\",\"gas\":\"0x5208\",\"value\":\"0x0\",\"data\":\"0x\",\"nonce\":null,\"chainId\":\"0x1\",\"maxFeePerGas\":\"0x2\",\"maxPriorityFeePerGas\":\"0x1\",\"accessList\":[]},{\"name\":\"process\",\"inputs\":[],\"outputs\":[],\"constant\":null,\"stateMutability\":\"nonpayable\"}]";
    const inputs = [_]PayloadInput{
        .{ .uuid = @splat(1), .metadata = "message", .data_json = data, .to = @splat(2) },
        .{ .uuid = @splat(0xab), .metadata = "q\"\\\u{7f}\u{e9}\n", .data_json = data, .gas_limit = 77777, .success_criteria_json = data, .to = @splat(0xfe), .value = 1 << 200 },
    };
    for (inputs) |input| {
        var payload: OwnedJson = .init(a);
        defer payload.deinit();
        try createPayload(&payload, input);
        const reference = try payload.stringify(a);
        defer a.free(reference);
        const direct = try payloadJson(a, input);
        defer a.free(direct);
        try std.testing.expectEqualStrings(reference, direct);
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const view = try PayloadView.parse(arena.allocator(), direct);
        try std.testing.expectEqual(input.uuid, try view.uuid(arena.allocator()));
        try std.testing.expectEqual(input.gas_limit, try view.gasLimit(arena.allocator()));
        try std.testing.expectEqualStrings(input.data_json, try view.dataBytes(arena.allocator()));
        if (input.success_criteria_json) |criteria| try std.testing.expectEqualStrings(criteria, (try view.successCriteriaBytes(arena.allocator())).?) else try std.testing.expect(try view.successCriteriaBytes(arena.allocator()) == null);
        try std.testing.expect(try samePayloadIdentity(a, view, view));
        // Status splice equals the parse/set/stringify rewrite.
        for ([_]types.Status{ .pending_inclusion, .included, .finalized, .{ .dropped = .{ .other = "x" } } }) |next_status| {
            try setPayloadStatus(&payload.root, payload.allocator(), next_status);
            const expected = try payload.stringify(a);
            defer a.free(expected);
            const text = try payloadStatusText(a, next_status);
            defer a.free(text);
            const spliced = try view.withStatus(a, text);
            defer a.free(spliced);
            try std.testing.expectEqualStrings(expected, spliced);
        }
        try setPayloadReverted(&payload.root, payload.allocator());
        const reverted = try payload.stringify(a);
        defer a.free(reverted);
        const spliced = try view.withStatus(a, payload_reverted_status);
        defer a.free(spliced);
        try std.testing.expectEqualStrings(reverted, spliced);
        var transaction: OwnedJson = .init(a);
        defer transaction.deinit();
        try createTransaction(&transaction, view, @splat(3), @splat(4), 1, "2026-01-02T03:04:05.006Z");
        const tx_hashes = try hashes(a, transaction.root);
        defer a.free(tx_hashes);
        try std.testing.expectEqual(@as(usize, 0), tx_hashes.len);
    }
}
