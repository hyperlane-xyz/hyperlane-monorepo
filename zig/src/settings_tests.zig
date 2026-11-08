const settings = @import("settings/root.zig");
const std = @import("std");
test "committed configs select Ethereum relayer without reading process environment" {
    var s = try settings.Settings.load(std.testing.allocator, .relayer, .{ .defaults_dir = defaultsDir(), .arguments = &.{"--relayChains=ethereum"} });
    defer s.deinit();
    try std.testing.expectEqual(@as(u32, 1), s.chains[0].domain);
    try std.testing.expectEqual(settings.Protocol.ethereum, s.chains[0].protocol);
}
test "all committed chain settings and validator scraper roles parse with explicit sources" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var merged = std.StringHashMap(void).init(a);
    for ([_][]const u8{ "mainnet_config.json", "testnet_config.json", "test_sealevel_config.json" }) |file| {
        const path = try std.fs.path.join(a, &.{ defaultsDir(), file });
        const data = try std.fs.cwd().readFileAlloc(a, path, 4 * 1024 * 1024);
        const parsed = try std.json.parseFromSlice(std.json.Value, a, data, .{});
        var it = parsed.value.object.get("chains").?.object.iterator();
        while (it.next()) |e| try merged.put(e.key_ptr.*, {});
    }
    var it = merged.keyIterator();
    while (it.next()) |name| {
        const arg = try std.fmt.allocPrint(a, "--relayChains={s}", .{name.*});
        var s = settings.Settings.load(std.testing.allocator, .relayer, .{ .defaults_dir = defaultsDir(), .arguments = &.{arg} }) catch |err| {
            std.debug.print("chain {s}: {s}\n", .{ name.*, @errorName(err) });
            return err;
        };
        defer s.deinit();
        try std.testing.expectEqualStrings(name.*, s.chains[0].name);
    }
    var validator = try settings.Settings.load(std.testing.allocator, .validator, .{ .defaults_dir = defaultsDir(), .arguments = &.{ "--originChainName=ethereum", "--validator.key=0x11111111111111111111111111111111" ++ "11111111111111111111111111111111", "--checkpointSyncer.type=localStorage", "--checkpointSyncer.path=/tmp/public-fixture", "--leightweigt", "--websocketUrl=wss://example.com" } });
    defer validator.deinit();
    try std.testing.expect(validator.role.validator.lightweight);
    try std.testing.expectEqual(@as(u64, 2), validator.role.validator.interval);
    var scraper = try settings.Settings.load(std.testing.allocator, .scraper, .{ .defaults_dir = defaultsDir(), .arguments = &.{ "--chainsToScrape=ethereum,solanamainnet", "--db=postgresql://localhost/disposable" } });
    defer scraper.deinit();
    try std.testing.expectEqual(@as(usize, 2), scraper.chains.len);
}
fn equalJson(a: std.json.Value, b: std.json.Value) bool {
    if (std.meta.activeTag(a) != std.meta.activeTag(b)) return false;
    return switch (a) {
        .null => true,
        .bool => |v| v == b.bool,
        .integer => |v| v == b.integer,
        .float => |v| v == b.float,
        .string => |v| std.mem.eql(u8, v, b.string),
        .number_string => |v| std.mem.eql(u8, v, b.number_string),
        .array => |xs| blk: {
            if (xs.items.len != b.array.items.len) break :blk false;
            for (xs.items, b.array.items) |x, y| {
                if (!equalJson(x, y)) break :blk false;
            }
            break :blk true;
        },
        .object => |xs| blk: {
            if (xs.count() != b.object.count()) break :blk false;
            var it = xs.iterator();
            while (it.next()) |entry| {
                const other = b.object.get(entry.key_ptr.*) orelse break :blk false;
                if (!equalJson(entry.value_ptr.*, other)) break :blk false;
            }
            break :blk true;
        },
    };
}
test "15 production Rust config source differential fixtures" {
    const config = @import("config.zig");
    const fixture_bytes = try @import("testing/fixture.zig").bytes(std.testing.allocator, @embedFile("settings/fixtures/merge.jsonl.gz"), 16 * 1024 * 1024);
    defer std.testing.allocator.free(fixture_bytes);
    var lines = std.mem.tokenizeScalar(u8, fixture_bytes, '\n');
    while (lines.next()) |line| {
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const p = try std.json.parseFromSlice(std.json.Value, a, line, .{ .allocate = .alloc_always });
        const obj = p.value.object;
        const expected = obj.get("expected").?.object;
        var temp = std.testing.tmpDir(.{});
        defer temp.cleanup();
        var layers: std.array_list.Managed([]const u8) = .init(a);
        if (obj.get("layers")) |ls| {
            for (ls.array.items, 0..) |layer, i| {
                const name = try std.fmt.allocPrint(a, "{d}.json", .{i});
                try temp.dir.writeFile(.{ .sub_path = name, .data = try std.json.Stringify.valueAlloc(a, layer, .{}) });
                try layers.append(try temp.dir.realpathAlloc(a, name));
            }
        }
        var env: std.array_list.Managed(config.EnvironmentEntry) = .init(a);
        if (obj.get("environment")) |e| {
            var it = e.object.iterator();
            while (it.next()) |entry| try env.append(.{ .key = entry.key_ptr.*, .value = entry.value_ptr.string });
        }
        var args: std.array_list.Managed([]const u8) = .init(a);
        if (obj.get("arguments")) |v| {
            for (v.array.items) |arg| try args.append(arg.string);
        }
        var cfg = config.Config.load(std.testing.allocator, .{ .defaults = layers.items, .environment = env.items, .arguments = args.items }) catch |err| {
            if (expected.get("ok").?.bool) {
                std.debug.print("merge fixture {s}: {s}\n", .{ obj.get("name").?.string, @errorName(err) });
                return err;
            }
            continue;
        };
        defer cfg.deinit();
        try std.testing.expect(expected.get("ok").?.bool);
        if (!equalJson(expected.get("value").?, cfg.root)) {
            std.debug.print("merge mismatch {s}\n", .{obj.get("name").?.string});
            return error.MergeMismatch;
        }
    }
}

fn defaultsDir() []const u8 {
    std.fs.cwd().access("rust/main/config", .{}) catch return "../rust/main/config";
    return "rust/main/config";
}
test "role selection deduplicates and numeric parser rejects Rust-invalid underscore and hex strings" {
    var s = try settings.Settings.load(std.testing.allocator, .relayer, .{ .defaults_dir = defaultsDir(), .arguments = &.{"--relayChains=ethereum,ethereum"} });
    defer s.deinit();
    try std.testing.expectEqual(@as(usize, 1), s.chains.len);
    try std.testing.expectError(error.InvalidConfigInteger, settings.Settings.load(std.testing.allocator, .relayer, .{ .defaults_dir = defaultsDir(), .arguments = &.{ "--relayChains=ethereum", "--metricsPort=9_090" } }));
    try std.testing.expectError(error.InvalidConfigInteger, settings.Settings.load(std.testing.allocator, .relayer, .{ .defaults_dir = defaultsDir(), .arguments = &.{ "--relayChains=ethereum", "--metricsPort=0x2382" } }));
    try std.testing.expectError(error.KnownDomainIdMismatch, settings.Settings.load(std.testing.allocator, .relayer, .{ .defaults_dir = defaultsDir(), .arguments = &.{ "--relayChains=ethereum", "--chains.ethereum.domainId=2" } }));
    try std.testing.expectError(error.IdentityRequiresSealevel, settings.Settings.load(std.testing.allocator, .relayer, .{ .defaults_dir = defaultsDir(), .arguments = &.{ "--relayChains=ethereum", "--chains.ethereum.identity.key=0x11111111111111111111111111111111" ++ "11111111111111111111111111111111" } }));
}
fn expandFixture(a: std.mem.Allocator, v: std.json.Value) anyerror!std.json.Value {
    if (v == .object) {
        if (v.object.count() == 1) {
            if (v.object.get("__chunks__")) |parts| {
                var list: std.array_list.Managed(u8) = .init(a);
                for (parts.array.items) |part| try list.appendSlice(part.string);
                return .{ .string = try list.toOwnedSlice() };
            }
        }
        var map = std.json.ObjectMap.init(a);
        var it = v.object.iterator();
        while (it.next()) |entry| try map.put(entry.key_ptr.*, try expandFixture(a, entry.value_ptr.*));
        return .{ .object = map };
    }
    if (v == .array) {
        var items: std.array_list.Managed(std.json.Value) = .init(a);
        for (v.array.items) |item| try items.append(try expandFixture(a, item));
        return .{ .array = items };
    }
    return v;
}
fn expectedInt(comptime T: type, obj: std.json.Value, key: []const u8) !T {
    return (@import("settings/value.zig").View{ .value = obj.object.get(key).? }).int(T);
}
fn compareRole(s: *const settings.Settings, expected: std.json.Value) !void {
    const base = expected.object.get("base").?;
    try std.testing.expectEqual(try expectedInt(u16, base, "metrics_port"), s.metrics_port);
    const chains = base.object.get("chains").?.array.items;
    try std.testing.expectEqual(chains.len, s.chains.len);
    for (chains) |chain| {
        const c = s.chainByName(chain.object.get("name").?.string) orelse return error.MissingChain;
        try std.testing.expectEqual(try expectedInt(u32, chain, "domain"), c.domain);
        try std.testing.expect(std.ascii.eqlIgnoreCase(chain.object.get("protocol").?.string, @tagName(c.protocol)));
        try std.testing.expectEqual(try expectedInt(u32, chain, "confirmations"), c.confirmations);
        try std.testing.expectEqual(try expectedInt(i64, chain, "index_from"), c.index.from);
        try std.testing.expectEqual(try expectedInt(u32, chain, "index_chunk"), c.index.chunk);
        try std.testing.expectEqual(try expectedInt(u64, chain, "index_interval"), c.index.interval);
        try std.testing.expectEqualStrings(chain.object.get("technical_stack").?.string, @tagName(c.technical_stack));
    }
    switch (s.role) {
        .validator => |v| {
            try std.testing.expectEqual(try expectedInt(u64, expected, "interval"), v.interval);
            try std.testing.expectEqual(expected.object.get("lightweight").?.bool, v.lightweight);
            try std.testing.expectEqual(expected.object.get("allow_public_rpcs").?.bool, v.allow_public_rpcs);
            try std.testing.expectEqual(try expectedInt(u64, expected, "max_sign_concurrency"), v.max_sign_concurrency);
            try std.testing.expectEqual(try expectedInt(usize, expected, "rpc_count"), v.rpcs.len);
        },
        .relayer => |r| {
            try std.testing.expectEqual(try expectedInt(u32, expected, "max_message_retries"), r.max_message_retries);
            try std.testing.expectEqual(try expectedInt(usize, expected, "gas_policy_count"), r.gas_payment_enforcement.len);
            try std.testing.expectEqual(expected.object.get("allow_local_checkpoint_syncers").?.bool, r.allow_local_checkpoint_syncers);
            try std.testing.expectEqual(expected.object.get("allow_contract_call_caching").?.bool, r.allow_contract_call_caching);
        },
        .scraper => |r| {
            try std.testing.expectEqual(try expectedInt(u32, expected, "db_max_connections"), r.db_max_connections);
            try std.testing.expectEqual(try expectedInt(u32, expected, "db_acquire_timeout_ms"), r.db_acquire_timeout_ms);
        },
    }
}
test "62 actual production Rust role parser differential fixtures" {
    const config = @import("config.zig");
    const fixture_bytes = try @import("testing/fixture.zig").bytes(std.testing.allocator, @embedFile("settings/fixtures/roles.jsonl.gz"), 16 * 1024 * 1024);
    defer std.testing.allocator.free(fixture_bytes);
    var lines = std.mem.tokenizeScalar(u8, fixture_bytes, '\n');
    while (lines.next()) |line| {
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const parsed = try std.json.parseFromSlice(std.json.Value, a, line, .{ .allocate = .alloc_always });
        const fixture = try expandFixture(a, parsed.value);
        const obj = fixture.object;
        const expected = obj.get("expected").?.object;
        var temp = std.testing.tmpDir(.{});
        defer temp.cleanup();
        try temp.dir.writeFile(.{ .sub_path = "role.json", .data = try std.json.Stringify.valueAlloc(a, obj.get("overrides").?, .{}) });
        const file = try temp.dir.realpathAlloc(a, "role.json");
        var env: std.array_list.Managed(config.EnvironmentEntry) = .init(a);
        try env.append(.{ .key = "CONFIG_FILES", .value = file });
        var eit = obj.get("environment").?.object.iterator();
        while (eit.next()) |entry| try env.append(.{ .key = entry.key_ptr.*, .value = entry.value_ptr.string });
        var args: std.array_list.Managed([]const u8) = .init(a);
        for (obj.get("arguments").?.array.items) |arg| try args.append(arg.string);
        var settings_value = settings.Settings.load(std.testing.allocator, std.meta.stringToEnum(settings.Role, obj.get("role").?.string).?, .{ .defaults_dir = defaultsDir(), .environment = env.items, .arguments = args.items }) catch |err| {
            if (expected.get("ok").?.bool) {
                std.debug.print("role fixture {s}: {s}\n", .{ obj.get("name").?.string, @errorName(err) });
                return err;
            }
            continue;
        };
        defer settings_value.deinit();
        if (!expected.get("ok").?.bool) {
            std.debug.print("Rust rejected but Zig accepted {s}\n", .{obj.get("name").?.string});
            return error.RoleAcceptanceMismatch;
        }
        compareRole(&settings_value, expected.get("value").?) catch |err| {
            std.debug.print("role summary mismatch {s}\n", .{obj.get("name").?.string});
            return err;
        };
    }
}
