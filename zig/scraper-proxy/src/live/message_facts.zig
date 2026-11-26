//! Port of `message-facts.ts` (TS #10078): group `live_message_facts` rows by
//! message, validate each message alone (a bad row fails only its ID), and
//! project one message for a subscriber's frontiers.
//!
//! Row values are node-pg's (`db/convert.zig`): int8/numeric/bytea/timestamp/
//! interval text, int4 numbers, json parsed. `bytes` is exactly
//! `Buffer.byteLength(JSON.stringify(...))` of those values, so the
//! `websocket_message_source_fact_bytes` gauge matches TS byte for byte.
const std = @import("std");
const core = @import("core");
const protocol = @import("protocol.zig");

const json = core.json;
const Value = json.Value;
const Member = json.Member;
const Allocator = std.mem.Allocator;

/// A BigInt as normalized decimal digits (`String(BigInt(value))`): counts
/// and 256-bit payment sums. (LLVM cannot lower >128-bit division here.)
pub const Amount = []const u8;

pub const Payment = struct {
    domain: u32,
    height: ?i128,
    count: Amount,
    payment: Amount,
    gas: Amount,
};

pub const Delivery = struct {
    domain: u32,
    height: ?i128,
    /// The delivery columns of its row, in row order.
    fields: []const Member,
};

/// `MessageFacts`. Everything lives in `arena`.
pub const Facts = struct {
    arena: std.heap.ArenaAllocator,
    /// `Set` insertion order: origin, destination, payment domains, then
    /// delivery domains as rows arrive.
    dependencies: std.ArrayList(u32) = .empty,
    origin: u32,
    destination: u32,
    height: i128,
    /// The first row without `delivery_*`/`payment_buckets`, delivery
    /// columns nulled, `is_delivered: false`.
    pending: []Member,
    /// TS #10082: one delivery (later legacy duplicate rows are ignored).
    delivery: ?Delivery = null,
    payments: []Payment,
    bytes: usize,

    pub fn destroy(self: *Facts) void {
        const allocator = self.arena.child_allocator;
        self.arena.deinit();
        allocator.destroy(self);
    }

    fn addDependency(self: *Facts, domain: u32) Allocator.Error!void {
        if (std.mem.indexOfScalar(u32, self.dependencies.items, domain) != null) return;
        try self.dependencies.append(self.arena.allocator(), domain);
    }
};

/// One message's outcome: its facts, or the `Error` that isolated it.
pub const Outcome = union(enum) {
    facts: *Facts,
    /// `error.message` (owned by the collection).
    failure: []const u8,
};

/// `collectMessageFacts(rows)`: msg_id → outcome, in first-row order.
pub const Collected = struct {
    allocator: Allocator,
    outcomes: std.StringArrayHashMapUnmanaged(Outcome) = .empty,

    /// Frees ids, failure texts and any facts not taken with `take`.
    pub fn deinit(self: *Collected) void {
        for (self.outcomes.keys(), self.outcomes.values()) |id, outcome| {
            self.allocator.free(id);
            switch (outcome) {
                .facts => |facts| facts.destroy(),
                .failure => |text| self.allocator.free(text),
            }
        }
        self.outcomes.deinit(self.allocator);
    }

    pub fn get(self: *const Collected, id: []const u8) ?Outcome {
        return self.outcomes.get(id);
    }

    /// Transfer one outcome's ownership to the caller (the entry is removed).
    pub fn take(self: *Collected, id: []const u8) ?Outcome {
        const entry = self.outcomes.fetchOrderedRemove(id) orelse return null;
        self.allocator.free(entry.key);
        return entry.value;
    }
};

const Failure = error{Invalid} || Allocator.Error;

/// The message recorded by the failing check (`new Error(text)`).
const Diag = struct { message: []const u8 = "" };

fn invalid(diag: *Diag, message: []const u8) error{Invalid} {
    diag.message = message;
    return error.Invalid;
}

pub fn collect(allocator: Allocator, rows: []const Value) Allocator.Error!Collected {
    var result: Collected = .{ .allocator = allocator };
    errdefer result.deinit();
    // `grouped`: msg_id → rows, first-appearance order.
    var groups: std.StringArrayHashMapUnmanaged(std.ArrayList(Value)) = .empty;
    defer {
        for (groups.values()) |*group| group.deinit(allocator);
        groups.deinit(allocator);
    }
    for (rows) |row| {
        const id = msgId(row) orelse continue;
        const entry = try groups.getOrPut(allocator, id);
        if (!entry.found_existing) entry.value_ptr.* = .empty;
        try entry.value_ptr.append(allocator, row);
    }
    for (groups.keys(), groups.values()) |id, group| {
        const key = try allocator.dupe(u8, id);
        errdefer allocator.free(key);
        var diag: Diag = .{};
        const outcome: Outcome = if (collectOne(allocator, group.items, &diag)) |facts|
            .{ .facts = facts }
        else |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            error.Invalid => .{ .failure = try allocator.dupe(u8, diag.message) },
        };
        try result.outcomes.put(allocator, key, outcome);
    }
    return result;
}

/// node-pg's bytea text; the TS Map keys rows by it.
fn msgId(row: Value) ?[]const u8 {
    const value = row.get("msg_id") orelse return null;
    return if (value == .string) value.string else null;
}

fn deliveryField(key: []const u8) bool {
    return std.mem.eql(u8, key, "delivery_scraped_at") or
        std.mem.eql(u8, key, "delivery_occurred_at") or
        std.mem.eql(u8, key, "delivery_latency") or
        std.mem.eql(u8, key, "delivery_scape_latency") or
        std.mem.eql(u8, key, "destination_mailbox") or
        std.mem.startsWith(u8, key, "destination_block_") or
        std.mem.startsWith(u8, key, "destination_tx_");
}

fn excluded(key: []const u8) bool {
    return std.mem.eql(u8, key, "delivery_height") or
        std.mem.eql(u8, key, "delivery_domain") or
        std.mem.eql(u8, key, "payment_buckets");
}

/// `collectValidFacts(group).get(id)`: every row of one message.
fn collectOne(allocator: Allocator, rows: []const Value, diag: *Diag) Failure!*Facts {
    const facts = try allocator.create(Facts);
    facts.* = .{ .arena = .init(allocator), .origin = 0, .destination = 0, .height = 0, .pending = &.{}, .payments = &.{}, .bytes = 0 };
    errdefer facts.destroy();
    const a = facts.arena.allocator();
    for (rows, 0..) |row, index| {
        if (row != .object) return invalid(diag, "Invalid message facts row");
        // `fields`: this row's delivery columns, in row order.
        var fields: std.ArrayList(Member) = .empty;
        for (row.object) |member| {
            if (excluded(member.key) or !deliveryField(member.key)) continue;
            try fields.append(a, .{ .key = try a.dupe(u8, member.key), .value = try clone(a, member.value) });
        }
        if (index == 0) try first(facts, row, fields.items, diag);
        // Legacy duplicate canonical rows can repeat the one delivery.
        const delivery_domain = row.get("delivery_domain") orelse Value.null;
        if (delivery_domain != .null and facts.delivery == null) {
            const domain = try databaseDomain(delivery_domain, "Invalid delivery domain", diag);
            try facts.addDependency(domain);
            const height = row.get("delivery_height") orelse Value.null;
            facts.delivery = .{
                .domain = domain,
                .height = if (height == .null) null else try heightId(height, diag),
                .fields = fields.items,
            };
            facts.bytes += jsonBytes(.{ .object = fields.items });
        }
    }
    return facts;
}

/// The message's first row: pending row, payments, dependencies, bytes.
fn first(facts: *Facts, row: Value, fields: []const Member, diag: *Diag) Failure!void {
    const a = facts.arena.allocator();
    const buckets = row.get("payment_buckets") orelse Value.null;
    const bucket_count: usize = if (buckets == .array) buckets.array.len else 0;
    facts.origin = try databaseDomain(row.get("origin_domain_id"), "Invalid origin domain", diag);
    facts.destination = try databaseDomain(row.get("destination_domain_id"), "Invalid destination domain", diag);
    // `{...data, origin_domain_id, destination_domain_id, is_delivered: false}`,
    // then every delivery column of this row nulled: keys keep their places.
    var pending: std.ArrayList(Member) = .empty;
    for (row.object) |member| {
        if (excluded(member.key)) continue;
        var value = try clone(a, member.value);
        if (std.mem.eql(u8, member.key, "origin_domain_id")) value = json.int(facts.origin);
        if (std.mem.eql(u8, member.key, "destination_domain_id")) value = json.int(facts.destination);
        if (std.mem.eql(u8, member.key, "is_delivered")) value = .{ .bool = false };
        try pending.append(a, .{ .key = try a.dupe(u8, member.key), .value = value });
    }
    if (row.get("is_delivered") == null) try pending.append(a, .{ .key = "is_delivered", .value = .{ .bool = false } });
    for (fields) |field| {
        for (pending.items) |*member| if (std.mem.eql(u8, member.key, field.key)) {
            member.value = .null;
        };
    }
    facts.pending = pending.items;
    const payments = try a.alloc(Payment, bucket_count);
    if (buckets == .array) for (buckets.array, payments) |bucket, *payment| {
        payment.* = .{
            .domain = try databaseDomain(bucket.get("domain"), "Invalid payment domain", diag),
            // `b.height === null ? null : parseId(b.height)`: absent is an error.
            .height = if (isNull(bucket.get("height"))) null else try heightId(bucket.get("height") orelse .null, diag),
            .count = try amount(a, bucket.get("count"), diag),
            .payment = try amount(a, bucket.get("payment"), diag),
            .gas = try amount(a, bucket.get("gas"), diag),
        };
    };
    facts.payments = payments;
    try facts.addDependency(facts.origin);
    try facts.addDependency(facts.destination);
    for (payments) |payment| try facts.addDependency(payment.domain);
    facts.height = try heightId(row.get("origin_block_height") orelse .null, diag);
    facts.bytes = jsonBytes(.{ .object = pending.items }) + jsonBytes(buckets);
}

/// `x === null` (absent is `undefined`, not null).
fn isNull(value: ?Value) bool {
    const present = value orelse return false;
    return present == .null;
}

fn databaseDomain(value: ?Value, message: []const u8, diag: *Diag) error{Invalid}!u32 {
    var pdiag: protocol.Diag = .{};
    return protocol.parseDatabaseDomain(value, message, &pdiag) catch invalid(diag, message);
}

const ID_MESSAGE = "id must be a non-negative integer string";

/// `parseId(value)` (block heights).
fn heightId(value: Value, diag: *Diag) error{Invalid}!i128 {
    var pdiag: protocol.Diag = .{};
    return protocol.parseId(value, &pdiag) catch invalid(diag, ID_MESSAGE);
}

/// `parseId(value)` for counts and 256-bit sums (`a` owns the digits).
fn amount(a: Allocator, value: ?Value, diag: *Diag) Failure!Amount {
    const present = value orelse return invalid(diag, ID_MESSAGE);
    switch (present) {
        .number => |number| {
            if (!protocol.isSafeInteger(number) or number < 0) return invalid(diag, ID_MESSAGE);
            return std.fmt.allocPrint(a, "{d}", .{@as(u64, @intFromFloat(number))});
        },
        .string => |text| {
            if (text.len == 0) return invalid(diag, ID_MESSAGE);
            for (text) |c| if (c < '0' or c > '9') return invalid(diag, ID_MESSAGE);
            // `BigInt("007")` is 7n.
            const digits = std.mem.trimLeft(u8, text, "0");
            return a.dupe(u8, if (digits.len == 0) "0" else digits);
        },
        else => return invalid(diag, ID_MESSAGE),
    }
}

/// A running BigInt sum (little-endian decimal digits).
const Sum = struct {
    digits: std.ArrayList(u8) = .empty,

    fn add(self: *Sum, a: Allocator, value: Amount) Allocator.Error!void {
        var carry: u8 = 0;
        var i: usize = 0;
        while (i < value.len or carry > 0) : (i += 1) {
            if (i == self.digits.items.len) try self.digits.append(a, 0);
            const digit: u8 = if (i < value.len) value[value.len - 1 - i] - '0' else 0;
            const total = self.digits.items[i] + digit + carry;
            self.digits.items[i] = total % 10;
            carry = total / 10;
        }
    }

    /// `String(sum)`.
    fn text(self: *const Sum, a: Allocator) Allocator.Error![]const u8 {
        var len = self.digits.items.len;
        while (len > 1 and self.digits.items[len - 1] == 0) len -= 1;
        if (len == 0) return "0";
        const out = try a.alloc(u8, len);
        for (out, 0..) |*c, i| c.* = self.digits.items[len - 1 - i] + '0';
        return out;
    }
};

/// `Buffer.byteLength(JSON.stringify(value))`.
pub fn jsonBytes(value: Value) usize {
    var buffer: [256]u8 = undefined;
    var counter = std.Io.Writer.Discarding.init(&buffer);
    json.stringify(&counter.writer, value) catch unreachable;
    return @intCast(counter.fullCount());
}

fn clone(a: Allocator, value: Value) Allocator.Error!Value {
    return switch (value) {
        .null, .bool, .number => value,
        .raw => |text| .{ .raw = try a.dupe(u8, text) },
        .string => |text| .{ .string = try a.dupe(u8, text) },
        .array => |items| blk: {
            const out = try a.alloc(Value, items.len);
            for (items, out) |item, *copy| copy.* = try clone(a, item);
            break :blk .{ .array = out };
        },
        .object => |members| blk: {
            const out = try a.alloc(Member, members.len);
            for (members, out) |member, *copy| copy.* = .{ .key = try a.dupe(u8, member.key), .value = try clone(a, member.value) };
            break :blk .{ .object = out };
        },
    };
}

// ---------------------------------------------------------------------------
// Projection

/// `frontier(domain)`: the subscriber's frontier, else the domain's confirmed
/// height, else none (visible).
pub const Frontier = struct {
    ctx: *const anyopaque,
    get: *const fn (ctx: *const anyopaque, domain: u32) ?i128,
};

pub const Projection = struct {
    /// `data`, in TS key order (allocated in the caller's arena).
    data: Value,
    /// `heights`: per domain, the highest fact a rollback could remove: visible
    /// origin/delivery heights and every payment height (Map insertion order).
    heights: std.AutoArrayHashMapUnmanaged(u32, i128),
};

/// `projectMessage(facts, frontier)`; null when the dispatch is not visible.
pub fn project(a: Allocator, facts: *const Facts, frontier: Frontier) Allocator.Error!?Projection {
    var heights: std.AutoArrayHashMapUnmanaged(u32, i128) = .empty;
    if (!try see(a, &heights, frontier, facts.origin, facts.height)) return null;
    const delivery: ?*const Delivery = if (facts.delivery) |*d|
        (if (try see(a, &heights, frontier, d.domain, d.height)) d else null)
    else
        null;
    var count: Sum = .{};
    var payment: Sum = .{};
    var gas: Sum = .{};
    for (facts.payments) |bucket| {
        // Folds are ranked from a domain's newest payments, so removing any of
        // them, visible or not, can move a payment into or out of a fold (#10085).
        if (bucket.height) |height| try raise(a, &heights, bucket.domain, height);
        if (!try see(a, &heights, frontier, bucket.domain, bucket.height)) continue;
        try count.add(a, bucket.count);
        try payment.add(a, bucket.payment);
        try gas.add(a, bucket.gas);
    }
    // `{...pending, ...delivery?.fields, is_delivered, num_payments, total_payment, total_gas_amount}`.
    var data: json.ObjectBuilder = .{};
    try data.members.ensureTotalCapacity(a, facts.pending.len + 3);
    data.members.appendSliceAssumeCapacity(facts.pending);
    if (delivery) |d| for (d.fields) |field| try data.put(a, field.key, field.value);
    try data.put(a, "is_delivered", .{ .bool = delivery != null });
    try data.put(a, "num_payments", .{ .string = try count.text(a) });
    try data.put(a, "total_payment", .{ .string = try payment.text(a) });
    try data.put(a, "total_gas_amount", .{ .string = try gas.text(a) });
    return .{ .data = try data.finish(a), .heights = heights };
}

/// `visible(domain, height)`: records a visible non-null height (`see`).
fn see(a: Allocator, heights: *std.AutoArrayHashMapUnmanaged(u32, i128), frontier: Frontier, domain: u32, height: ?i128) Allocator.Error!bool {
    const at = height orelse return true;
    if (frontier.get(frontier.ctx, domain)) |limit| if (at > limit) return false;
    try raise(a, heights, domain, at);
    return true;
}

/// `if (height > (heights.get(domain) ?? -1n)) heights.set(domain, height)`.
fn raise(a: Allocator, heights: *std.AutoArrayHashMapUnmanaged(u32, i128), domain: u32, height: i128) Allocator.Error!void {
    const slot = try heights.getOrPut(a, domain);
    if (!slot.found_existing or height > slot.value_ptr.*) slot.value_ptr.* = height;
}
