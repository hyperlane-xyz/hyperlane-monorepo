//! Paged event reads checked against canonical headers and transaction receipts.
//! Stable log indices come from receipt array positions, not page ordinals.
const std = @import("std");
const rpc = @import("../net/json_rpc.zig");
const provider = @import("provider.zig");
const codec = @import("codec.zig");
const protocol = @import("../protocol/root.zig");
pub const Felt = codec.Felt;
pub const Event = struct {
    address: Felt,
    keys: []const Felt,
    data: []const Felt,
    transaction_hash: Felt,
    block_hash: Felt,
    block_number: u64,
    transaction_index: u32 = 0,
    log_index: u32,
};
pub const Events = struct {
    arena: std.heap.ArenaAllocator,
    items: []Event,
    pub fn deinit(self: *Events) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub const Decoded = union(enum) {
    dispatch: protocol.Message,
    process_id: [32]u8,
    dispatch_id: [32]u8,
    insertion: struct { id: [32]u8, index: u32 },
    process: struct { origin: u32, sender: [32]u8, recipient: [32]u8 },
    pub fn deinit(self: *Decoded, a: std.mem.Allocator) void {
        if (self.* == .dispatch) a.free(self.dispatch.body);
        self.* = undefined;
    }
};
pub fn decode(a: std.mem.Allocator, event: Event, max_body: usize) !Decoded {
    if (event.keys.len != 1) return error.InvalidStarknetEvent;
    const topic = event.keys[0].value;
    var decoder: codec.Decoder = .{ .input = event.data };
    if (topic == codec.selector("Dispatch").value) {
        const sender = try decoder.hash();
        const destination = try decoder.integer(u32);
        const recipient = try decoder.hash();
        const message = try decoder.message(a, max_body);
        errdefer a.free(message.body);
        try decoder.finish();
        if (!std.mem.eql(u8, &sender, &message.sender) or destination != message.destination or !std.mem.eql(u8, &recipient, &message.recipient)) return error.InconsistentStarknetDispatch;
        return .{ .dispatch = message };
    }
    if (topic == codec.selector("ProcessId").value or topic == codec.selector("DispatchId").value) {
        const id = try decoder.hash();
        try decoder.finish();
        return if (topic == codec.selector("ProcessId").value) .{ .process_id = id } else .{ .dispatch_id = id };
    }
    if (topic == codec.selector("InsertedIntoTree").value) {
        const id = try decoder.hash();
        const index = try decoder.integer(u32);
        try decoder.finish();
        return .{ .insertion = .{ .id = id, .index = index } };
    }
    if (topic == codec.selector("Process").value) {
        const origin = try decoder.integer(u32);
        const sender = try decoder.hash();
        const recipient = try decoder.hash();
        try decoder.finish();
        return .{ .process = .{ .origin = origin, .sender = sender, .recipient = recipient } };
    }
    return error.UnsupportedStarknetEvent;
}
const Budget = struct {
    remaining: usize,
    fn spend(self: *Budget, size: usize) !void {
        if (size > self.remaining) return error.StarknetEventByteLimit;
        self.remaining -= size;
    }
};
fn payload(a: std.mem.Allocator, value: rpc.Value, maximum: usize, budget: *Budget) !struct { address: Felt, keys: []Felt, data: []Felt } {
    const address = try provider.felt(try rpc.field(value, "from_address"));
    const raw_keys = try rpc.field(value, "keys");
    const raw_data = try rpc.field(value, "data");
    if (raw_keys != .array or raw_data != .array or raw_keys.array.items.len > 64 or raw_data.array.items.len > maximum) return error.InvalidStarknetFeltArray;
    const words = try std.math.add(usize, raw_keys.array.items.len, raw_data.array.items.len);
    try budget.spend(try std.math.add(usize, try std.math.mul(usize, words, @sizeOf(Felt)), 2 * @sizeOf(Event)));
    const keys = try provider.feltArray(a, raw_keys, 64);
    errdefer a.free(keys);
    const data = try provider.feltArray(a, raw_data, maximum);
    return .{ .address = address, .keys = keys, .data = data };
}
fn observed(a: std.mem.Allocator, value: rpc.Value, maximum: usize, budget: *Budget) !Event {
    const hash = try provider.felt(try rpc.field(value, "transaction_hash"));
    const block = try provider.felt(try rpc.field(value, "block_hash"));
    const number = try rpc.integer(u64, try rpc.field(value, "block_number"));
    const decoded = try payload(a, value, maximum, budget);
    return .{ .address = decoded.address, .keys = decoded.keys, .data = decoded.data, .transaction_hash = hash, .block_hash = block, .block_number = number, .log_index = 0 };
}
fn equalFelts(left: []const Felt, right: []const Felt) bool {
    if (left.len != right.len) return false;
    for (left, right) |x, y| if (x.value != y.value) return false;
    return true;
}
fn equalPayload(left: Event, right: Event) bool {
    return left.address.value == right.address.value and equalFelts(left.keys, right.keys) and equalFelts(left.data, right.data);
}
const TxRecord = struct { number: u64, hash: Felt, events: []Event };
const BlockRecord = struct { hash: Felt, indices: std.AutoHashMap(u256, u32) };

pub fn fetch(p: *provider.Provider, address: Felt, topic: Felt, from: u64, to: u64, reorg: provider.ReorgPeriod) !Events {
    if (from > to or p.max_event_range == 0 or to - from >= p.max_event_range) return error.InvalidStarknetEventRange;
    if (to > try p.height(reorg)) return error.StarknetRangeNotFinalized;
    if (p.max_event_pages == 0 or p.max_events == 0) return error.InvalidStarknetEventLimit;
    var arena = std.heap.ArenaAllocator.init(p.allocator);
    errdefer arena.deinit();
    const a = arena.allocator();
    var tokens: std.StringHashMap(void) = .init(a);
    var token: ?[]const u8 = null;
    var page_number: usize = 0;
    var found: std.ArrayList(Event) = .empty;
    var budget: Budget = .{ .remaining = p.max_event_bytes };
    while (true) {
        if (page_number == p.max_event_pages) return error.StarknetEventPageLimit;
        page_number += 1;
        var response = try p.client.call("starknet_getEvents", .{ .filter = .{ .from_block = provider.BlockId{ .number = from }, .to_block = provider.BlockId{ .number = to }, .address = address, .keys = .{.{topic}}, .chunk_size = 50, .continuation_token = token } });
        defer response.deinit();
        const values = try rpc.field(response.value(), "events");
        if (values != .array or values.array.items.len > 50 or values.array.items.len > p.max_events - found.items.len) return error.StarknetEventLimit;
        for (values.array.items) |value| {
            const event = try observed(a, value, p.max_call_felts, &budget);
            if (event.block_number < from or event.block_number > to or event.address.value != address.value or event.keys.len == 0 or event.keys[0].value != topic.value) return error.StarknetEventOutsideFilter;
            try found.append(a, event);
        }
        const next = response.value().object.get("continuation_token") orelse break;
        if (next == .null) break;
        const text = try rpc.string(next);
        if (text.len == 0) break;
        if (text.len > 4096 or tokens.contains(text)) return error.StarknetEventTokenCycle;
        try budget.spend(try std.math.add(usize, text.len, 128));
        token = try a.dupe(u8, text);
        try tokens.put(token.?, {});
    }
    var blocks: std.AutoHashMap(u64, BlockRecord) = .init(a);
    var transactions: std.AutoHashMap(u256, TxRecord) = .init(a);
    var result: std.ArrayList(Event) = .empty;
    for (found.items) |event| {
        if (!transactions.contains(event.transaction_hash.value)) {
            var receipt = try p.receiptEnvelope(event.transaction_hash) orelse return error.MissingStarknetEventReceipt;
            defer receipt.deinit();
            const value = receipt.value();
            if ((try provider.felt(try rpc.field(value, "transaction_hash"))).value != event.transaction_hash.value) return error.WrongStarknetReceipt;
            const finality = try rpc.string(try rpc.field(value, "finality_status"));
            if (!std.mem.eql(u8, finality, "ACCEPTED_ON_L1") and !std.mem.eql(u8, finality, "ACCEPTED_ON_L2")) return error.UnconfirmedStarknetReceipt;
            if (!std.mem.eql(u8, try rpc.string(try rpc.field(value, "execution_status")), "SUCCEEDED")) return error.RevertedStarknetEventReceipt;
            const number = try rpc.integer(u64, try rpc.field(value, "block_number"));
            const hash = try provider.felt(try rpc.field(value, "block_hash"));
            if (number < from or number > to) return error.StarknetEventOutsideFilter;
            if (!blocks.contains(number)) {
                var response = try p.client.call("starknet_getBlockWithTxHashes", .{ .block_id = provider.BlockId{ .number = number } });
                defer response.deinit();
                const header = try provider.Header.parse(response.value());
                if (header.number != number) return error.WrongStarknetBlock;
                const raw_hashes = try rpc.field(response.value(), "transactions");
                if (raw_hashes != .array) return error.InvalidStarknetFeltArray;
                try budget.spend(try std.math.mul(usize, raw_hashes.array.items.len, 192));
                const hashes = try provider.feltArray(a, raw_hashes, p.max_call_felts);
                var indices: std.AutoHashMap(u256, u32) = .init(a);
                for (hashes, 0..) |item, index| {
                    const entry = try indices.getOrPut(item.value);
                    if (entry.found_existing) return error.DuplicateStarknetBlockTransaction;
                    entry.value_ptr.* = std.math.cast(u32, index) orelse return error.StarknetEventLimit;
                }
                try blocks.put(number, .{ .hash = header.hash, .indices = indices });
            }
            const block_record = blocks.get(number).?;
            if (block_record.hash.value != hash.value) return error.NoncanonicalStarknetEvent;
            const transaction_index = block_record.indices.get(event.transaction_hash.value) orelse return error.StarknetTransactionAbsentFromBlock;
            const events = try rpc.field(value, "events");
            if (events != .array or events.array.items.len > p.max_events) return error.StarknetEventLimit;
            const all = try a.alloc(Event, events.array.items.len);
            for (events.array.items, all, 0..) |raw, *item, index| {
                const data = try payload(a, raw, p.max_call_felts, &budget);
                item.* = .{ .address = data.address, .keys = data.keys, .data = data.data, .transaction_hash = event.transaction_hash, .block_hash = hash, .block_number = number, .transaction_index = transaction_index, .log_index = std.math.cast(u32, index) orelse return error.StarknetEventLimit };
                if (item.address.value == address.value and item.keys.len > 0 and item.keys[0].value == topic.value) {
                    if (result.items.len == p.max_events) return error.StarknetEventLimit;
                    try result.append(a, item.*);
                }
            }
            try transactions.put(event.transaction_hash.value, .{ .number = number, .hash = hash, .events = all });
            try budget.spend(256);
        }
        const record = transactions.get(event.transaction_hash.value).?;
        if (record.number != event.block_number or record.hash.value != event.block_hash.value) return error.NoncanonicalStarknetEvent;
        var matched = false;
        for (record.events) |item| if (equalPayload(item, event)) {
            matched = true;
            break;
        };
        if (!matched) return error.StarknetEventAbsentFromReceipt;
    }
    std.mem.sort(Event, result.items, {}, less);
    const items = try result.toOwnedSlice(a);
    return .{ .arena = arena, .items = items };
}
fn less(_: void, left: Event, right: Event) bool {
    if (left.block_number != right.block_number) return left.block_number < right.block_number;
    if (left.transaction_index != right.transaction_index) return left.transaction_index < right.transaction_index;
    return left.log_index < right.log_index;
}
