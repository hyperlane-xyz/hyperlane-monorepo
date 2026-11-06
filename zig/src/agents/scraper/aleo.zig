//! Concrete Aleo source: finalized block reconciliation and latest-only mapping
//! counters with their actual observed heights. No fabricated historical counts.
const std = @import("std");
const src = @import("source.zig");
const settings = @import("../../settings/types.zig");
const rest = @import("../../aleo/rest.zig");
const provider = @import("../../aleo/provider.zig");
const contracts = @import("../../aleo/contracts.zig");
const events = @import("../../aleo/events.zig");
const codec = @import("../../aleo/codec.zig");
const crypto = @import("../../aleo/crypto.zig");
const json = @import("../../net/json_rpc.zig");
const http = @import("../../cloud/http.zig");
const endpoint = @import("../../net/endpoint.zig");
pub const Adapter = struct {
    provider: *provider.Provider,
    configuration: contracts.Config,
    decoder: events.Decoder,
    paymaster: [32]u8,
    max_events: usize = 8192,
    max_bytes: usize = 64 * 1024 * 1024,
    max_blocks: u32 = 2000,
    pub fn interface(self: *Adapter) src.Source {
        return .{ .context = self, .header_fn = header, .events_fn = fetch, .transaction_fn = transactionEvents, .transaction_authority_fn = transactionAuthority, .tip_fn = tip, .stream_tip_fn = streamTip };
    }
    fn transactionAuthority(context: *anyopaque) !src.TransactionAuthority {
        const self = cast(context);
        const mailbox = try self.provider.native.programAddress(self.configuration.mailbox);
        const hook_manager = try self.provider.native.programAddress(self.configuration.hook_manager);
        return .{ .emitters = .{ .mailbox = mailbox, .hook = hook_manager, .paymaster = hook_manager }, .positions = .per_emitter_stream };
    }
    fn cast(context: *anyopaque) *Adapter {
        return @ptrCast(@alignCast(context));
    }
    fn header(context: *anyopaque, selector: src.Selector, _: bool) !src.Header {
        const self = cast(context);
        const height: u32 = switch (selector) {
            .height => |number| std.math.cast(u32, number) orelse return error.AleoHeightOverflow,
            else => try self.provider.height(),
        };
        const block = try self.provider.header(height);
        return .{ .height = block.height, .hash = block.hash, .parent = block.parent, .timestamp = block.timestamp };
    }
    fn tip(context: *anyopaque) !?u64 {
        return try cast(context).provider.height();
    }
    fn streamTip(context: *anyopaque, index: usize) !src.Tip {
        const self = cast(context);
        var chain: contracts.Contracts = .{ .provider = self.provider, .config = self.configuration };
        switch (index) {
            0, 1 => {
                const value = try chain.mailbox(true);
                return .{ .count = if (index == 0) value.count else value.processed, .tip = value.height orelse return error.MissingAleoMappingHeight };
            },
            3 => {
                const value = try chain.tree();
                return .{ .count = value.tree.count, .tip = value.height };
            },
            2 => {
                if (std.mem.allEqual(u8, &self.paymaster, 0)) return .{ .count = null, .tip = try self.provider.height() };
                const a = self.provider.client.allocator;
                const address = try self.provider.native.addressText(a, self.paymaster);
                defer a.free(address);
                var result = try self.provider.mapping(self.configuration.hook_manager, "igps", address, true);
                defer result.deinit();
                const value = result.value() orelse return error.UnknownAleoIgp;
                return .{ .count = try (try value.member("count")).number(u32), .tip = result.height orelse return error.MissingAleoMappingHeight };
            },
            else => return error.InvalidScraperStream,
        }
    }
    fn fetch(context: *anyopaque, allocator: std.mem.Allocator, from: u64, to: u64, _: [4]u32) !src.Batch {
        const self = cast(context);
        const first = std.math.cast(u32, from) orelse return error.AleoHeightOverflow;
        const last = std.math.cast(u32, to) orelse return error.AleoHeightOverflow;
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        var result: std.ArrayList(src.Event) = .empty;
        var bytes: usize = 0;
        const hook = try self.provider.native.addressText(a, self.configuration.hook);
        const igp = if (std.mem.allEqual(u8, &self.paymaster, 0)) null else try self.provider.native.addressText(a, self.paymaster);
        for ([_]events.Kind{ .dispatch, .delivery, .gas_payment, .insertion }) |kind| {
            if (kind == .gas_payment and igp == null) continue;
            var indexer: events.Indexer = .{ .provider = self.provider, .decoder = self.decoder, .program = if (kind == .dispatch or kind == .delivery) self.configuration.mailbox else self.configuration.hook_manager, .kind = kind, .hook = if (kind == .gas_payment) igp else hook, .domain = self.configuration.domain, .max_blocks = self.max_blocks, .max_events = self.max_events, .max_bytes = self.max_bytes };
            var batch = try indexer.fetch(allocator, first, last);
            defer batch.deinit();
            if (batch.items.len > self.max_events - result.items.len) return error.ScraperEventLimit;
            for (batch.items) |event| {
                var tx: [64]u8 = .{0} ** 64;
                tx[32..64].* = event.transaction;
                const data: src.EventData = switch (event.data) {
                    .dispatch => |message| blk: {
                        var owned = message;
                        owned.body = try a.dupe(u8, message.body);
                        break :blk .{ .dispatch = owned };
                    },
                    .delivery => |id| .{ .delivery = id },
                    .insertion => |value| .{ .insertion = .{ .message_id = value.id, .index = value.index } },
                    .gas_payment => |value| .{ .gas = .{ .message_id = value.id, .destination = value.destination, .gas = value.gas_amount, .payment = value.payment } },
                };
                const cost = @sizeOf(src.Event) + @as(usize, if (data == .dispatch) data.dispatch.body.len else 0);
                if (cost > self.max_bytes - bytes) return error.ScraperEventByteLimit;
                bytes += cost;
                try result.append(a, .{ .block_number = event.height, .block_hash = event.block_hash, .address = event.address, .tx_hash = if (std.mem.allEqual(u8, &tx, 0)) null else tx, .tx_index = event.transaction_index, .log_index = event.index, .sequence = event.index, .data = data });
            }
        }
        std.mem.sort(src.Event, result.items, {}, struct {
            fn less(_: void, left: src.Event, right: src.Event) bool {
                return if (left.block_number != right.block_number) left.block_number < right.block_number else if (left.tx_index != right.tx_index) left.tx_index < right.tx_index else left.log_index < right.log_index;
            }
        }.less);
        const owned_events = try result.toOwnedSlice(a);
        return .{ .arena = arena, .events = owned_events, .through = to };
    }
    fn mappingKey(_: *Adapter, a: std.mem.Allocator, kind: events.Kind, hook: ?[]const u8, index: u32) ![]u8 {
        if (kind == .dispatch or kind == .delivery) return std.fmt.allocPrint(a, "{d}u32", .{index});
        return std.fmt.allocPrint(a, "{{hook: {s}, index: {d}u32}}", .{ hook orelse return error.MissingAleoHook, index });
    }
    fn transactionEvents(context: *anyopaque, allocator: std.mem.Allocator, transaction_id: [64]u8) !src.Batch {
        const self = cast(context);
        if (!std.mem.allEqual(u8, transaction_id[0..32], 0) or std.mem.allEqual(u8, &transaction_id, 0)) return error.UnsupportedAleoTransactionId;
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const id = try self.provider.native.idText(a, .transaction, transaction_id[32..64].*);
        var location = try self.provider.client.get(&.{ "find", "blockHash", id }, &.{});
        defer location.deinit();
        const location_text = try json.string(location.value());
        const located_hash = try self.provider.native.id(.block, location_text);
        var response = try self.provider.client.get(&.{ "block", "hash", location_text }, &.{});
        defer response.deinit();
        const wire = try std.json.Stringify.valueAlloc(a, response.value(), .{});
        var decoded = try self.decoder.decode(a, wire);
        defer decoded.deinit();
        const height = try json.integer(u32, try json.field(decoded.value, "height"));
        const block_hash = try self.provider.native.id(.block, try json.string(try json.field(decoded.value, "hash")));
        if (!std.mem.eql(u8, &block_hash, &located_hash)) return error.NoncanonicalAleoTransaction;
        const canonical = try self.provider.header(height);
        if (!std.mem.eql(u8, &canonical.hash, &block_hash)) return error.NoncanonicalAleoTransaction;
        const transactions = try json.field(decoded.value, "transactions");
        if (transactions != .array or transactions.array.items.len > 8192) return error.AleoTransactionLimit;
        var target: ?json.Value = null;
        var target_position: ?usize = null;
        var target_accepted = false;
        var transaction_index: u32 = 0;
        for (transactions.array.items, 0..) |candidate, position| {
            const accepted = try json.field(candidate, "accepted");
            if (accepted != .bool) return error.InvalidAleoBlock;
            const transitions = try json.field(candidate, "transitions");
            if (transitions != .array) return error.InvalidAleoBlock;
            const candidate_id = try self.provider.native.id(.transaction, try json.string(try json.field(candidate, "id")));
            const candidate_index = try json.integer(u32, try json.field(candidate, "index"));
            if (!std.mem.eql(u8, &candidate_id, transaction_id[32..64])) continue;
            if (target != null) return error.DuplicateAleoTransaction;
            target = candidate;
            target_position = position;
            target_accepted = accepted.bool;
            transaction_index = candidate_index;
        }
        const actual = target orelse return error.MissingAleoTransaction;
        if (!target_accepted) return error.AleoTransactionRejected;
        const finalize_keys = try json.field(actual, "finalize_keys");
        if (finalize_keys != .array or finalize_keys.array.items.len > 65536) return error.AleoFinalizeLimit;
        const hook = try self.provider.native.addressText(a, self.configuration.hook);
        const igp = if (std.mem.allEqual(u8, &self.paymaster, 0)) null else try self.provider.native.addressText(a, self.paymaster);
        var result: std.ArrayList(src.Event) = .empty;
        var bytes: usize = 0;
        for ([_]events.Kind{ .dispatch, .delivery, .gas_payment, .insertion }) |kind| {
            if (kind == .gas_payment and igp == null) continue;
            const program = if (kind == .dispatch or kind == .delivery) self.configuration.mailbox else self.configuration.hook_manager;
            var target_matches = false;
            var transitions: usize = 0;
            for (transactions.array.items, 0..) |candidate, position| {
                for ((try json.field(candidate, "transitions")).array.items) |transition| {
                    if (!std.mem.eql(u8, program, try json.string(try json.field(transition, "program_id")))) continue;
                    transitions += 1;
                    if (position == target_position.?) target_matches = true;
                }
            }
            if (!target_matches) continue;
            if (transitions > 8192) return error.AleoCandidateLimit;
            const index_mapping = switch (kind) {
                .dispatch => "dispatch_event_index",
                .delivery => "process_event_index",
                else => "last_event_index",
            };
            const index_key = if (kind == .dispatch or kind == .delivery) try std.fmt.allocPrint(a, "{d}u32", .{height}) else try std.fmt.allocPrint(a, "{{hook: {s}, block_height: {d}u32}}", .{ (if (kind == .gas_payment) igp else hook) orelse return error.MissingAleoHook, height });
            var latest = try self.provider.mapping(program, index_mapping, index_key, false);
            defer latest.deinit();
            const latest_value = latest.value() orelse continue;
            const last = try latest_value.number(u32);
            var possible = std.AutoHashMap([32]u8, u32).init(a);
            const value_mapping = switch (kind) {
                .dispatch => "dispatch_events",
                .delivery => "process_events",
                .insertion => "inserted_into_tree_events",
                .gas_payment => "gas_payment_events",
            };
            for (0..transitions) |i| {
                const index = last -| (std.math.cast(u32, i) orelse return error.AleoCandidateLimit);
                const key_text = try self.mappingKey(a, kind, if (kind == .gas_payment) igp else hook, index);
                try possible.put(try self.provider.native.mappingKeyId(program, value_mapping, key_text), index);
            }
            var seen = std.AutoHashMap(u32, void).init(a);
            const emitter = try self.provider.native.programAddress(program);
            for (finalize_keys.array.items) |raw| {
                if (raw != .array or raw.array.items.len != 32) return error.InvalidAleoFinalizeKey;
                var key: [32]u8 = undefined;
                for (raw.array.items, &key) |byte, *out| out.* = try json.integer(u8, byte);
                const index = possible.get(key) orelse continue;
                const duplicate = try seen.getOrPut(index);
                if (duplicate.found_existing) continue;
                const key_text = try self.mappingKey(a, kind, if (kind == .gas_payment) igp else hook, index);
                var mapped = try self.provider.mapping(program, value_mapping, key_text, false);
                defer mapped.deinit();
                const payload = mapped.value() orelse return error.MissingAleoImmutableEvent;
                const data: events.Decoded = switch (kind) {
                    .dispatch => blk: {
                        const message = try codec.decodeMessage(a, payload);
                        if (message.nonce != index or message.origin != self.configuration.domain) return error.InconsistentAleoDispatch;
                        break :blk .{ .dispatch = message };
                    },
                    .delivery => .{ .delivery = try payload.hash() },
                    .insertion => blk: {
                        const insert = try codec.insertion(payload);
                        if (insert.index != index) return error.InconsistentAleoEventIndex;
                        break :blk .{ .insertion = insert };
                    },
                    .gas_payment => blk: {
                        const payment = try codec.gasPayment(payload);
                        if (payment.index != index) return error.InconsistentAleoEventIndex;
                        break :blk .{ .gas_payment = payment };
                    },
                };
                const event_data: src.EventData = switch (data) {
                    .dispatch => |message| .{ .dispatch = message },
                    .delivery => |message_id| .{ .delivery = message_id },
                    .insertion => |insert| .{ .insertion = .{ .message_id = insert.id, .index = insert.index } },
                    .gas_payment => |payment| .{ .gas = .{ .message_id = payment.id, .destination = payment.destination, .gas = payment.gas_amount, .payment = payment.payment } },
                };
                const cost = @sizeOf(src.Event) + @as(usize, if (event_data == .dispatch) event_data.dispatch.body.len else 0);
                if (cost > self.max_bytes - bytes) return error.ScraperEventByteLimit;
                if (result.items.len >= self.max_events) return error.ScraperEventLimit;
                bytes += cost;
                try result.append(a, .{ .block_number = height, .block_hash = block_hash, .address = emitter, .tx_hash = transaction_id, .tx_index = transaction_index, .log_index = index, .sequence = index, .data = event_data });
            }
        }
        const after = try self.provider.header(height);
        if (!std.mem.eql(u8, &after.hash, &canonical.hash)) return error.NoncanonicalAleoTransaction;
        std.mem.sort(src.Event, result.items, {}, struct {
            fn less(_: void, left: src.Event, right: src.Event) bool {
                return left.log_index < right.log_index;
            }
        }.less);
        const owned = try result.toOwnedSlice(a);
        return .{ .arena = arena, .events = owned, .through = height };
    }
};
pub const Native = struct { executable: []const u8, library: []const u8, limits: @import("../../aleo/worker.zig").Limits = .{} };
pub const Factory = struct {
    arena: std.heap.ArenaAllocator,
    endpoints: []endpoint.OwnedEndpoint,
    provider: provider.Provider,
    decoder: events.NativeDecoder,
    configuration: contracts.Config,
    paymaster: [32]u8,
    max_blocks: u32,
    source: ?Adapter = null,
    /// Keep factory at its final address after interface(); native crypto is borrowed.
    pub fn init(a: std.mem.Allocator, transport: http.Transport, native: *crypto.Crypto, chain: *const settings.Chain, worker: Native) !Factory {
        if (chain.protocol != .aleo) return error.WrongScraperProtocol;
        if (chain.index.mode != .block) return error.UnsupportedAleoSequenceIndex;
        if (chain.index.chunk == 0) return error.InvalidScraperChunk;
        var arena = std.heap.ArenaAllocator.init(a);
        errdefer arena.deinit();
        const alloc = arena.allocator();
        const owners = try alloc.alloc(endpoint.OwnedEndpoint, chain.rpc_urls.len);
        var initialized: usize = 0;
        errdefer for (owners[0..initialized]) |*item| item.deinit();
        const urls = try alloc.alloc(rest.Endpoint, owners.len);
        for (chain.rpc_urls, owners, urls) |url, *owner, *item| {
            owner.* = try endpoint.OwnedEndpoint.parse(a, url);
            initialized += 1;
            item.* = owner.endpoint;
        }
        const connection = chain.connection.aleo;
        const network = try std.fmt.parseInt(u16, chain.chain_id, 10);
        var client: provider.Provider = .{ .client = try rest.Client.init(a, transport, urls, network), .native = native };
        const config: contracts.Config = .{ .mailbox = try alloc.dupe(u8, connection.mailbox_program), .hook_manager = try alloc.dupe(u8, connection.hook_manager_program), .ism_manager = try alloc.dupe(u8, connection.ism_manager_program), .validator_announce = try alloc.dupe(u8, connection.validator_announce_program), .hook = chain.contracts.merkle_tree_hook, .domain = chain.domain };
        _ = try contracts.Contracts.init(&client, config);
        const worker_executable = try alloc.dupe(u8, worker.executable);
        const worker_library = try alloc.dupe(u8, worker.library);
        return .{ .arena = arena, .endpoints = owners, .provider = client, .decoder = .{ .executable = worker_executable, .library = worker_library, .network = network, .limits = worker.limits }, .configuration = config, .paymaster = chain.contracts.interchain_gas_paymaster, .max_blocks = chain.index.chunk };
    }
    pub fn interface(self: *Factory) src.Source {
        if (self.source == null) self.source = .{ .provider = &self.provider, .configuration = self.configuration, .decoder = self.decoder.interface(), .paymaster = self.paymaster, .max_blocks = self.max_blocks };
        return self.source.?.interface();
    }
    pub fn deinit(self: *Factory) void {
        for (self.endpoints) |*item| item.deinit();
        self.arena.deinit();
        self.* = undefined;
    }
};
