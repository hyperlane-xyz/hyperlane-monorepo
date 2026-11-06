const std = @import("std");
const settings = @import("../settings/root.zig");
const Task = @import("validator_task.zig").Task;
const A = std.mem.Allocator;
test "validator constructors are allocation-only and announcement HTTP and scheduling are independent" {
    const a = std.testing.allocator;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const scratch = arena.allocator();
    const address = "0x0000000000000000000000000000000000000001";
    const key = try @import("../evm/codecs.zig").hexAlloc(scratch, &@as([32]u8, @splat(0x11)));
    const text = try std.json.Stringify.valueAlloc(scratch, .{ .originChainName = "publicfixture", .db = "/no-such-directory/public-validator-constructor/db", .validator = .{ .key = key }, .checkpointSyncer = .{ .type = "localStorage", .path = "/no-such-directory/public-validator-constructor/checkpoints" }, .chains = .{ .publicfixture = .{ .name = "publicfixture", .domainId = @as(u32, 3999999999), .chainId = @as(u32, 31337), .protocol = "ethereum", .rpcUrls = .{.{ .http = "http://127.0.0.1:1" }}, .mailbox = address, .merkleTreeHook = address, .validatorAnnounce = address, .interchainGasPaymaster = address } } }, .{});
    var config_arena = std.heap.ArenaAllocator.init(a);
    const raw = try std.json.parseFromSlice(std.json.Value, config_arena.allocator(), text, .{});
    const root = try @import("../config.zig").normalizedValue(config_arena.allocator(), raw.value);
    var configured = try settings.Settings.fromConfig(.{ .arena = config_arena, .root = root }, .validator);
    defer configured.deinit();
    const S = struct {
        fn run(allocator: A, s: *const settings.Settings) !void {
            const task = try Task.init(allocator, s, .{ .curl_library = "/no-such-library/public-validator-constructor" }, null, null);
            defer task.deinit();
            try std.testing.expect(task.database_owner.value == null and task.native == null and task.announcement.native == null);
            try std.testing.expect(task.http.native_curl == null and task.announcement.http.native_curl == null);
            try std.testing.expect(&task.http != &task.announcement.http);
            // A checkpoint conflict gates the independent announcement lane
            // before any DB/credential/network operation, including on startup.
            task.effects_halted.store(true, .release);
            var cancel: std.atomic.Value(bool) = .init(false);
            try std.testing.expectError(error.CheckpointEffectsHalted, task.announcement.tick(.{ .unix_ms = 1000, .monotonic_ms = 1000 }, &cancel));
            try std.testing.expect(task.database_owner.value == null and task.announcement.native == null);
            task.effects_halted.store(false, .release);
            const descriptors = task.descriptors();
            try std.testing.expectEqual(@as(usize, 2), descriptors.len);
            try std.testing.expectEqual(@import("../runtime/supervisor.zig").FailureAction.halt_all, descriptors[0].failure.?(error.ValidatorCursorInitializationExhausted));
            try std.testing.expect(task.criticalForChain(3999999999) == &task.critical);
            try std.testing.expect(task.criticalForChain(1) == null);
            try std.testing.expect(task.tip_cache == null and !task.critical.published);
            try std.testing.expect(descriptors[0].context != descriptors[1].context);
            try std.testing.expect(descriptors[1].wake == &task.mailbox.pending);
        }
    };
    try std.testing.checkAllAllocationFailures(a, S.run, .{&configured});
}
