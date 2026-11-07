const std = @import("std");
const source = @import("agents/chain_source.zig");
const settings = @import("settings/types.zig");
const chain_fixture = @import("agents/chain_source_testing.zig");
const rpc = @import("evm/provider.zig");
const cosmos_json = @import("cosmos/types.zig");
const Compat = @import("cosmos/tendermint.zig").Compat;
const A = std.mem.Allocator;

// Actual public native validator announcement from the owned hypd0.38.12
// case, response hash e3a615...01a7a. No private signer inputs.
const signed_base64 = "CqoDCqUDCjsvaHlwZXJsYW5lLmNvcmUu" ++
    "aW50ZXJjaGFpbl9zZWN1cml0eS52MS5N" ++
    "c2dBbm5vdW5jZVZhbGlkYXRvchLlAgoo" ++
    "YjA1YjZhMGFhMTEyYjYxYTdhYTE2YzE5" ++
    "Y2FjMjdkOTcwNjkyOTk1ZRJEZmlsZTov" ++
    "Ly9wcml2YXRlL3RtcC96Y24tcy1mNjY1" ++
    "LTIwMjYxMTA3LXYyL3RtcC8udG1wQmlH" ++
    "SzR6L2NoZWNrcG9pbnQaggFiZjczNzdi" ++
    "MjlhZWJlZDQ4YmI1OWIzZTViNWIyNmUw" ++
    "NTIxMjU2ODcyNGJiMjZkNjZiYWIwMmM1" ++
    "ZGIzYWVkMWU4MjJhMTM3ODBlYWQ2ZTMw" ++
    "MTJlZmE2OTRmMGMwZTYxZWExNDk1NTkw" ++
    "YTBiMzQxMjY2YTQ1OWYzZmIzODQ2Njc3" ++
    "NTFiIkIweDY4Nzk3MDY1NzI2YzYxNmU2" ++
    "NTAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw" ++
    "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAq" ++
    "Kmh5cDFodmc3enNucmo2aDI5cTlzczU3" ++
    "N21ocnhhMDRybjk0aHYyY20yZRh3EmUK" ++
    "TgpGCh8vY29zbW9zLmNyeXB0by5zZWNw" ++
    "MjU2azEuUHViS2V5EiMKIQPJKO9xn1NS" ++
    "NQ+PpEDjEYrsuEpTDdtPdeBAjPcfUyW0" ++
    "6RIECgIIARITCg0KBHVoeXASBTIyNDI5" ++
    "EI7sBhpAuCquknDD6N6jRZ7IF+GZVmMn" ++
    "NuKx2OeUSdz38Ol9XrJIKdhiP+huOd1J" ++
    "/AHgWlNWJ525JGUhw9FYe6Ok7+cHFQ==";
const committed_json = "{\"check_tx\":{\"code\":0,\"gas_wante" ++
    "d\":\"112142\",\"gas_used\":\"62713\"}," ++
    "\"tx_result\":{\"code\":0,\"gas_wante" ++
    "d\":\"112142\",\"gas_used\":\"71922\"}," ++
    "\"hash\":\"7B1DC539D53453B100C3E4A3" ++
    "88F68E9E09C8C76F2FA12AFD6C8E5506" ++
    "F0925A90\",\"height\":\"20\"}";

const Exchange = struct {
    field: []const u8 = "tx_result",
    check_code: u8 = 0,
    result_code: u8 = 0,
    wrong_hash: bool = false,
    zero_height: bool = false,
    calls: usize = 0,
    fn fetch(raw: *anyopaque, a: A, body: []const u8, _: rpc.Options) !rpc.WireResponse {
        const self: *Exchange = @ptrCast(@alignCast(raw));
        var request = try std.json.parseFromSlice(std.json.Value, a, body, .{});
        defer request.deinit();
        try std.testing.expectEqualStrings("broadcast_tx_commit", request.value.object.get("method").?.string);
        try std.testing.expectEqualStrings(signed_base64, request.value.object.get("params").?.object.get("tx").?.string);
        var response = try std.json.parseFromSlice(std.json.Value, a, committed_json, .{ .allocate = .alloc_always });
        defer response.deinit();
        const value = &response.value;
        if (!std.mem.eql(u8, self.field, "tx_result")) {
            const result = value.object.get("tx_result").?;
            _ = value.object.swapRemove("tx_result");
            try value.object.put(self.field, result);
        }
        value.object.getPtr("check_tx").?.object.getPtr("code").?.* = .{ .integer = self.check_code };
        value.object.getPtr(self.field).?.object.getPtr("code").?.* = .{ .integer = self.result_code };
        if (self.wrong_hash) value.object.getPtr("hash").?.* = .{ .string = "00" ** 32 };
        if (self.zero_height) value.object.getPtr("height").?.* = .{ .string = "0" };
        const bytes = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = request.value.object.get("id").?, .result = value.* }, .{});
        self.calls += 1;
        return .{ .bytes = bytes, .len = bytes.len };
    }
};
fn chain(native: bool, mode: ?[]const u8) settings.Chain {
    var result = chain_fixture.chainFor(&.{"http://127.0.0.1:1"});
    result.protocol = if (native) .cosmosnative else .cosmos;
    result.chain_id = "hyperlane-local";
    result.grpc_urls = &.{"http://127.0.0.1:2"};
    const conf: settings.Cosmos = .{ .chain_id = "hyperlane-local", .bech32_prefix = "hyp", .gas_price = .{ .amount = "0.2", .denom = "uhyp" }, .contract_address_bytes = 20, .gas_multiplier = 1.35, .compat_mode = mode, .canonical_asset = "uhyp" };
    result.connection = if (native) .{ .cosmosnative = conf } else .{ .cosmos = conf };
    return result;
}
fn broadcast(native: bool, mode: ?[]const u8, exchange: *Exchange) !Compat {
    const a = std.testing.allocator;
    var conf = chain(native, mode);
    const library = try @import("evm/pool_testing.zig").nativeLibrary(a);
    defer a.free(library);
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    const resources = try source.Resources.open(a, &conf, &env, .{ .curl_library = library, .allow_insecure_loopback = true, .exchange = .{ .context = exchange, .fetch_fn = Exchange.fetch } });
    defer resources.deinit();
    const decoder = std.base64.standard.Decoder;
    const bytes = try a.alloc(u8, try decoder.calcSizeForSlice(signed_base64));
    defer a.free(bytes);
    try decoder.decode(bytes, signed_base64);
    var response = try resources.clients.cosmos.tendermint.broadcastCommit(bytes);
    defer response.deinit();
    try std.testing.expectEqual(@as(u64, 20), try cosmos_json.uint(try cosmos_json.field(response.value(), "height")));
    return resources.clients.cosmos.tendermint.compat;
}
test "Cosmos compatibility omitted mode commits actual native announcement dialect" {
    for ([_]bool{ false, true }) |native| {
        var exchange: Exchange = .{};
        try std.testing.expectEqual(Compat.v038, try broadcast(native, null, &exchange));
        try std.testing.expectEqual(@as(usize, 1), exchange.calls);
    }
}
test "Cosmos compatibility explicit selected dialect does not fall back to another response field" {
    for ([_]struct { mode: []const u8, compat: Compat, field: []const u8 }{
        .{ .mode = "0.34", .compat = .v034, .field = "deliver_tx" },
        .{ .mode = "0.37", .compat = .v037, .field = "deliver_tx" },
        .{ .mode = "0.38", .compat = .v038, .field = "tx_result" },
        .{ .mode = "v0.34", .compat = .v034, .field = "deliver_tx" },
        .{ .mode = "v0.37", .compat = .v037, .field = "deliver_tx" },
        .{ .mode = "v0.38", .compat = .v038, .field = "tx_result" },
        .{ .mode = "vv0.38", .compat = .v038, .field = "tx_result" },
    }) |case| for ([_]bool{ false, true }) |native| {
        var exchange: Exchange = .{ .field = case.field };
        try std.testing.expectEqual(case.compat, try broadcast(native, case.mode, &exchange));
        exchange.field = if (std.mem.eql(u8, case.field, "tx_result")) "deliver_tx" else "tx_result";
        try std.testing.expectError(error.MissingCosmosField, broadcast(native, case.mode, &exchange));
    };
}
test "Cosmos compatibility selected client preserves native commit check result hash and height guards" {
    for ([_]bool{ false, true }) |native| {
        var exchange: Exchange = .{ .check_code = 14 };
        try std.testing.expectError(error.CosmosCheckTxRejected, broadcast(native, null, &exchange));
        exchange = .{ .result_code = 17 };
        try std.testing.expectError(error.CosmosDeliverTxFailed, broadcast(native, null, &exchange));
        exchange = .{ .wrong_hash = true };
        try std.testing.expectError(error.WrongCosmosTxHash, broadcast(native, null, &exchange));
        exchange = .{ .zero_height = true };
        try std.testing.expectError(error.InvalidCosmosHeight, broadcast(native, null, &exchange));
        for ([_][]const u8{ "", "0.35", "0.39", "V0.38", " 0.38", "0.38 ", "v" }) |mode| {
            exchange = .{};
            try std.testing.expectError(error.InvalidCosmosCompatMode, broadcast(native, mode, &exchange));
            try std.testing.expectEqual(@as(usize, 0), exchange.calls);
        }
    }
}
