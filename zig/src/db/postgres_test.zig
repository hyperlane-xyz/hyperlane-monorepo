//! Opt-in, disposable PostgreSQL16 tests on the real Rust migration schema.
const std = @import("std");
const pg = @import("postgres.zig");
const scraper = @import("scraper_store.zig");
const allocator = std.testing.allocator;
const contracts: scraper.Contracts = .{
    .mailbox = .{0} ** 12 ++ .{0x11} ** 20,
    .hook = .{0} ** 12 ++ .{0x22} ** 20,
    .paymaster = .{0} ** 12 ++ .{0x33} ** 20,
};

fn connect(diagnostic: ?*pg.Diagnostic) !pg.Connection {
    const info = try std.process.getEnvVarOwned(allocator, "ZIGGY_PG_FIXTURE");
    defer allocator.free(info);
    // The runner owns a dynamic loopback port. Never fall back to libpq's
    // environment/defaults or a developer's existing database.
    if (!std.mem.startsWith(u8, info, "host=127.0.0.1 port=") or std.mem.indexOf(u8, info, " dbname=ziggy user=ziggy ") == null) return error.NotIsolatedPostgresFixture;
    return pg.Connection.connect(allocator, info, diagnostic);
}
fn header(height: u64, byte: u8, parent: [32]u8) scraper.Header {
    return .{ .height = height, .timestamp = 1_700_000_000 + height, .hash = .{byte} ** 32, .parent = parent };
}
fn count(connection: *pg.Connection, query: []const u8) !u64 {
    var result = try connection.query(query, &.{});
    defer result.deinit();
    return std.math.cast(u64, try result.integer(0, "count")) orelse error.InvalidCount;
}
fn blockEvents(block: scraper.Header, nonce: u32) [4]scraper.Event {
    const message: @import("../protocol/root.zig").Message = .{
        .version = 3,
        .nonce = nonce,
        .origin = 1,
        .sender = .{0} ** 12 ++ .{0x44} ** 20,
        .destination = 42161,
        .recipient = .{0x55} ** 32,
        .body = "postgres fixture",
    };
    const tx_hash: [64]u8 = .{0} ** 32 ++ block.hash;
    const id = message.id();
    return .{
        .{ .block_number = block.height, .block_hash = block.hash, .address = contracts.mailbox, .tx_hash = tx_hash, .log_index = 0, .data = .{ .dispatch = message } },
        .{ .block_number = block.height, .block_hash = block.hash, .address = contracts.mailbox, .tx_hash = tx_hash, .log_index = 1, .sequence = nonce, .data = .{ .delivery = id } },
        .{ .block_number = block.height, .block_hash = block.hash, .address = contracts.paymaster, .tx_hash = tx_hash, .log_index = 2, .sequence = nonce, .data = .{ .gas = .{ .message_id = id, .destination = 42161, .gas = std.math.maxInt(u256), .payment = 123456789 } } },
        .{ .block_number = block.height, .block_hash = block.hash, .address = contracts.hook, .tx_hash = tx_hash, .log_index = 3, .data = .{ .insertion = .{ .message_id = id, .index = nonce } } },
    };
}

// Each test uses distinct domain state or no persistent rows. All connections
// point to a disposable database initialized by the production migration binary.
test "libpq bound binary/text/null values result ownership and aborted transaction rollback" {
    var diagnostic: pg.Diagnostic = .{};
    errdefer std.debug.print("Postgres fixture diagnostic: {s}\n", .{diagnostic.message()});
    var connection = try connect(&diagnostic);
    defer connection.deinit();
    const attack = "x'); DROP TABLE scraper_head; --";
    var result = try connection.query("SELECT $1::text AS text_value,$2::bytea AS bytes_value,$3::text AS null_value", &.{ pg.Param.text(attack), pg.Param.bytes(&.{ 0, 1, 255, 0 }), .{ .value = null, .oid = pg.Oid.text } });
    defer result.deinit();
    try std.testing.expectEqualStrings(attack, try result.required(0, "text_value"));
    const bytes = try result.bytea(allocator, 0, "bytes_value");
    defer allocator.free(bytes);
    try std.testing.expectEqualSlices(u8, &.{ 0, 1, 255, 0 }, bytes);
    try std.testing.expect((try result.value(0, try result.column("null_value"))) == null);
    try std.testing.expectError(error.ResultBounds, result.value(1, 0));
    try std.testing.expectError(error.InvalidTextParameter, connection.query("SELECT $1::text", &.{pg.Param.text("bad\x00text")}));
    {
        var transaction = try connection.begin();
        defer transaction.deinit();
        try std.testing.expectError(error.PostgresQuery, connection.query("SELECT 1/0", &.{}));
        try std.testing.expectEqualStrings("22012", &diagnostic.sqlstate.?);
        try std.testing.expectError(error.TransactionAborted, transaction.commit());
    }
    try std.testing.expectEqual(@as(u64, 1), try count(&connection, "SELECT 1::bigint AS count"));
    try std.testing.expectEqual(@as(u64, 1), try count(&connection, "SELECT count(*) AS count FROM pg_class WHERE relname='scraper_head'"));
}

test "actual scraper schema stage four streams confirm frontier cursor and atomic reorg suffix" {
    var diagnostic: pg.Diagnostic = .{};
    errdefer std.debug.print("Postgres fixture diagnostic: {s}\n", .{diagnostic.message()});
    var connection = try connect(&diagnostic);
    defer connection.deinit();
    const store: scraper.Store = .{ .connection = &connection, .domain = 1, .writer_id = "ziggy-writer-a" };
    const anchor = header(100, 0x10, .{0} ** 32);
    const first = header(101, 0x11, anchor.hash);
    const empty = header(102, 0x12, first.hash);
    try std.testing.expectEqual(@as(u64, 100), try store.anchorHeight(101));
    try store.initialize(anchor, contracts);
    try store.initialize(anchor, contracts);
    try store.claim(90);
    try store.validateContracts(contracts);
    try store.validateCheckpoints();
    var state = (try store.state()) orelse return error.MissingState;
    try store.observe(state, anchor, empty);
    state = (try store.state()).?;
    const events = blockEvents(first, 0);
    try store.append(state, &.{ .{ .header = first, .events = &events }, .{ .header = empty, .events = &.{} } });
    state = (try store.state()).?;
    try store.validateCheckpoints();
    try std.testing.expectEqual(@as(u64, 102), state.indexed);
    try std.testing.expectEqualSlices(u32, &.{ 1, 1, 1, 1 }, &try store.sequenceCounts());
    try std.testing.expectEqual(first.hash, (try store.hash(101)).?);
    try std.testing.expectEqual(@as(u64, 101), try store.checkpoint(101));
    try std.testing.expectEqual(@as(?u64, 102), try store.checkpointBetween(100, 102));
    try std.testing.expectEqual(@as(u64, 102), try store.confirmationBoundary(100, 102));
    try std.testing.expectEqual(@as(u64, 0), try count(&connection, "SELECT count(*) AS count FROM confirmed_raw_message_dispatch WHERE origin_domain=1"));
    try std.testing.expectEqual(@as(u64, 0), try count(&connection, "SELECT count(*) AS count FROM gas_payment_stream_cursor WHERE domain=1"));
    try std.testing.expectEqualSlices(u64, &.{ 1, 1, 1, 1 }, &try store.confirm(state, first, 90));
    inline for (.{ .{ "confirmed_raw_message_dispatch", "origin_domain" }, .{ "confirmed_delivered_message", "domain" }, .{ "confirmed_gas_payment", "domain" }, .{ "confirmed_merkle_tree_insertion", "domain" } }) |table|
        try std.testing.expectEqual(@as(u64, 1), try count(&connection, "SELECT count(*) AS count FROM " ++ table[0] ++ " WHERE " ++ table[1] ++ "=1"));
    try std.testing.expectEqual(@as(u64, 1), try count(&connection, "SELECT count(*) AS count FROM gas_payment_stream_cursor WHERE domain=1"));
    state = (try store.state()).?;
    const new_head = header(103, 0x13, empty.hash);
    try store.observe(state, empty, new_head);
    state = (try store.state()).?;
    var duplicates = blockEvents(new_head, 1);
    duplicates[2].log_index = 0;
    const invalid_events = [_]scraper.Event{ duplicates[2], duplicates[2] };
    try std.testing.expectError(error.PostgresQuery, store.append(state, &.{.{ .header = new_head, .events = &invalid_events }}));
    try std.testing.expectEqualStrings("23505", &diagnostic.sqlstate.?);
    try std.testing.expectEqual(@as(u64, 102), (try store.state()).?.indexed);
    try std.testing.expect((try store.hash(103)) == null);
    try std.testing.expectEqual(@as(u64, 0), try count(&connection, "SELECT count(*) AS count FROM block WHERE domain=1 AND height=103"));
    const fork = header(102, 0x22, first.hash);
    const fork_head = header(103, 0x23, fork.hash);
    try store.observe(state, first, fork_head);
    state = (try store.state()).?;
    const replacement_events = blockEvents(fork, 1);
    try store.append(state, &.{ .{ .header = fork, .events = &replacement_events }, .{ .header = fork_head, .events = &.{} } });
    state = (try store.state()).?;
    try connection.execute("UPDATE scraper_head SET updated_at=clock_timestamp()-interval '100 seconds' WHERE domain=1", &.{});
    try std.testing.expectError(error.ConfirmationExpiredOrChanged, store.confirm(state, fork, 90));
    try std.testing.expectEqual(@as(u64, 101), (try store.state()).?.confirmed);
    try std.testing.expect((try store.hash(101)) != null);
    try std.testing.expectEqual(@as(u64, 1), try count(&connection, "SELECT count(*) AS count FROM gas_payment_stream_cursor WHERE domain=1"));
    try store.observe(state, fork_head, fork_head);
    state = (try store.state()).?;
    try std.testing.expectError(error.ReorgCrossedConfirmed, store.observe(state, anchor, fork_head));
    try store.rewindToConfirmed(state);
    state = (try store.state()).?;
    try std.testing.expectEqual(@as(u64, 101), state.indexed);
    try std.testing.expect((try store.hash(102)) == null);
    inline for (.{ .{ "raw_message_dispatch", "origin_domain" }, .{ "delivered_message", "domain" }, .{ "gas_payment", "domain" }, .{ "merkle_tree_insertion", "domain" } }) |table|
        try std.testing.expectEqual(@as(u64, 1), try count(&connection, "SELECT count(*) AS count FROM " ++ table[0] ++ " WHERE " ++ table[1] ++ "=1"));
    try store.validateCheckpoints();
    try store.pause(true);
    try std.testing.expect((try store.state()).?.halted);
    try std.testing.expectError(error.HeadChanged, store.observe((try store.state()).?, first, first));
}

test "database clock writer takeover and actual advisory transaction lock" {
    var connection = try connect(null);
    defer connection.deinit();
    var other = try connect(null);
    defer other.deinit();
    const first: scraper.Store = .{ .connection = &connection, .domain = 42161, .writer_id = "lease-first" };
    const second: scraper.Store = .{ .connection = &other, .domain = 42161, .writer_id = "lease-second" };
    const anchor = header(200, 0x31, .{0} ** 32);
    try first.initialize(anchor, contracts);
    try first.claim(90);
    try std.testing.expectError(error.WriterOwned, second.claim(90));
    try other.execute("UPDATE scraper_head SET writer_lease_until=clock_timestamp()-interval '1 second' WHERE domain=42161", &.{});
    try second.claim(90);
    try std.testing.expectError(error.WriterOwned, first.pause(false));
    try std.testing.expectError(error.HeadChanged, first.observe((try first.state()).?, anchor, anchor));
    try second.observe((try second.state()).?, anchor, anchor);
    var transaction = try connection.begin();
    defer transaction.deinit();
    try connection.execute("SELECT pg_advisory_xact_lock(42161::bigint)", &.{});
    var locked = try other.query("SELECT pg_try_advisory_xact_lock(42161::bigint) AS acquired", &.{});
    defer locked.deinit();
    try std.testing.expect(!try locked.boolean(0, "acquired"));
    try transaction.rollback();
    var unlocked = try other.query("SELECT pg_try_advisory_xact_lock(42161::bigint) AS acquired", &.{});
    defer unlocked.deinit();
    try std.testing.expect(try unlocked.boolean(0, "acquired"));
}

fn deliveries(block: scraper.Header, first_sequence: u32, length: usize) ![]scraper.Event {
    const events = try allocator.alloc(scraper.Event, length);
    for (events, 0..) |*event, i| {
        const sequence = first_sequence + @as(u32, @intCast(i));
        var id = [_]u8{0} ** 32;
        std.mem.writeInt(u32, id[28..32], sequence, .big);
        event.* = .{ .block_number = block.height, .block_hash = block.hash, .address = contracts.mailbox, .log_index = i, .sequence = sequence, .data = .{ .delivery = id } };
    }
    return events;
}

test "bounded batches and confirmation preserve oversized atomic block publication" {
    var diagnostic: pg.Diagnostic = .{};
    errdefer std.debug.print("Postgres fixture diagnostic: {s}\n", .{diagnostic.message()});
    var connection = try connect(&diagnostic);
    defer connection.deinit();
    const store: scraper.Store = .{ .connection = &connection, .domain = 8453, .writer_id = "budget-writer" };
    const anchor = header(300, 0x40, .{0} ** 32);
    const first = header(301, 0x41, anchor.hash);
    try store.initialize(anchor, contracts);
    try store.claim(90);
    try store.observe((try store.state()).?, anchor, first);
    const many = try deliveries(first, 0, 1002);
    defer allocator.free(many);
    try store.append((try store.state()).?, &.{.{ .header = first, .events = many }});
    try std.testing.expectEqual(@as(u64, 301), try store.confirmationBoundary(300, 301));
    try std.testing.expectEqualSlices(u64, &.{ 0, 1002, 0, 0 }, &try store.confirm((try store.state()).?, first, 90));
    const second = header(302, 0x42, first.hash);
    const third = header(303, 0x43, second.hash);
    try store.observe((try store.state()).?, first, third);
    const second_events = try deliveries(second, 1002, 1000);
    defer allocator.free(second_events);
    const third_events = try deliveries(third, 2002, 2);
    defer allocator.free(third_events);
    try store.append((try store.state()).?, &.{ .{ .header = second, .events = second_events }, .{ .header = third, .events = third_events } });
    try std.testing.expectEqual(@as(u64, 302), try store.confirmationBoundary(301, 303));
    try std.testing.expectEqualSlices(u64, &.{ 0, 1000, 0, 0 }, &try store.confirm((try store.state()).?, second, 90));
    try std.testing.expectEqual(@as(u64, 2002), try count(&connection, "SELECT count(*) AS count FROM confirmed_delivered_message WHERE domain=8453"));
    try std.testing.expectEqual(@as(u64, 2004), try count(&connection, "SELECT count(*) AS count FROM delivered_message WHERE domain=8453"));
    // Source-compatible u32 domain storage uses signed INTEGER while advisory
    // locking widens the original unsigned domain to a positive BIGINT.
    try connection.execute("INSERT INTO domain(id,time_created,time_updated,name,native_token,chain_id,is_test_net,is_deprecated) VALUES(-1,now(),now(),'ziggy-max-domain','ETH',NULL,true,false)", &.{});
    const max_domain: scraper.Store = .{ .connection = &connection, .domain = std.math.maxInt(u32), .writer_id = "max-domain-writer" };
    try max_domain.initialize(anchor, contracts);
    try max_domain.claim(90);
    try std.testing.expectEqual(@as(u64, 300), (try max_domain.state()).?.indexed);
}

test "native Postgres absolute query deadline closes an ambiguous operation even without server statement timeout" {
    var connection = try connect(null);
    defer connection.deinit();
    try connection.execute("SET statement_timeout=0", &.{});
    connection.io = .{ .timeout_ms = 5000, .deadline_ns = (try pg.nowNs()) + 80 * std.time.ns_per_ms };
    var timer = try std.time.Timer.start();
    try std.testing.expectError(error.PostgresDeadlineExceeded, connection.query("SELECT pg_sleep(5)", &.{}));
    try std.testing.expect(timer.read() < std.time.ns_per_s);
    try std.testing.expect(connection.poisoned);
    try std.testing.expect(connection.handle == null);
    try std.testing.expectError(error.PoisonedConnection, connection.query("SELECT 1", &.{}));
}
test "native Postgres precancel sends no query and a completed SQL error drains for subsequent use" {
    var connection = try connect(null);
    defer connection.deinit();
    var cancel = std.atomic.Value(bool).init(true);
    connection.io.cancel = &cancel;
    try std.testing.expectError(error.PostgresCancelled, connection.query("SELECT 1", &.{}));
    try std.testing.expect(!connection.poisoned);
    cancel.store(false, .release);
    try std.testing.expectError(error.PostgresQuery, connection.query("SELECT 1/0", &.{}));
    try std.testing.expect(!connection.poisoned);
    var result = try connection.query("SELECT $1::bytea AS bytes,$2::text AS text", &.{ pg.Param.bytes(&.{ 0, 1, 255 }), pg.Param.text("still usable") });
    defer result.deinit();
    const bytes = try result.bytea(allocator, 0, "bytes");
    defer allocator.free(bytes);
    try std.testing.expectEqualSlices(u8, &.{ 0, 1, 255 }, bytes);
    try std.testing.expectEqualStrings("still usable", try result.required(0, "text"));
}
const SilentConnect = struct {
    server: std.net.Server,
    stop: std.atomic.Value(bool) = .init(false),
    failure: ?anyerror = null,
    fn serve(self: *SilentConnect) void {
        self.run() catch |err| {
            self.failure = err;
        };
    }
    fn run(self: *SilentConnect) !void {
        var fd = [_]std.posix.pollfd{.{ .fd = self.server.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
        if (try std.posix.poll(&fd, 2000) == 0) return error.FixtureAcceptTimeout;
        const connection = try self.server.accept();
        defer connection.stream.close();
        var timer = try std.time.Timer.start();
        while (!self.stop.load(.acquire) and timer.read() < 2 * std.time.ns_per_s) std.Thread.sleep(std.time.ns_per_ms);
    }
};
test "native Postgres nonblocking authentication handshake obeys deadline and DNS policy before opening a socket" {
    try std.testing.expectError(error.UnboundedPostgresDns, pg.Connection.connectWithOptions(allocator, "host=never.resolve.invalid dbname=ziggy user=ziggy", null, .{ .timeout_ms = 50 }));
    try std.testing.expectError(error.UnboundedPostgresDns, pg.Connection.connectWithOptions(allocator, "service=never-read-local-profile", null, .{ .timeout_ms = 50 }));
    var fixture: SilentConnect = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}) };
    defer fixture.server.deinit();
    const thread = try std.Thread.spawn(.{}, SilentConnect.serve, .{&fixture});
    var joined = false;
    defer if (!joined) {
        fixture.stop.store(true, .release);
        thread.join();
    };
    const info = try std.fmt.allocPrint(allocator, "host=fixture.invalid hostaddr=127.0.0.1 port={d} dbname=ziggy user=ziggy sslmode=disable", .{fixture.server.listen_address.getPort()});
    defer allocator.free(info);
    var timer = try std.time.Timer.start();
    try std.testing.expectError(error.PostgresDeadlineExceeded, pg.Connection.connectWithOptions(allocator, info, null, .{ .timeout_ms = 80 }));
    try std.testing.expect(timer.read() < std.time.ns_per_s);
    fixture.stop.store(true, .release);
    thread.join();
    joined = true;
    if (fixture.failure) |err| return err;
}
const CommitProxy = struct {
    server: std.net.Server,
    target: std.net.Address,
    stop: std.atomic.Value(bool) = .init(false),
    committed_response: std.atomic.Value(bool) = .init(false),
    failure: ?anyerror = null,
    fn serve(self: *CommitProxy) void {
        self.run() catch |err| {
            self.failure = err;
        };
    }
    fn run(self: *CommitProxy) !void {
        var ready = [_]std.posix.pollfd{.{ .fd = self.server.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
        if (try std.posix.poll(&ready, 2000) == 0) return error.FixtureAcceptTimeout;
        const client = try self.server.accept();
        defer client.stream.close();
        const backend = try std.net.tcpConnectToAddress(self.target);
        defer backend.close();
        var blocked = false;
        var tail: [16]u8 = undefined;
        var tail_len: usize = 0;
        var timer = try std.time.Timer.start();
        while (!self.stop.load(.acquire) and timer.read() < 5 * std.time.ns_per_s) {
            var fds = [_]std.posix.pollfd{ .{ .fd = client.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }, .{ .fd = backend.handle, .events = std.posix.POLL.IN, .revents = 0 } };
            if (try std.posix.poll(&fds, 20) == 0) continue;
            for (fds, 0..) |fd, index| if (fd.revents != 0) {
                var buffer: [8192]u8 = undefined;
                const source = if (index == 0) client.stream else backend;
                const got = source.read(&buffer) catch return;
                if (got == 0) return;
                if (index == 0) {
                    var scan: [8208]u8 = undefined;
                    @memcpy(scan[0..tail_len], tail[0..tail_len]);
                    @memcpy(scan[tail_len..][0..got], buffer[0..got]);
                    const length = tail_len + got;
                    blocked = blocked or std.mem.indexOf(u8, scan[0..length], "COMMIT\x00") != null;
                    tail_len = @min(tail.len, length);
                    @memcpy(tail[0..tail_len], scan[length - tail_len .. length]);
                    try backend.writeAll(buffer[0..got]);
                } else if (blocked) {
                    if (std.mem.indexOf(u8, buffer[0..got], "COMMIT\x00") != null) self.committed_response.store(true, .release);
                } else try client.stream.writeAll(buffer[0..got]);
            };
        }
    }
};
test "native Postgres lost COMMIT response returns unknown outcome and never replays the committed transaction" {
    const info = try std.process.getEnvVarOwned(allocator, "ZIGGY_PG_FIXTURE");
    defer allocator.free(info);
    if (!std.mem.startsWith(u8, info, "host=127.0.0.1 port=") or std.mem.indexOf(u8, info, " dbname=ziggy user=ziggy ") == null) return error.NotIsolatedPostgresFixture;
    const start = "host=127.0.0.1 port=".len;
    const end = std.mem.indexOfScalarPos(u8, info, start, ' ') orelse return error.InvalidFixtureConnection;
    const target = try std.net.Address.parseIp4("127.0.0.1", try std.fmt.parseInt(u16, info[start..end], 10));
    var observer = try connect(null);
    defer observer.deinit();
    try observer.execute("CREATE TABLE ziggy_deadline_commit(value INTEGER)", &.{});
    defer observer.execute("DROP TABLE ziggy_deadline_commit", &.{}) catch {};
    var fixture: CommitProxy = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .target = target };
    defer fixture.server.deinit();
    const thread = try std.Thread.spawn(.{}, CommitProxy.serve, .{&fixture});
    var joined = false;
    defer if (!joined) {
        fixture.stop.store(true, .release);
        thread.join();
    };
    const proxied = try std.fmt.allocPrint(allocator, "{s} port={d} sslmode=disable", .{ info, fixture.server.listen_address.getPort() });
    defer allocator.free(proxied);
    var connection = try pg.Connection.connectWithOptions(allocator, proxied, null, .{ .timeout_ms = 2000 });
    defer connection.deinit();
    var transaction = try connection.begin();
    defer transaction.deinit();
    try connection.execute("INSERT INTO ziggy_deadline_commit(value) VALUES(1)", &.{});
    connection.io.deadline_ns = (try pg.nowNs()) + 120 * std.time.ns_per_ms;
    var timer = try std.time.Timer.start();
    try std.testing.expectError(error.CommitOutcomeUnknown, transaction.commit());
    try std.testing.expect(timer.read() < std.time.ns_per_s);
    try std.testing.expect(connection.poisoned);
    try std.testing.expect(!transaction.active);
    fixture.stop.store(true, .release);
    thread.join();
    joined = true;
    if (fixture.failure) |err| return err;
    try std.testing.expect(fixture.committed_response.load(.acquire));
    try std.testing.expectEqual(@as(u64, 1), try count(&observer, "SELECT count(*) AS count FROM ziggy_deadline_commit"));
}

test "native Postgres hostname resolver preconnect preserves configured host and shares the full connect deadline" {
    const library = std.process.getEnvVarOwned(allocator, "HYPERLANE_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer allocator.free(library);
    var curl = try @import("../net/curl.zig").Client.init(allocator, library);
    defer curl.deinit();
    const info = try std.process.getEnvVarOwned(allocator, "ZIGGY_PG_FIXTURE");
    defer allocator.free(info);
    if (!std.mem.startsWith(u8, info, "host=127.0.0.1 port=") or std.mem.indexOf(u8, info, " dbname=ziggy user=ziggy ") == null) return error.NotIsolatedPostgresFixture;
    const with_hostname = try std.fmt.allocPrint(allocator, "{s} host=localhost", .{info});
    defer allocator.free(with_hostname);
    var connection = try pg.Connection.connectWithOptions(allocator, with_hostname, null, .{ .timeout_ms = 1000, .resolver = &curl, .deadline_ns = (try pg.nowNs()) + std.time.ns_per_s });
    defer connection.deinit();
    var result = try connection.query("SELECT 7 AS value", &.{});
    defer result.deinit();
    try std.testing.expectEqual(@as(i64, 7), try result.integer(0, "value"));
    try std.testing.expectError(error.PostgresMultiHostResolutionUnsupported, pg.Connection.connectWithOptions(allocator, "host=localhost,other.invalid port=5432 user=ziggy dbname=ziggy", null, .{ .resolver = &curl }));
}

test "native Postgres pool leases bound wait reuse clean sessions and reconnect poisoned or unclosed transactions" {
    const info = std.process.getEnvVarOwned(allocator, "ZIGGY_PG_FIXTURE") catch return error.SkipZigTest;
    defer allocator.free(info);
    if (!std.mem.startsWith(u8, info, "host=127.0.0.1 port=") or std.mem.indexOf(u8, info, " dbname=ziggy user=ziggy ") == null) return error.NotIsolatedPostgresFixture;
    const pool = try @import("pool.zig").Pool.init(allocator, info, .{ .max_connections = 1 });
    defer pool.deinit();
    var first = try pool.acquire(.{});
    defer first.deinit();
    var result = try first.connection().query("SELECT pg_backend_pid() AS pid", &.{});
    const initial = try result.integer(0, "pid");
    result.deinit();
    const before = try pg.nowNs();
    try std.testing.expectError(error.PostgresDeadlineExceeded, pool.acquire(.{ .timeout_ms = 50 }));
    try std.testing.expect(try pg.nowNs() - before < 500 * std.time.ns_per_ms);
    var cancel = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.PostgresCancelled, pool.acquire(.{ .cancel = &cancel }));
    first.deinit();
    var clean = try pool.acquire(.{});
    result = try clean.connection().query("SELECT pg_backend_pid() AS pid", &.{});
    try std.testing.expectEqual(initial, try result.integer(0, "pid"));
    result.deinit();
    // SQL errors are fully drained and keep an idle session reusable.
    try std.testing.expectError(error.PostgresQuery, clean.connection().query("SELECT 1 / 0", &.{}));
    clean.deinit();
    var broken = try pool.acquire(.{ .timeout_ms = 60 });
    try std.testing.expectError(error.PostgresDeadlineExceeded, broken.connection().query("SELECT pg_sleep(5)", &.{}));
    try std.testing.expect(broken.connection().poisoned);
    broken.deinit();
    var recovered = try pool.acquire(.{});
    result = try recovered.connection().query("SELECT pg_backend_pid() AS pid", &.{});
    try std.testing.expect(initial != try result.integer(0, "pid"));
    result.deinit();
    // A caller accidentally releasing an active transaction cannot leak its
    // aborted state, uncommitted writes, or locks into another worker.
    try recovered.connection().execute("BEGIN", &.{});
    try recovered.connection().execute("CREATE TEMP TABLE pool_uncommitted(value int)", &.{});
    recovered.deinit();
    var final = try pool.acquire(.{});
    defer final.deinit();
    result = try final.connection().query("SELECT to_regclass('pg_temp.pool_uncommitted') IS NULL AS gone", &.{});
    defer result.deinit();
    try std.testing.expect(try result.boolean(0, "gone"));
    try std.testing.expectEqual(@as(u64, 3), pool.snapshot().opened);
    try std.testing.expectEqual(@as(u64, 2), pool.snapshot().discarded);
}

test "native Postgres pool initializes session deadlines on every new connection while per job cancellation and timeout remain active" {
    const info = std.process.getEnvVarOwned(allocator, "ZIGGY_PG_FIXTURE") catch return error.SkipZigTest;
    defer allocator.free(info);
    if (!std.mem.startsWith(u8, info, "host=127.0.0.1 port=") or std.mem.indexOf(u8, info, " dbname=ziggy user=ziggy ") == null) return error.NotIsolatedPostgresFixture;
    const pool = try @import("pool.zig").Pool.init(allocator, info, .{ .max_connections = 1, .session_timeout_ms = 2000 });
    defer pool.deinit();
    var cancelled = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.PostgresCancelled, pool.acquire(.{ .cancel = &cancelled }));
    try std.testing.expectEqual(@as(u64, 0), pool.snapshot().opened);
    var lease = try pool.acquire(.{});
    var settings = try lease.connection().query("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS locks, pg_backend_pid() AS pid", &.{});
    try std.testing.expectEqualStrings("2s", try settings.required(0, "statement"));
    try std.testing.expectEqualStrings("2s", try settings.required(0, "locks"));
    const first = try settings.integer(0, "pid");
    settings.deinit();
    lease.deinit();
    var short = try pool.acquire(.{ .timeout_ms = 50 });
    try std.testing.expectError(error.PostgresDeadlineExceeded, short.connection().query("SELECT pg_sleep(5)", &.{}));
    short.deinit();
    var recovered = try pool.acquire(.{});
    defer recovered.deinit();
    settings = try recovered.connection().query("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS locks, pg_backend_pid() AS pid", &.{});
    defer settings.deinit();
    try std.testing.expectEqualStrings("2s", try settings.required(0, "statement"));
    try std.testing.expectEqualStrings("2s", try settings.required(0, "locks"));
    try std.testing.expect(first != try settings.integer(0, "pid"));
    try std.testing.expectEqual(@as(u64, 2), pool.snapshot().opened);
    try std.testing.expectEqual(@as(u64, 1), pool.snapshot().discarded);
}
