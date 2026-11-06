const std = @import("std");
const Adapter = @import("agents/scraper/aleo.zig").Adapter;
const src = @import("agents/scraper/source.zig");
const events = @import("aleo/events.zig");
const provider = @import("aleo/provider.zig");
const rest = @import("aleo/rest.zig");
const crypto = @import("aleo/crypto.zig");
const mock = @import("cloud/testing.zig");
const json = @import("net/json_rpc.zig");
const A = std.mem.Allocator;
const Decoder = struct {
    native: events.NativeDecoder,
    target: []const u8,
    hook_manager: []const u8,
    gas_key: [32]u8,
    tree_key: [32]u8,
    fn interface(self: *Decoder) events.Decoder {
        return .{ .context = self, .decode_fn = decode };
    }
    fn keyValue(a: A, key: [32]u8) !json.Value {
        var array = std.json.Array.init(a);
        for (key) |byte| try array.append(.{ .integer = byte });
        return .{ .array = array };
    }
    fn decode(context: *anyopaque, a: A, wire: []const u8) !events.Block {
        const self: *Decoder = @ptrCast(@alignCast(context));
        var block = try self.native.interface().decode(a, wire);
        errdefer block.deinit();
        for ((try json.field(block.value, "transactions")).array.items) |*transaction| {
            if (!std.mem.eql(u8, self.target, try json.string(try json.field(transaction.*, "id")))) continue;
            var transition = std.json.ObjectMap.init(a);
            try transition.put("program_id", .{ .string = self.hook_manager });
            const transitions = transaction.object.getPtr("transitions") orelse return error.MissingAleoFixtureTransitions;
            try transitions.array.append(.{ .object = transition });
            const keys = transaction.object.getPtr("finalize_keys") orelse return error.MissingAleoFixtureFinalizeKeys;
            try keys.array.append(try keyValue(a, self.gas_key));
            try keys.array.append(try keyValue(a, self.tree_key));
        }
        return block;
    }
};
pub fn setting(a: A, name: []const u8) ![]u8 {
    return std.process.getEnvVarOwned(a, name) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => error.SkipZigTest,
        else => err,
    };
}
fn mappingUrl(a: A, program: []const u8, mapping: []const u8, key: []const u8) ![]u8 {
    return rest.appendUrl(a, "https://fixture", 1, &.{ "program", program, "mapping", mapping, key }, &.{});
}
pub fn withAuthorityFixture(a: A, native: *crypto.Crypto, executable: []const u8, vm_path: []const u8, context: anytype, comptime run: anytype) !void {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const memory = arena.allocator();
    const path = blk: {
        std.fs.cwd().access("rust/main/config", .{}) catch break :blk try memory.dupe(u8, "../rust/main/chains/hyperlane-aleo/src/indexer/mock_responses/delivery_block.json");
        break :blk try memory.dupe(u8, "rust/main/chains/hyperlane-aleo/src/indexer/mock_responses/delivery_block.json");
    };
    const block = try std.fs.cwd().readFileAlloc(memory, path, 16 * 1024 * 1024);
    var raw = try std.json.parseFromSlice(std.json.Value, memory, block, .{ .allocate = .alloc_always });
    defer raw.deinit();
    const block_hash = try json.string(try json.field(raw.value, "block_hash"));
    var transaction_bytes: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&transaction_bytes, "042cb7ff55639abdda73ace1fbf728dc4" ++ "8a314137842274742ae64060cd4480c");
    const transaction = try native.idText(memory, .transaction, transaction_bytes);
    const mailbox_program = "test_mailbox.aleo";
    const hook_program = "test_hook_manager.aleo";
    const logical_hook = try native.programAddress("logical_hook.aleo");
    const logical_igp = try native.programAddress("logical_igp.aleo");
    const hook_text = try native.addressText(memory, logical_hook);
    const igp_text = try native.addressText(memory, logical_igp);
    const gas_key_text = try std.fmt.allocPrint(memory, "{{hook: {s}, index: 0u32}}", .{igp_text});
    const tree_key_text = try std.fmt.allocPrint(memory, "{{hook: {s}, index: 0u32}}", .{hook_text});
    const gas_height_text = try std.fmt.allocPrint(memory, "{{hook: {s}, block_height: 12618649u32}}", .{igp_text});
    const tree_height_text = try std.fmt.allocPrint(memory, "{{hook: {s}, block_height: 12618649u32}}", .{hook_text});
    const gas_key = try native.mappingKeyId(hook_program, "gas_payment_events", gas_key_text);
    const tree_key = try native.mappingKeyId(hook_program, "inserted_into_tree_events", tree_key_text);
    const find_suffix = try std.fmt.allocPrint(memory, "/find/blockHash/{s}", .{transaction});
    const block_suffix = try std.fmt.allocPrint(memory, "/block/hash/{s}", .{block_hash});
    const location = try std.json.Stringify.valueAlloc(memory, block_hash, .{});
    const gas_payload = try std.json.Stringify.valueAlloc(memory, "{id:[1u128,2u128],destination_domain:2000u32,gas_amount:1000u128,payment:2500u64,index:0u32}", .{});
    const tree_payload = try std.json.Stringify.valueAlloc(memory, "{id:[1u128,2u128],index:0u32}", .{});
    const steps = [_]mock.Step{
        .{ .method = .GET, .suffix = find_suffix, .response = location },
        .{ .method = .GET, .suffix = block_suffix, .response = block },
        .{ .method = .GET, .suffix = "/block/12618649", .response = block },
        .{ .method = .GET, .suffix = "/dispatch_event_index/12618649u32", .response = "null" },
        .{ .method = .GET, .suffix = "/process_event_index/12618649u32", .response = "null" },
        .{ .method = .GET, .suffix = try mappingUrl(memory, hook_program, "last_event_index", gas_height_text), .response = "\"0u32\"" },
        .{ .method = .GET, .suffix = try mappingUrl(memory, hook_program, "gas_payment_events", gas_key_text), .response = gas_payload },
        .{ .method = .GET, .suffix = try mappingUrl(memory, hook_program, "last_event_index", tree_height_text), .response = "\"0u32\"" },
        .{ .method = .GET, .suffix = try mappingUrl(memory, hook_program, "inserted_into_tree_events", tree_key_text), .response = tree_payload },
        .{ .method = .GET, .suffix = "/block/12618649", .response = block },
    };
    var script: mock.Mock = .{ .steps = &steps };
    var client: provider.Provider = .{ .client = try rest.Client.init(a, script.transport(), &.{.{ .url = "https://fixture" }}, 1), .native = native };
    var decoder: Decoder = .{ .native = .{ .executable = executable, .library = vm_path, .network = 1, .limits = .{ .timeout_ms = 30000 } }, .target = transaction, .hook_manager = hook_program, .gas_key = gas_key, .tree_key = tree_key };
    var adapter: Adapter = .{ .provider = &client, .configuration = .{ .mailbox = mailbox_program, .hook_manager = hook_program, .ism_manager = "test_ism_manager.aleo", .validator_announce = "test_validator_announce.aleo", .hook = logical_hook, .domain = 1617853565 }, .decoder = decoder.interface(), .paymaster = logical_igp };
    try run(context, &adapter, &script, transaction_bytes);
}
const Check = struct {
    fn run(_: void, adapter: *Adapter, script: *mock.Mock, transaction_bytes: [32]u8) !void {
        const a = std.testing.allocator;
        const native = adapter.provider.native;
        const source = adapter.interface();
        const authority = try source.transactionAuthority(undefined);
        const mailbox_emitter = try native.programAddress(adapter.configuration.mailbox);
        const hook_emitter = try native.programAddress(adapter.configuration.hook_manager);
        try std.testing.expectEqual(mailbox_emitter, authority.emitters.mailbox);
        try std.testing.expectEqual(hook_emitter, authority.emitters.hook);
        try std.testing.expectEqual(hook_emitter, authority.emitters.paymaster);
        try std.testing.expectEqual(.per_emitter_stream, authority.positions);
        try std.testing.expect(!std.mem.eql(u8, &hook_emitter, &adapter.configuration.hook));
        try std.testing.expect(!std.mem.eql(u8, &hook_emitter, &adapter.paymaster));
        var batch = try source.transactionEvents(a, .{0} ** 32 ++ transaction_bytes);
        defer batch.deinit();
        try script.expectDone();
        try std.testing.expectEqual(@as(usize, 2), batch.events.len);
        var gas = false;
        var tree = false;
        for (batch.events) |event| {
            try std.testing.expectEqual(@as(u64, 0), event.log_index);
            try std.testing.expectEqual(@as(?u32, 0), event.sequence);
            try std.testing.expectEqual(hook_emitter, event.address);
            try std.testing.expectEqualSlices(u8, &(.{0} ** 32 ++ transaction_bytes), &event.tx_hash.?);
            switch (event.data) {
                .gas => |payment| {
                    gas = true;
                    try std.testing.expectEqual(@as(u64, 2500), payment.payment);
                },
                .insertion => |insert| {
                    tree = true;
                    try std.testing.expectEqual(@as(u32, 0), insert.index);
                },
                else => return error.UnexpectedAleoAuthorityEvent,
            }
        }
        try std.testing.expect(gas and tree);
    }
};
test "Aleo authority uses actual program emitters and same-index gas and tree namespaces" {
    const a = std.testing.allocator;
    const crypto_path = try setting(a, "HYPERLANE_ALEO_CRYPTO_LIBRARY");
    defer a.free(crypto_path);
    const vm_path = try setting(a, "HYPERLANE_ALEO_VM_LIBRARY");
    defer a.free(vm_path);
    const executable = try setting(a, "HYPERLANE_ALEO_VM_WORKER");
    defer a.free(executable);
    var native = try crypto.Crypto.init(crypto_path);
    defer native.deinit();
    try withAuthorityFixture(a, &native, executable, vm_path, {}, Check.run);
}
