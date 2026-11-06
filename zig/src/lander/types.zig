const std = @import("std");
const abi = @import("../evm/codecs.zig");
const transaction = @import("../evm/transaction.zig");
const eip2930 = @import("../evm/eip2930.zig");

pub const Uuid = [16]u8;
pub const Hash = [32]u8;
pub const Address = [20]u8;
pub const Signature = transaction.Signature;
pub const Request = union(enum) {
    legacy: transaction.Legacy,
    eip2930: eip2930.Eip2930,
    eip1559: transaction.DynamicFee,

    pub fn validate(self: Request) !void {
        return switch (self) {
            .legacy => |tx| (transaction.Transaction{ .legacy = tx }).validate(),
            .eip2930 => |tx| tx.validate(),
            .eip1559 => |tx| (transaction.Transaction{ .eip1559 = tx }).validate(),
        };
    }

    pub fn nextNonce(self: Request) !u256 {
        return std.math.add(u256, switch (self) {
            .legacy => |tx| tx.nonce,
            .eip2930 => |tx| tx.nonce,
            .eip1559 => |tx| tx.nonce,
        }, 1);
    }

    pub fn maxCost(self: Request) !u256 {
        return switch (self) {
            .legacy => |tx| (transaction.Transaction{ .legacy = tx }).maxCost(),
            .eip2930 => |tx| std.math.add(u256, try std.math.mul(u256, tx.gas_limit, tx.gas_price), tx.value),
            .eip1559 => |tx| (transaction.Transaction{ .eip1559 = tx }).maxCost(),
        };
    }

    pub fn unsigned(self: Request, allocator: std.mem.Allocator) ![]u8 {
        return switch (self) {
            .legacy => |tx| (transaction.Transaction{ .legacy = tx }).unsigned(allocator),
            .eip2930 => |tx| tx.unsigned(allocator),
            .eip1559 => |tx| (transaction.Transaction{ .eip1559 = tx }).unsigned(allocator),
        };
    }

    pub fn signingHash(self: Request, allocator: std.mem.Allocator) !Hash {
        return switch (self) {
            .legacy => |tx| (transaction.Transaction{ .legacy = tx }).signingHash(allocator),
            .eip2930 => |tx| tx.signingHash(allocator),
            .eip1559 => |tx| (transaction.Transaction{ .eip1559 = tx }).signingHash(allocator),
        };
    }

    pub fn recoverSigner(self: Request, allocator: std.mem.Allocator, signature: Signature) !Address {
        return switch (self) {
            .legacy => |tx| (transaction.Transaction{ .legacy = tx }).recoverSigner(allocator, signature),
            .eip2930 => |tx| tx.recoverSigner(allocator, signature),
            .eip1559 => |tx| (transaction.Transaction{ .eip1559 = tx }).recoverSigner(allocator, signature),
        };
    }

    pub fn encodeSigned(self: Request, allocator: std.mem.Allocator, signature: Signature) ![]u8 {
        return switch (self) {
            .legacy => |tx| (transaction.Transaction{ .legacy = tx }).encodeSigned(allocator, signature),
            .eip2930 => |tx| tx.encodeSigned(allocator, signature),
            .eip1559 => |tx| (transaction.Transaction{ .eip1559 = tx }).encodeSigned(allocator, signature),
        };
    }
};
pub const nil_uuid: Uuid = @splat(0);

pub const Status = union(enum) {
    pending_inclusion,
    mempool,
    included,
    finalized,
    dropped: DropReason,

    pub const DropReason = union(enum) {
        dropped_by_chain,
        failed_simulation,
        other: []const u8,
    };

    pub fn rank(self: Status) u8 {
        return switch (self) {
            .dropped => 0,
            .pending_inclusion => 1,
            .mempool => 2,
            .included => 3,
            .finalized => 4,
        };
    }

    pub fn isActive(self: Status) bool {
        return self != .dropped and self != .finalized;
    }
};

pub fn classify(statuses: []const ?Status) Status {
    var best: ?Status = null;
    var saw_dropped = false;
    for (statuses) |maybe| {
        const status = maybe orelse continue;
        if (status == .finalized) return .finalized;
        if (status == .dropped) {
            saw_dropped = true;
            continue;
        }
        if (best == null or status.rank() > best.?.rank()) best = status;
    }
    if (best) |status| return status;
    return if (saw_dropped) .{ .dropped = .dropped_by_chain } else .pending_inclusion;
}

pub fn parseUuid(text: []const u8) !Uuid {
    if (text.len != 36 or text[8] != '-' or text[13] != '-' or text[18] != '-' or text[23] != '-') return error.InvalidUuid;
    var compact: [32]u8 = undefined;
    var positions: usize = 0;
    for (text, 0..) |byte, i| {
        if (i == 8 or i == 13 or i == 18 or i == 23) continue;
        if (!std.ascii.isHex(byte)) return error.InvalidUuid;
        compact[positions] = byte;
        positions += 1;
    }
    var out: Uuid = undefined;
    _ = std.fmt.hexToBytes(&out, &compact) catch return error.InvalidUuid;
    return out;
}

pub fn uuidText(allocator: std.mem.Allocator, uuid: Uuid) ![]u8 {
    var hex: [32]u8 = undefined;
    const digits = "0123456789abcdef";
    for (uuid, 0..) |byte, i| {
        hex[i * 2] = digits[byte >> 4];
        hex[i * 2 + 1] = digits[byte & 15];
    }
    return std.fmt.allocPrint(allocator, "{s}-{s}-{s}-{s}-{s}", .{ hex[0..8], hex[8..12], hex[12..16], hex[16..20], hex[20..32] });
}

pub fn newUuid() Uuid {
    var uuid: Uuid = undefined;
    std.crypto.random.bytes(&uuid);
    uuid[6] = (uuid[6] & 0x0f) | 0x40;
    uuid[8] = (uuid[8] & 0x3f) | 0x80;
    return uuid;
}

pub fn field(value: std.json.Value, name: []const u8) !std.json.Value {
    if (value != .object) return error.InvalidLanderRecord;
    return value.object.get(name) orelse error.InvalidLanderRecord;
}

pub fn optionalField(value: std.json.Value, name: []const u8) ?std.json.Value {
    if (value != .object) return null;
    return value.object.get(name);
}

pub fn stringField(value: std.json.Value, name: []const u8) ![]const u8 {
    const actual = try field(value, name);
    if (actual != .string) return error.InvalidLanderRecord;
    return actual.string;
}

pub fn uintField(value: std.json.Value, name: []const u8) !u256 {
    const actual = try field(value, name);
    if (actual == .integer) {
        if (actual.integer < 0) return error.InvalidLanderRecord;
        return std.math.cast(u256, actual.integer) orelse error.InvalidLanderRecord;
    }
    if (actual == .number_string) return std.fmt.parseInt(u256, actual.number_string, 10) catch return error.InvalidLanderRecord;
    if (actual == .string) return parseUint(actual.string);
    return error.InvalidLanderRecord;
}

pub fn optionalUint(value: std.json.Value, name: []const u8) !?u256 {
    const actual = optionalField(value, name) orelse return null;
    if (actual == .null) return null;
    if (actual == .integer) {
        if (actual.integer < 0) return error.InvalidLanderRecord;
        return std.math.cast(u256, actual.integer) orelse error.InvalidLanderRecord;
    }
    if (actual == .number_string) return (std.fmt.parseInt(u256, actual.number_string, 10) catch return error.InvalidLanderRecord);
    if (actual == .string) return try parseUint(actual.string);
    return error.InvalidLanderRecord;
}

pub fn parseUint(text: []const u8) !u256 {
    if (std.mem.startsWith(u8, text, "0x")) return abi.quantityAs(u256, text) catch return error.InvalidLanderRecord;
    if (text.len == 0) return error.InvalidLanderRecord;
    return std.fmt.parseInt(u256, text, 10) catch return error.InvalidLanderRecord;
}

pub fn parseHash(text: []const u8) !Hash {
    // Lander's H512 uses the upper zero word followed by the EVM hash.
    if (text.len == 2 + 128) {
        const wide = abi.fixedHex(64, text) catch return error.InvalidLanderRecord;
        if (!std.mem.allEqual(u8, wide[0..32], 0)) return error.InvalidLanderRecord;
        return wide[32..64].*;
    }
    return abi.fixedHex(32, text) catch return error.InvalidLanderRecord;
}

pub fn wideHashText(allocator: std.mem.Allocator, hash: Hash) ![]u8 {
    var wide: [64]u8 = @splat(0);
    wide[32..].* = hash;
    return abi.hexAlloc(allocator, &wide);
}

pub fn statusFromJson(value: std.json.Value) !Status {
    if (value == .string) {
        if (std.mem.eql(u8, value.string, "PendingInclusion")) return .pending_inclusion;
        if (std.mem.eql(u8, value.string, "Mempool")) return .mempool;
        if (std.mem.eql(u8, value.string, "Included")) return .included;
        if (std.mem.eql(u8, value.string, "Finalized")) return .finalized;
        return error.InvalidLanderRecord;
    }
    if (value != .object or value.object.count() != 1) return error.InvalidLanderRecord;
    const dropped = value.object.get("Dropped") orelse return error.InvalidLanderRecord;
    if (dropped == .string) {
        if (std.mem.eql(u8, dropped.string, "DroppedByChain")) return .{ .dropped = .dropped_by_chain };
        if (std.mem.eql(u8, dropped.string, "FailedSimulation")) return .{ .dropped = .failed_simulation };
        return error.InvalidLanderRecord;
    }
    if (dropped == .object) {
        const other = dropped.object.get("Other") orelse return error.InvalidLanderRecord;
        if (other != .string) return error.InvalidLanderRecord;
        return .{ .dropped = .{ .other = other.string } };
    }
    return error.InvalidLanderRecord;
}

pub fn statusJson(allocator: std.mem.Allocator, status: Status) !std.json.Value {
    return switch (status) {
        .pending_inclusion => .{ .string = "PendingInclusion" },
        .mempool => .{ .string = "Mempool" },
        .included => .{ .string = "Included" },
        .finalized => .{ .string = "Finalized" },
        .dropped => |reason| blk: {
            var outer = std.json.ObjectMap.init(allocator);
            const dropped: std.json.Value = switch (reason) {
                .dropped_by_chain => .{ .string = "DroppedByChain" },
                .failed_simulation => .{ .string = "FailedSimulation" },
                .other => |text| inner: {
                    var object = std.json.ObjectMap.init(allocator);
                    try object.put("Other", .{ .string = text });
                    break :inner .{ .object = object };
                },
            };
            try outer.put("Dropped", dropped);
            break :blk .{ .object = outer };
        },
    };
}

pub fn payloadStatusJson(allocator: std.mem.Allocator, status: Status) !std.json.Value {
    var object = std.json.ObjectMap.init(allocator);
    try object.put("InTransaction", try statusJson(allocator, status));
    return .{ .object = object };
}

pub const RequestInfo = struct {
    request: Request,
    owned_data: []u8,
    access_keys: []transaction.AccessTuple = &.{},

    pub fn deinit(self: *RequestInfo, allocator: std.mem.Allocator) void {
        allocator.free(self.owned_data);
        for (self.access_keys) |entry| allocator.free(entry.storage_keys);
        if (self.access_keys.len > 0) allocator.free(self.access_keys);
        self.* = undefined;
    }
};

pub fn parseRequest(allocator: std.mem.Allocator, value: std.json.Value) !RequestInfo {
    const kind: std.json.Value = optionalField(value, "type") orelse .{ .string = "0x00" };
    if (kind != .string) return error.InvalidLanderRecord;
    const data = if (optionalField(value, "data")) |actual| if (actual == .null) try allocator.dupe(u8, "") else try decodeHex(allocator, try stringField(value, "data")) else try allocator.dupe(u8, "");
    errdefer allocator.free(data);
    const to = if (optionalField(value, "to")) |actual| if (actual == .null) null else try abi.fixedHex(20, try stringField(value, "to")) else null;
    const nonce = (try optionalUint(value, "nonce")) orelse 0;
    const gas_limit = (try optionalUint(value, "gas")) orelse 0;
    const amount = (try optionalUint(value, "value")) orelse 0;
    if (std.mem.eql(u8, kind.string, "0x00")) {
        return .{ .owned_data = data, .request = .{ .legacy = .{
            .chain_id = try optionalUint(value, "chainId"),
            .nonce = nonce,
            .gas_price = (try optionalUint(value, "gasPrice")) orelse 0,
            .gas_limit = gas_limit,
            .to = to,
            .value = amount,
            .data = data,
        } } };
    }
    if (!std.mem.eql(u8, kind.string, "0x01") and !std.mem.eql(u8, kind.string, "0x02")) return error.UnsupportedEvmTransaction;
    var access: []transaction.AccessTuple = &.{};
    errdefer {
        for (access) |entry| allocator.free(entry.storage_keys);
        if (access.len > 0) allocator.free(access);
    }
    if (optionalField(value, "accessList")) |list| {
        if (list != .array) return error.InvalidLanderRecord;
        access = try allocator.alloc(transaction.AccessTuple, list.array.items.len);
        @memset(access, .{ .address = @splat(0), .storage_keys = &.{} });
        for (list.array.items, 0..) |entry, i| {
            const raw_keys = try field(entry, "storageKeys");
            if (raw_keys != .array) return error.InvalidLanderRecord;
            const keys = try allocator.alloc(Hash, raw_keys.array.items.len);
            access[i].storage_keys = keys;
            for (raw_keys.array.items, 0..) |key, j| {
                if (key != .string) return error.InvalidLanderRecord;
                keys[j] = try parseHash(key.string);
            }
            access[i].address = try abi.fixedHex(20, try stringField(entry, "address"));
        }
    }
    if (std.mem.eql(u8, kind.string, "0x01")) {
        return .{ .owned_data = data, .access_keys = access, .request = .{ .eip2930 = .{
            .chain_id = (try optionalUint(value, "chainId")) orelse 0,
            .nonce = nonce,
            .gas_price = (try optionalUint(value, "gasPrice")) orelse 0,
            .gas_limit = gas_limit,
            .to = to,
            .value = amount,
            .data = data,
            .access_list = access,
        } } };
    }
    return .{ .owned_data = data, .access_keys = access, .request = .{ .eip1559 = .{
        .chain_id = (try optionalUint(value, "chainId")) orelse 0,
        .nonce = nonce,
        .max_priority_fee_per_gas = (try optionalUint(value, "maxPriorityFeePerGas")) orelse 0,
        .max_fee_per_gas = (try optionalUint(value, "maxFeePerGas")) orelse 0,
        .gas_limit = gas_limit,
        .to = to,
        .value = amount,
        .data = data,
        .access_list = access,
    } } };
}

fn decodeHex(allocator: std.mem.Allocator, text: []const u8) ![]u8 {
    if (text.len < 2 or text.len % 2 != 0) return error.InvalidLanderRecord;
    const out = try allocator.alloc(u8, (text.len - 2) / 2);
    errdefer allocator.free(out);
    _ = abi.decodeHex(out, text) catch return error.InvalidLanderRecord;
    return out;
}

pub fn updateRequest(value: *std.json.Value, allocator: std.mem.Allocator, request: Request) !void {
    if (value.* != .object) return error.InvalidLanderRecord;
    switch (request) {
        .legacy => |tx| {
            try value.object.put("type", .{ .string = "0x00" });
            _ = value.object.orderedRemove("maxFeePerGas");
            _ = value.object.orderedRemove("maxPriorityFeePerGas");
            try value.object.put("nonce", .{ .string = try quantity(allocator, tx.nonce) });
            try value.object.put("gas", .{ .string = try quantity(allocator, tx.gas_limit) });
            try value.object.put("gasPrice", .{ .string = try quantity(allocator, tx.gas_price) });
        },
        .eip2930 => |tx| {
            try value.object.put("type", .{ .string = "0x01" });
            _ = value.object.orderedRemove("maxFeePerGas");
            _ = value.object.orderedRemove("maxPriorityFeePerGas");
            try value.object.put("nonce", .{ .string = try quantity(allocator, tx.nonce) });
            try value.object.put("gas", .{ .string = try quantity(allocator, tx.gas_limit) });
            try value.object.put("gasPrice", .{ .string = try quantity(allocator, tx.gas_price) });
        },
        .eip1559 => |tx| {
            try value.object.put("type", .{ .string = "0x02" });
            _ = value.object.orderedRemove("gasPrice");
            try value.object.put("nonce", .{ .string = try quantity(allocator, tx.nonce) });
            try value.object.put("gas", .{ .string = try quantity(allocator, tx.gas_limit) });
            try value.object.put("maxFeePerGas", .{ .string = try quantity(allocator, tx.max_fee_per_gas) });
            try value.object.put("maxPriorityFeePerGas", .{ .string = try quantity(allocator, tx.max_priority_fee_per_gas) });
            if (tx.access_list.len == 0) {
                const empty = try allocator.alloc(std.json.Value, 0);
                try value.object.put("accessList", .{ .array = .{ .items = empty, .capacity = 0, .allocator = allocator } });
            }
        },
    }
}

pub fn quantity(allocator: std.mem.Allocator, value: u256) ![]u8 {
    return std.fmt.allocPrint(allocator, "0x{x}", .{value});
}

pub fn decimal(allocator: std.mem.Allocator, value: u256) ![]u8 {
    return std.fmt.allocPrint(allocator, "{d}", .{value});
}

pub fn setFrom(allocator: std.mem.Allocator, value: *std.json.Value, address: Address) !void {
    if (value.* != .object) return error.InvalidLanderRecord;
    try value.object.put("from", .{ .string = try abi.hexAlloc(allocator, &address) });
}

pub fn requestFromRecord(value: std.json.Value) !std.json.Value {
    const vm = try field(value, "vm_specific_data");
    const evm = try field(vm, "Evm");
    return field(evm, "tx");
}

pub fn requestPtr(value: *std.json.Value) !*std.json.Value {
    if (value.* != .object) return error.InvalidLanderRecord;
    const vm = value.object.getPtr("vm_specific_data") orelse return error.InvalidLanderRecord;
    if (vm.* != .object) return error.InvalidLanderRecord;
    const evm = vm.object.getPtr("Evm") orelse return error.InvalidLanderRecord;
    if (evm.* != .object) return error.InvalidLanderRecord;
    return evm.object.getPtr("tx") orelse error.InvalidLanderRecord;
}

test "UUID, status precedence and H512 compatibility" {
    const allocator = std.testing.allocator;
    const uuid: Uuid = .{ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 };
    const text = try uuidText(allocator, uuid);
    defer allocator.free(text);
    try std.testing.expectEqualStrings("00010203-0405-0607-0809-0a0b0c0d0e0f", text);
    try std.testing.expectEqual(uuid, try parseUuid(text));
    const statuses = [_]?Status{ .mempool, null, .included, .pending_inclusion };
    try std.testing.expectEqual(Status.included, classify(&statuses));
    try std.testing.expectEqual(Status.finalized, classify(&.{ .included, .finalized }));
    try std.testing.expectEqual(Status.pending_inclusion, classify(&.{ null, null }));
    try std.testing.expectEqual(Status{ .dropped = .dropped_by_chain }, classify(&.{.{ .dropped = .failed_simulation }}));
    const hash: Hash = @splat(0x12);
    const wide = try wideHashText(allocator, hash);
    defer allocator.free(wide);
    try std.testing.expectEqual(hash, try parseHash(wide));
}
