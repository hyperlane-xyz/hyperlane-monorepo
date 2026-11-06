//! Real PostgreSQL catalog states on the runner's disposable migrated database.
const std = @import("std");
const pg = @import("postgres.zig");
const schema = @import("scraper_schema.zig");
const tasks = @import("../agents/scraper/task.zig");
const settings = @import("../settings/root.zig");
const fixture = @import("../evm/pool_testing.zig");
const a = std.testing.allocator;

fn fixtureInfo() ![]u8 {
    const info = try std.process.getEnvVarOwned(a, "ZIGGY_PG_FIXTURE");
    errdefer a.free(info);
    if (!std.mem.startsWith(u8, info, "host=127.0.0.1 port=") or std.mem.indexOf(u8, info, " dbname=ziggy user=ziggy ") == null) return error.NotIsolatedPostgresFixture;
    return info;
}
fn connect() !pg.Connection {
    const info = try fixtureInfo();
    defer a.free(info);
    return pg.Connection.connect(a, info, null);
}
fn catalog(connection: *pg.Connection) ![]u8 {
    var result = try connection.query("SELECT string_agg(indexname||':'||indexdef,E'\\n' ORDER BY indexname) AS definitions FROM pg_indexes WHERE schemaname='public'", &.{});
    defer result.deinit();
    return a.dupe(u8, try result.required(0, "definitions"));
}
fn rows(connection: *pg.Connection) !i64 {
    var result = try connection.query("SELECT count(*) AS count FROM scraper_head", &.{});
    defer result.deinit();
    return result.integer(0, "count");
}
fn rejection(connection: *pg.Connection, commands: []const []const u8, expected: anyerror) !void {
    var transaction = try connection.begin();
    defer transaction.deinit();
    for (commands) |command| try connection.execute(command, &.{});
    try std.testing.expectError(expected, schema.verifyFrontierIndexes(connection));
    try transaction.rollback();
    try schema.verifyFrontierIndexes(connection);
}

test "scraper schema accepts actual migration indexes in a read-only transaction without changing catalog" {
    var connection = try connect();
    defer connection.deinit();
    const before = try catalog(&connection);
    defer a.free(before);
    const head_rows = try rows(&connection);
    var transaction = try connection.begin();
    defer transaction.deinit();
    try connection.execute("SET TRANSACTION READ ONLY", &.{});
    try schema.verifyFrontierIndexes(&connection);
    try transaction.rollback();
    const after = try catalog(&connection);
    defer a.free(after);
    try std.testing.expectEqualStrings(before, after);
    try std.testing.expectEqual(head_rows, try rows(&connection));
}

test "scraper schema rejects every missing frontier and canonical gas index" {
    var connection = try connect();
    defer connection.deinit();
    const cases = .{
        .{ "DROP INDEX delivery_frontier_unenriched", error.InvalidDeliveryFrontierIndex },
        .{ "DROP INDEX gas_payment_frontier_unenriched", error.InvalidGasPaymentFrontierIndex },
        .{ "DROP INDEX gas_payment_frontier_height", error.InvalidGasPaymentHeightIndex },
        .{ "DROP INDEX gas_payment_block_log", error.InvalidGasPaymentIdentityIndex },
    };
    inline for (cases) |case| try rejection(&connection, &.{case[0]}, case[1]);
}

test "scraper schema rejects wrong definitions predicates expressions includes uniqueness and table authority" {
    var connection = try connect();
    defer connection.deinit();
    const definitions = [_][]const u8{
        "CREATE INDEX delivery_frontier_unenriched ON delivered_message(id,domain) WHERE destination_tx_id IS NULL AND block_hash IS NOT NULL",
        "CREATE INDEX delivery_frontier_unenriched ON delivered_message(domain,id) WHERE destination_tx_id IS NULL",
        "CREATE INDEX delivery_frontier_unenriched ON delivered_message((domain+0),id) WHERE destination_tx_id IS NULL AND block_hash IS NOT NULL",
        "CREATE INDEX delivery_frontier_unenriched ON delivered_message(domain,id) INCLUDE (msg_id) WHERE destination_tx_id IS NULL AND block_hash IS NOT NULL",
        "CREATE UNIQUE INDEX delivery_frontier_unenriched ON delivered_message(domain,id) WHERE destination_tx_id IS NULL AND block_hash IS NOT NULL",
        "CREATE INDEX delivery_frontier_unenriched ON gas_payment(domain,id) WHERE tx_id IS NULL AND block_hash IS NOT NULL",
        "CREATE INDEX delivery_frontier_unenriched ON delivered_message USING hash(domain) WHERE destination_tx_id IS NULL AND block_hash IS NOT NULL",
    };
    for (definitions) |definition| try rejection(&connection, &.{ "DROP INDEX delivery_frontier_unenriched", definition }, error.InvalidDeliveryFrontierIndex);
    try rejection(&connection, &.{ "DROP INDEX gas_payment_frontier_unenriched", "CREATE INDEX gas_payment_frontier_unenriched ON gas_payment(domain,block_number) WHERE tx_id IS NULL AND block_hash IS NOT NULL" }, error.InvalidGasPaymentFrontierIndex);
    try rejection(&connection, &.{ "DROP INDEX gas_payment_frontier_height", "CREATE INDEX gas_payment_frontier_height ON gas_payment(domain,block_number)" }, error.InvalidGasPaymentHeightIndex);
    try rejection(&connection, &.{ "DROP INDEX gas_payment_block_log", "CREATE INDEX gas_payment_block_log ON gas_payment(domain,block_hash,transaction_hash,transaction_index,log_index,interchain_gas_paymaster,msg_id,destination,gas_amount,payment) WHERE block_hash IS NOT NULL" }, error.InvalidGasPaymentIdentityIndex);
    try rejection(&connection, &.{ "DROP INDEX gas_payment_block_log", "CREATE UNIQUE INDEX gas_payment_block_log ON gas_payment(domain,block_hash,coalesce(transaction_hash,'\\x'::bytea),transaction_index,log_index,interchain_gas_paymaster,msg_id,destination,gas_amount,payment,id) WHERE block_hash IS NOT NULL" }, error.InvalidGasPaymentIdentityIndex);
}

test "scraper schema rejects invalid and not-ready catalog states for every required index and obsolete cutover" {
    var connection = try connect();
    defer connection.deinit();
    const indexes = .{
        .{ "delivery_frontier_unenriched", error.InvalidDeliveryFrontierIndex },
        .{ "gas_payment_frontier_unenriched", error.InvalidGasPaymentFrontierIndex },
        .{ "gas_payment_frontier_height", error.InvalidGasPaymentHeightIndex },
        .{ "gas_payment_block_log", error.InvalidGasPaymentIdentityIndex },
    };
    // Explicit fixture-only catalog mutation isolates each interrupted-build
    // flag; rollback restores it before any other test or event write.
    inline for (indexes) |index| {
        inline for (.{ "indisvalid", "indisready" }) |flag| {
            try rejection(&connection, &.{"UPDATE pg_index SET " ++ flag ++ "=false WHERE indexrelid='" ++ index[0] ++ "'::regclass"}, index[1]);
        }
    }
    try rejection(&connection, &.{"CREATE INDEX gas_payment_transaction_log ON gas_payment(id)"}, error.ObsoleteGasPaymentPositionIndex);
}

test "scraper schema preserves supplied absolute deadline and cancellation before catalog I/O" {
    var connection = try connect();
    defer connection.deinit();
    var cancel = std.atomic.Value(bool).init(true);
    connection.io.cancel = &cancel;
    try std.testing.expectError(error.PostgresCancelled, schema.verifyFrontierIndexes(&connection));
    cancel.store(false, .release);
    const expired = (try pg.nowNs()) -| 1;
    connection.io.deadline_ns = expired;
    try std.testing.expectError(error.PostgresDeadlineExceeded, schema.verifyFrontierIndexes(&connection));
    try std.testing.expectEqual(expired, connection.io.deadline_ns.?);
    connection.io = .{};
    try schema.verifyFrontierIndexes(&connection);
    try std.testing.expect(connection.reusable());
}

fn configured(info: []const u8, url: []const u8) !settings.Settings {
    const db_arg = try std.fmt.allocPrint(a, "--db={s}", .{info});
    defer a.free(db_arg);
    const rpc_arg = try std.fmt.allocPrint(a, "--chains.ethereum.customRpcUrls={s}", .{url});
    defer a.free(rpc_arg);
    const defaults = if (std.fs.cwd().access("rust/main/config", .{})) |_| "rust/main/config" else |_| "../rust/main/config";
    return settings.Settings.load(a, .scraper, .{ .defaults_dir = defaults, .arguments = &.{ "--chainsToScrape=ethereum", db_arg, rpc_arg } });
}

fn rejectOpen(config: *const settings.Settings, environment: *const std.process.EnvMap, options: tasks.Options, expected: anyerror) !void {
    const opened = tasks.TaskSet.open(a, config, environment, options) catch |err| {
        try std.testing.expectEqual(expected, err);
        return;
    };
    opened.deinit();
    return error.ExpectedStartupRejection;
}

test "scraper schema actual TaskSet validates healthy DB before lanes and does not retain startup cancellation" {
    const info = try fixtureInfo();
    defer a.free(info);
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    var peer = try fixture.Fixture.init(8, &.{.{ .replies = &.{.{ .body = "{}" }} }});
    try peer.start();
    defer peer.deinit();
    const url = try peer.url(a, 0);
    defer a.free(url);
    var settings_ = try configured(info, url);
    defer settings_.deinit();
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var connection = try connect();
    defer connection.deinit();
    const before = try rows(&connection);
    var cancel = std.atomic.Value(bool).init(false);
    const value = try tasks.TaskSet.open(a, &settings_, &environment, .{ .curl_library = library, .startup_cancel = &cancel });
    defer value.deinit();
    try std.testing.expect(value.options.startup_cancel == null);
    // The committed Ethereum fixture also configures its optional CCR lane.
    try std.testing.expectEqual(@as(usize, 5), value.initialized_lanes);
    try std.testing.expectEqual(@as(usize, 0), value.database.snapshot().leased);
    try std.testing.expectEqual(@as(u64, 1), value.database.snapshot().opened);
    for (value.lanes) |lane| try std.testing.expect(lane.resources == null and lane.head_service == null);
    cancel.store(true, .release);
    try std.testing.expectEqual(before, try rows(&connection));
    try std.testing.expectEqual(@as(usize, 0), peer.acceptedCount());
    try peer.check();
}

test "scraper schema actual TaskSet rejects committed missing and obsolete indexes without DB or RPC lane effects" {
    const info = try fixtureInfo();
    defer a.free(info);
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    var peer = try fixture.Fixture.init(8, &.{.{ .replies = &.{.{ .body = "{}" }} }});
    try peer.start();
    defer peer.deinit();
    const url = try peer.url(a, 0);
    defer a.free(url);
    var settings_ = try configured(info, url);
    defer settings_.deinit();
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var connection = try connect();
    defer connection.deinit();
    const before = try rows(&connection);
    try connection.execute("ALTER INDEX delivery_frontier_unenriched RENAME TO ziggy_schema_saved_delivery", &.{});
    {
        defer connection.execute("ALTER INDEX ziggy_schema_saved_delivery RENAME TO delivery_frontier_unenriched", &.{}) catch @panic("fixture index restoration failed");
        try rejectOpen(&settings_, &environment, .{ .curl_library = library }, error.InvalidDeliveryFrontierIndex);
    }
    try connection.execute("CREATE INDEX gas_payment_transaction_log ON gas_payment(id)", &.{});
    {
        defer connection.execute("DROP INDEX gas_payment_transaction_log", &.{}) catch @panic("fixture obsolete index cleanup failed");
        try rejectOpen(&settings_, &environment, .{ .curl_library = library }, error.ObsoleteGasPaymentPositionIndex);
    }
    try schema.verifyFrontierIndexes(&connection);
    try std.testing.expectEqual(before, try rows(&connection));
    try std.testing.expectEqual(@as(usize, 0), peer.acceptedCount());
    try peer.check();
}

test "scraper schema actual TaskSet precancellation precedes native loading and configuration access" {
    var cancel = std.atomic.Value(bool).init(true);
    var settings_: settings.Settings = undefined;
    var environment: std.process.EnvMap = undefined;
    try std.testing.expectError(error.PostgresCancelled, tasks.TaskSet.open(a, &settings_, &environment, .{ .curl_library = "/does/not/exist", .startup_cancel = &cancel }));
}

test "scraper schema actual TaskSet catalog wait respects one deadline and active startup cancellation" {
    const info = try fixtureInfo();
    defer a.free(info);
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    var settings_ = try configured(info, "http://127.0.0.1:1");
    defer settings_.deinit();
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var locker = try connect();
    defer locker.deinit();
    var transaction = try locker.begin();
    defer transaction.deinit();
    // Owned disposable database only. This makes the actual catalog query
    // block while the independent constructor's monotonic owner expires.
    try locker.execute("LOCK TABLE pg_index IN ACCESS EXCLUSIVE MODE", &.{});
    var elapsed = try std.time.Timer.start();
    try rejectOpen(&settings_, &environment, .{ .curl_library = library, .db_timeout_ms = 100 }, error.PostgresDeadlineExceeded);
    try std.testing.expect(elapsed.read() < 2 * std.time.ns_per_s);
    var cancel = std.atomic.Value(bool).init(false);
    const Trigger = struct {
        fn run(flag: *std.atomic.Value(bool)) void {
            std.Thread.sleep(50 * std.time.ns_per_ms);
            flag.store(true, .release);
        }
    };
    const thread = try std.Thread.spawn(.{}, Trigger.run, .{&cancel});
    defer thread.join();
    elapsed.reset();
    try rejectOpen(&settings_, &environment, .{ .curl_library = library, .db_timeout_ms = 2000, .startup_cancel = &cancel }, error.PostgresCancelled);
    try std.testing.expect(elapsed.read() < std.time.ns_per_s);
    try transaction.rollback();
    try schema.verifyFrontierIndexes(&locker);
}

const CancelAtWriter = struct {
    flag: *std.atomic.Value(bool),
    allocation_bytes: usize,
    fired: usize = 0,
    fn allocator(self: *CancelAtWriter) std.mem.Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }
    fn alloc(context: *anyopaque, len: usize, alignment: std.mem.Alignment, address: usize) ?[*]u8 {
        const self: *CancelAtWriter = @ptrCast(@alignCast(context));
        const memory = a.rawAlloc(len, alignment, address) orelse return null;
        if (len == self.allocation_bytes) {
            self.fired += 1;
            self.flag.store(true, .release);
        }
        return memory;
    }
    fn resize(_: *anyopaque, memory: []u8, alignment: std.mem.Alignment, len: usize, address: usize) bool {
        return a.rawResize(memory, alignment, len, address);
    }
    fn remap(_: *anyopaque, memory: []u8, alignment: std.mem.Alignment, len: usize, address: usize) ?[*]u8 {
        return a.rawRemap(memory, alignment, len, address);
    }
    fn free(_: *anyopaque, memory: []u8, alignment: std.mem.Alignment, address: usize) void {
        a.rawFree(memory, alignment, address);
    }
};

test "scraper schema cancellation after successful catalog verification drains constructed owners without late lane effects" {
    const info = try fixtureInfo();
    defer a.free(info);
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    var peer = try fixture.Fixture.init(8, &.{.{ .replies = &.{.{ .body = "{}" }} }});
    try peer.start();
    defer peer.deinit();
    const url = try peer.url(a, 0);
    defer a.free(url);
    var settings_ = try configured(info, url);
    defer settings_.deinit();
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var connection = try connect();
    defer connection.deinit();
    const before = try rows(&connection);
    const writer = "w" ** 5000;
    var cancel = std.atomic.Value(bool).init(false);
    // The exact writer allocation is after all five successful guard queries,
    // immediately before constructing lanes; no production test hook is added.
    var watched: CancelAtWriter = .{ .flag = &cancel, .allocation_bytes = writer.len + 1 + 32 + 1 + 1 };
    const opened: ?*tasks.TaskSet = tasks.TaskSet.open(watched.allocator(), &settings_, &environment, .{ .curl_library = library, .startup_cancel = &cancel, .writer_id = writer }) catch |err| blk: {
        try std.testing.expectEqual(error.PostgresCancelled, err);
        break :blk null;
    };
    if (opened) |value| {
        value.deinit();
        return error.ExpectedLateStartupCancellation;
    }
    try std.testing.expectEqual(@as(usize, 1), watched.fired);
    try std.testing.expectEqual(before, try rows(&connection));
    std.Thread.sleep(20 * std.time.ns_per_ms);
    try std.testing.expectEqual(@as(usize, 0), peer.acceptedCount());
    try peer.check();
}
