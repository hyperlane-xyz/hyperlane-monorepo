//! Finalization-key reconciliation: only successful transactions that actually
//! updated a candidate immutable event key can produce an indexed event.
const std = @import("std");
const provider = @import("provider.zig");
const codec = @import("codec.zig");
const plaintext = @import("plaintext.zig");
const json = @import("../net/json_rpc.zig");
const worker = @import("worker.zig");
pub const Kind = enum { dispatch, delivery, insertion, gas_payment };
pub const Decoded = union(Kind) { dispatch: codec.Message, delivery: [32]u8, insertion: codec.Insertion, gas_payment: codec.GasPayment };
pub const Event = struct { height: u32, block_hash: [32]u8, address: [32]u8, transaction: [32]u8, transaction_index: u32, index: u32, data: Decoded };
pub const Events = struct {
    arena: std.heap.ArenaAllocator,
    items: []Event,
    pub fn deinit(self: *Events) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub const Block = struct {
    arena: std.heap.ArenaAllocator,
    value: json.Value,
    pub fn deinit(self: *Block) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub const Decoder = struct {
    context: *anyopaque,
    decode_fn: *const fn (*anyopaque, std.mem.Allocator, []const u8) anyerror!Block,
    pub fn decode(self: Decoder, a: std.mem.Allocator, wire: []const u8) !Block {
        return self.decode_fn(self.context, a, wire);
    }
};
pub const NativeDecoder = struct {
    executable: []const u8,
    library: []const u8,
    network: u16,
    limits: worker.Limits = .{},
    pub fn interface(self: *NativeDecoder) Decoder {
        return .{ .context = self, .decode_fn = decode };
    }
    fn decode(context: *anyopaque, a: std.mem.Allocator, wire: []const u8) !Block {
        const self: *NativeDecoder = @ptrCast(@alignCast(context));
        return self.request(a, .block_info, wire);
    }
    pub fn confirmedInfo(self: *NativeDecoder, a: std.mem.Allocator, wire: []const u8) !Block {
        return self.request(a, .confirmed_info, wire);
    }
    pub fn transactionInfo(self: *NativeDecoder, a: std.mem.Allocator, wire: []const u8) !Block {
        return self.request(a, .transaction_info, wire);
    }
    fn request(self: *NativeDecoder, a: std.mem.Allocator, command: worker.Command, wire: []const u8) !Block {
        var arena = std.heap.ArenaAllocator.init(a);
        errdefer arena.deinit();
        const alloc = arena.allocator();
        var digits: [3][32]u8 = undefined;
        const memory = try std.fmt.bufPrint(&digits[0], "{d}", .{self.limits.memory_bytes});
        const input = try std.fmt.bufPrint(&digits[1], "{d}", .{self.limits.max_input_bytes});
        const output = try std.fmt.bufPrint(&digits[2], "{d}", .{self.limits.max_output_bytes});
        var session = try worker.Session.spawn(a, &.{ self.executable, memory, input, output }, self.limits);
        defer session.deinit();
        const config = try std.json.Stringify.valueAlloc(alloc, .{ .library = self.library, .network = self.network }, .{});
        const initialized = try session.exchange(.init, config);
        defer a.free(initialized);
        if (initialized.len != 0) return error.InvalidAleoWorkerFrame;
        const result = try session.exchange(command, wire);
        defer a.free(result);
        const parsed = try std.json.parseFromSlice(json.Value, alloc, result, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
        return .{ .arena = arena, .value = parsed.value };
    }
};
pub const Indexer = struct {
    provider: *provider.Provider,
    decoder: Decoder,
    program: []const u8,
    kind: Kind,
    hook: ?[]const u8 = null,
    domain: u32,
    max_blocks: u32 = 2000,
    max_events: usize = 8192,
    max_candidates: usize = 8192,
    max_bytes: usize = 64 * 1024 * 1024,
    fn indexMapping(self: *const Indexer) []const u8 {
        return switch (self.kind) {
            .dispatch => "dispatch_event_index",
            .delivery => "process_event_index",
            else => "last_event_index",
        };
    }
    fn valueMapping(self: *const Indexer) []const u8 {
        return switch (self.kind) {
            .dispatch => "dispatch_events",
            .delivery => "process_events",
            .insertion => "inserted_into_tree_events",
            .gas_payment => "gas_payment_events",
        };
    }
    fn key(self: *Indexer, a: std.mem.Allocator, index: u32, comptime height: bool) ![]u8 {
        if (self.kind == .dispatch or self.kind == .delivery) return std.fmt.allocPrint(a, "{d}u32", .{index});
        return std.fmt.allocPrint(a, if (height) "{{hook: {s}, block_height: {d}u32}}" else "{{hook: {s}, index: {d}u32}}", .{ self.hook orelse return error.MissingAleoHook, index });
    }
    pub fn fetch(self: *Indexer, a: std.mem.Allocator, from: u32, to: u32) !Events {
        if (from > to or self.max_blocks == 0 or to - from >= self.max_blocks) return error.InvalidAleoEventRange;
        if (to > try self.provider.height()) return error.AleoRangeNotFinalized;
        var arena = std.heap.ArenaAllocator.init(a);
        errdefer arena.deinit();
        const alloc = arena.allocator();
        var result: std.ArrayList(Event) = .empty;
        var candidates_used: usize = 0;
        var used: usize = 0;
        const address = try self.provider.native.programAddress(self.program);
        var height = from;
        while (true) {
            const index_key = try self.key(alloc, height, true);
            var latest = try self.provider.mapping(self.program, self.indexMapping(), index_key, false);
            defer latest.deinit();
            if (latest.value()) |latest_value| {
                const last = try latest_value.number(u32);
                var buffer: [16]u8 = undefined;
                var response = try self.provider.client.get(&.{ "block", try std.fmt.bufPrint(&buffer, "{d}", .{height}) }, &.{});
                defer response.deinit();
                const wire = try std.json.Stringify.valueAlloc(a, response.value(), .{});
                defer a.free(wire);
                var block = try self.decoder.decode(a, wire);
                defer block.deinit();
                const value = block.value;
                if (try json.integer(u32, try json.field(value, "height")) != height) return error.WrongAleoBlockHeight;
                const hash = try self.provider.native.id(.block, try json.string(try json.field(value, "hash")));
                const transactions = try json.field(value, "transactions");
                if (transactions != .array or transactions.array.items.len > 8192) return error.AleoTransactionLimit;
                var transitions: usize = 0;
                for (transactions.array.items) |transaction| {
                    const items = try json.field(transaction, "transitions");
                    if (items != .array) return error.InvalidAleoBlock;
                    for (items.array.items) |transition| if (std.mem.eql(u8, self.program, try json.string(try json.field(transition, "program_id")))) {
                        transitions += 1;
                    };
                }
                if (transitions > self.max_candidates - candidates_used) return error.AleoCandidateLimit;
                candidates_used += transitions;
                var possible = std.AutoHashMap([32]u8, u32).init(a);
                defer possible.deinit();
                for (0..transitions) |i| {
                    const index = last -| (std.math.cast(u32, i) orelse return error.AleoCandidateLimit);
                    const key_text = try self.key(alloc, index, false);
                    const id = try self.provider.native.mappingKeyId(self.program, self.valueMapping(), key_text);
                    try possible.put(id, index);
                }
                var seen = std.AutoHashMap(u32, [32]u8).init(a);
                defer seen.deinit();
                for (transactions.array.items) |transaction| {
                    const accepted = try json.field(transaction, "accepted");
                    if (accepted != .bool) return error.InvalidAleoBlock;
                    if (!accepted.bool) continue;
                    const items = try json.field(transaction, "transitions");
                    var matches = false;
                    for (items.array.items) |transition| if (std.mem.eql(u8, self.program, try json.string(try json.field(transition, "program_id")))) {
                        matches = true;
                    };
                    if (!matches) continue;
                    const tx = try self.provider.native.id(.transaction, try json.string(try json.field(transaction, "id")));
                    const tx_index = try json.integer(u32, try json.field(transaction, "index"));
                    const keys = try json.field(transaction, "finalize_keys");
                    if (keys != .array or keys.array.items.len > 65536) return error.AleoFinalizeLimit;
                    for (keys.array.items) |raw| {
                        const key_id = try byteHash(raw);
                        const index = possible.get(key_id) orelse continue;
                        if (seen.get(index)) |previous| {
                            if (!std.mem.eql(u8, &previous, &tx)) return error.ConflictingAleoEventOwner;
                            continue;
                        }
                        try seen.put(index, tx);
                        if (result.items.len >= self.max_events) return error.AleoEventLimit;
                        const key_text = try self.key(alloc, index, false);
                        var mapped = try self.provider.mapping(self.program, self.valueMapping(), key_text, false);
                        defer mapped.deinit();
                        const payload = mapped.value() orelse return error.MissingAleoImmutableEvent;
                        const data: Decoded = switch (self.kind) {
                            .dispatch => blk: {
                                const message = try codec.decodeMessage(alloc, payload);
                                if (message.nonce != index or message.origin != self.domain) return error.InconsistentAleoDispatch;
                                break :blk .{ .dispatch = message };
                            },
                            .delivery => .{ .delivery = try payload.hash() },
                            .insertion => blk: {
                                const insertion = try codec.insertion(payload);
                                if (insertion.index != index) return error.InconsistentAleoEventIndex;
                                break :blk .{ .insertion = insertion };
                            },
                            .gas_payment => blk: {
                                const payment = try codec.gasPayment(payload);
                                if (payment.index != index) return error.InconsistentAleoEventIndex;
                                break :blk .{ .gas_payment = payment };
                            },
                        };
                        const bytes = @sizeOf(Event) + @as(usize, if (data == .dispatch) 256 else 0);
                        if (bytes > self.max_bytes - used) return error.AleoEventByteLimit;
                        used += bytes;
                        try result.append(alloc, .{ .height = height, .block_hash = hash, .address = address, .transaction = tx, .transaction_index = tx_index, .index = index, .data = data });
                    }
                }
            }
            if (height == to) break;
            height += 1;
        }
        std.mem.sort(Event, result.items, {}, less);
        const owned_items = try result.toOwnedSlice(alloc);
        return .{ .arena = arena, .items = owned_items };
    }
};
fn less(_: void, left: Event, right: Event) bool {
    return if (left.height != right.height) left.height < right.height else if (left.transaction_index != right.transaction_index) left.transaction_index < right.transaction_index else left.index < right.index;
}
fn byteHash(value: json.Value) ![32]u8 {
    if (value != .array or value.array.items.len != 32) return error.InvalidAleoFinalizeKey;
    var hash: [32]u8 = undefined;
    for (value.array.items, &hash) |byte, *out| out.* = try json.integer(u8, byte);
    return hash;
}
