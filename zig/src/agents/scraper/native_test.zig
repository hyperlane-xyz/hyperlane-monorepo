//! Opt-in native PG tests, imported only by pg_tests.zig. The runner creates and
//! migrates a disposable task-owned PostgreSQL16 on a dynamic loopback port.
const std = @import("std");
const pg = @import("../../db/postgres.zig");
const head = @import("../../db/scraper_store.zig");
const runtime = @import("runtime.zig");
const enrich = @import("enrichment.zig");
const storage = @import("storage.zig");
const reconciliation = @import("reconciliation.zig");
const src = @import("source.zig");
const fixture = @import("testing.zig");
const allocator = std.testing.allocator;
fn connect() !pg.Connection {
    const info = try std.process.getEnvVarOwned(allocator, "ZIGGY_PG_FIXTURE");
    defer allocator.free(info);
    if (!std.mem.startsWith(u8, info, "host=127.0.0.1 port=") or std.mem.indexOf(u8, info, " dbname=ziggy user=ziggy ") == null) return error.NotIsolatedPostgresFixture;
    return pg.Connection.connect(allocator, info, null);
}
const contracts: src.Contracts = .{ .mailbox = .{1} ** 32, .hook = .{2} ** 32, .paymaster = .{3} ** 32 };
fn seed(connection: *pg.Connection, domain: u32) !void {
    var buffer: [20]u8 = undefined;
    const text = try std.fmt.bufPrint(&buffer, "{d}", .{domain});
    try connection.execute("INSERT INTO domain(id,time_created,time_updated,name,native_token,chain_id,is_test_net,is_deprecated) VALUES($1,now(),now(),$2,'ETH',NULL,true,false) ON CONFLICT(id) DO NOTHING", &.{ .{ .value = text, .oid = pg.Oid.int4 }, pg.Param.text(text) });
}
fn events(domain: u32) [4]src.Event {
    var original = fixture.fixtureEvents();
    original[0].data.dispatch.origin = domain;
    original[0].data.dispatch.destination = domain;
    const id = original[0].data.dispatch.id();
    const txhash = [_]u8{0} ** 32 ++ .{0xf9} ** 32;
    for (&original) |*event| event.tx_hash = txhash;
    return .{ original[0], original[1], .{ .block_number = 2, .block_hash = .{0} ** 32, .address = contracts.mailbox, .tx_hash = txhash, .log_index = 2, .data = .{ .delivery = id } }, .{ .block_number = 2, .block_hash = .{0} ** 32, .address = contracts.paymaster, .tx_hash = txhash, .log_index = 3, .data = .{ .gas = .{ .message_id = id, .destination = domain, .gas = 21000, .payment = 100 } } } };
}
const Fetch = struct {
    fn fetch(_: *anyopaque, a: std.mem.Allocator, meta: enrich.Meta, _: u64) !enrich.OwnedTxn {
        return .{ .arena = std.heap.ArenaAllocator.init(a), .value = .{ .hash = meta.tx_hash, .block_hash = meta.block_hash, .block_number = meta.block_number, .gas_limit = 21000, .gas_price = 7, .nonce = 3, .sender = .{0} ** 12 ++ .{0x66} ** 20, .gas_used = 20000, .cumulative_gas_used = 30000, .raw_input = null } };
    }
};
fn rows(connection: *pg.Connection, sql: []const u8) !u64 {
    var result = try connection.query(sql, &.{});
    defer result.deinit();
    return @intCast(try result.integer(0, "count"));
}

test "scraper native PG complete worker publishes then independently enriches receipts and raw dispatches" {
    var connection = try connect();
    defer connection.deinit();
    var diagnostic: pg.Diagnostic = .{};
    connection.diagnostic = &diagnostic;
    var phase: []const u8 = "initialize";
    errdefer std.debug.print("Scraper native fixture phase={s}: {s}\n", .{ phase, diagnostic.message() });
    const domain = 99991;
    try seed(&connection, domain);
    const all = events(domain);
    var chain: fixture.Chain = .{ .head = 3, .tag = 3, .fork = 0xf1, .items = &all };
    const source = chain.interface();
    const store: head.Store = .{ .connection = &connection, .domain = domain, .writer_id = "ziggy-scraper-native-worker" };
    try store.initialize(try source.header(.{ .height = 0 }), contracts);
    var owned_store = store;
    var worker: runtime.Worker(head.Store) = .{ .allocator = allocator, .source = source, .store = &owned_store, .options = .{ .period = .latest, .chunk_size = 10 } };
    const result = try worker.cycle();
    try std.testing.expectEqual(@as(u64, 3), result.confirmed);
    try std.testing.expectEqual(@as(u64, 1), try rows(&connection, "SELECT count(*) AS count FROM confirmed_raw_message_dispatch WHERE origin_domain=99991"));
    const enrichment_store: storage.Store = .{ .connection = &connection, .domain = domain, .mailbox = contracts.mailbox };
    phase = "configure enrichment";
    try enrichment_store.configure(2000);
    var delivery: enrich.Lane = .{ .stream = .delivery };
    var gas: enrich.Lane = .{ .stream = .gas };
    phase = "plan receipts";
    var delivery_page = try delivery.plan(allocator, enrichment_store);
    defer delivery_page.deinit();
    var gas_page = try gas.plan(allocator, enrichment_store);
    defer gas_page.deinit();
    try std.testing.expectEqual(@as(usize, 1), delivery_page.requests.len);
    try std.testing.expectEqual(@as(usize, 1), gas_page.requests.len);
    var context: u8 = 0;
    phase = "persist transaction";
    try enrich.fetchAndPersist(allocator, enrichment_store, .{ .context = &context, .fetch_fn = Fetch.fetch }, delivery_page.requests[0], 1);
    phase = "link receipts";
    try std.testing.expectEqual(@as(usize, 0), (try delivery.finish(enrichment_store, delivery_page)).pending);
    try std.testing.expectEqual(@as(usize, 0), (try gas.finish(enrichment_store, gas_page)).pending);
    try std.testing.expectEqual(@as(u64, 1), try rows(&connection, "SELECT count(*) AS count FROM delivered_message WHERE domain=99991 AND destination_tx_id IS NOT NULL"));
    try std.testing.expectEqual(@as(u64, 1), try rows(&connection, "SELECT count(*) AS count FROM gas_payment WHERE domain=99991 AND tx_id IS NOT NULL"));
    phase = "plan reconciliation";
    var backoff: reconciliation.Backoff = .{ .allocator = allocator };
    defer backoff.deinit();
    var plan = try reconciliation.planPage(allocator, enrichment_store, backoff, 0, try enrichment_store.rawFrontier(), 1000);
    defer plan.deinit();
    try std.testing.expectEqual(@as(usize, 0), plan.requests.len);
    phase = "store reconciliation";
    const reconciled = try reconciliation.finish(enrichment_store, contracts.mailbox, &plan, &backoff, 1000);
    try std.testing.expectEqual(@as(u64, 1), reconciled.stored_count);
    try std.testing.expectEqual(@as(u64, 1), try rows(&connection, "SELECT count(*) AS count FROM message WHERE origin=99991 AND origin_tx_id IS NOT NULL"));
    phase = "message replay";
    const replay = [_]storage.Storable{.{ .message = all[0].data.dispatch, .transaction_id = null }};
    try std.testing.expectEqual(@as(u64, 0), try enrichment_store.storeMessages(contracts.mailbox, &replay));
    try std.testing.expectEqual(@as(u64, 1), try rows(&connection, "SELECT count(*) AS count FROM message WHERE origin=99991 AND origin_tx_id IS NOT NULL"));
    try std.testing.expectError(error.DuplicateScraperMessageConflict, enrichment_store.storeMessages(contracts.mailbox, &.{ replay[0], replay[0] }));
    phase = "CCR preflight and atomic pairs";
    const ccr = @import("ccr.zig");
    const swap: ccr.Swap = .{ .meta = delivery_page.rows[0].meta, .log_index = 7, .domain = domain, .source_router = .{0} ** 12 ++ .{0xaa} ** 20, .destination_router = .{0} ** 12 ++ .{0xbb} ** 20, .recipient = .{0xcc} ** 32, .amount = 300 };
    var missing = swap;
    missing.meta.tx_hash = .{0} ** 32 ++ .{0xfd} ** 32;
    try std.testing.expectError(error.MissingCcrEnrichment, enrichment_store.storeCcr(&.{ swap, missing }));
    try std.testing.expectEqual(@as(u64, 1), try rows(&connection, "SELECT count(*) AS count FROM message WHERE origin=99991"));
    try std.testing.expectEqual(@as(u64, 1), try enrichment_store.storeCcr(&.{swap}));
    try std.testing.expectEqual(@as(u64, 0), try enrichment_store.storeCcr(&.{swap}));
    const synthetic = try ccr.syntheticId(swap.meta.tx_hash, swap.log_index);
    try connection.execute("DELETE FROM delivered_message WHERE msg_id=$1", &.{pg.Param.bytes(&synthetic)});
    try std.testing.expectEqual(@as(u64, 1), try enrichment_store.storeCcr(&.{swap}));
    try enrichment_store.saveCcrCursor(3);
    try std.testing.expectEqual(@as(u64, 3), try enrichment_store.ccrCursor(0));
    try std.testing.expectError(error.CcrBeyondConfirmed, enrichment_store.saveCcrCursor(4));
}

test "scraper native PG restart reproof rewinds an unpublished incomplete suffix" {
    var connection = try connect();
    defer connection.deinit();
    const domain = 99992;
    try seed(&connection, domain);
    var all = events(domain);
    all[0].tx_hash = .{0} ** 32 ++ .{0xfa} ** 32;
    all[1].tx_hash = all[0].tx_hash;
    var chain: fixture.Chain = .{ .head = 3, .tag = 3, .fork = 0xf2, .items = all[0..1], .counts_available = false };
    const source = chain.interface();
    var store: head.Store = .{ .connection = &connection, .domain = domain, .writer_id = "ziggy-scraper-native-reproof" };
    try store.initialize(try source.header(.{ .height = 0 }), contracts);
    var worker: runtime.Worker(head.Store) = .{ .allocator = allocator, .source = source, .store = &store, .options = .{ .period = .latest, .chunk_size = 10 } };
    try std.testing.expect((try worker.cycle()).ingestion_failed);
    try std.testing.expectEqual(@as(u64, 0), (try store.state()).?.confirmed);
    worker.cache = .{};
    chain.counts_available = true;
    chain.items = all[0..2];
    _ = try worker.cycle();
    try std.testing.expectEqual(@as(u64, 3), (try store.state()).?.confirmed);
    try std.testing.expectEqual(@as(u64, 1), try rows(&connection, "SELECT count(*) AS count FROM confirmed_raw_message_dispatch WHERE origin_domain=99992"));
}

test "scraper concrete factory rejects unsupported protocol before touching native resources" {
    const settings = @import("../../settings/types.zig");
    const rpc = @import("../../evm/provider.zig");
    const service = @import("service.zig");
    var chain: settings.Chain = undefined;
    chain.protocol = .aleo;
    var client: rpc.RpcClient = undefined;
    var connection: pg.Connection = undefined;
    try std.testing.expectError(error.UnsupportedConcreteScraperProtocol, service.Evm.init(allocator, &client, &connection, chain, "fixture-writer", 1000));
}

test "scraper shared native service validates writer before touching resources" {
    const settings = @import("../../settings/types.zig");
    var chain: settings.Chain = undefined;
    var connection: pg.Connection = undefined;
    try std.testing.expectError(error.InvalidScraperWriterId, @import("service.zig").Native.init(allocator, &connection, undefined, &chain, "", 1000));
}

test "scraper pooled PG runtime reconnects after poisoned jobs and recovers durable frontiers without duplicating events" {
    const info = try std.process.getEnvVarOwned(allocator, "ZIGGY_PG_FIXTURE");
    defer allocator.free(info);
    if (!std.mem.startsWith(u8, info, "host=127.0.0.1 port=") or std.mem.indexOf(u8, info, " dbname=ziggy user=ziggy ") == null) return error.NotIsolatedPostgresFixture;
    const pool = try @import("../../db/pool.zig").Pool.init(allocator, info, .{ .max_connections = 1 });
    defer pool.deinit();
    const domain = 99993;
    {
        var lease = try pool.acquire(.{});
        defer lease.deinit();
        try seed(lease.connection(), domain);
    }
    const all = events(domain);
    var source_chain: fixture.Chain = .{ .head = 3, .tag = 3, .fork = 0xf3, .items = &all };
    var chain: @import("../../settings/types.zig").Chain = undefined;
    chain.protocol = .ethereum;
    chain.domain = domain;
    chain.index = .{ .from = 0, .chunk = 10, .mode = .block, .interval = 1 };
    chain.reorg = .{ .tag = "latest" };
    chain.contracts = .{ .mailbox = contracts.mailbox, .merkle_tree_hook = contracts.hook, .interchain_gas_paymaster = contracts.paymaster, .validator_announce = .{0} ** 32 };
    const service = try @import("service.zig").Pooled.init(allocator, pool, source_chain.interface(), &chain, "ziggy-pooled-scraper", 2000, .{});
    defer service.deinit();
    try std.testing.expectEqual(@as(usize, 0), pool.snapshot().leased);
    try std.testing.expectEqual(@as(u64, 3), (try service.headCycle(.{})).confirmed);
    {
        var bad = try pool.acquire(.{ .timeout_ms = 60 });
        defer bad.deinit();
        try std.testing.expectError(error.PostgresDeadlineExceeded, bad.connection().query("SELECT pg_sleep(5)", &.{}));
    }
    try std.testing.expectEqual(@as(u64, 3), (try service.headCycle(.{})).confirmed);
    var auxiliary = try service.auxiliary(.{});
    defer auxiliary.deinit();
    try std.testing.expectEqual(@as(u64, 1), try rows(auxiliary.store.connection, "SELECT count(*) AS count FROM confirmed_raw_message_dispatch WHERE origin_domain=99993"));
    try std.testing.expectEqual(@as(u64, 2), pool.snapshot().opened);
    try std.testing.expectEqual(@as(u64, 1), pool.snapshot().discarded);
}

test "scraper actual TaskSet validates DB then keeps independent chain lanes lazy and precancelled" {
    const task = @import("task.zig");
    const config = @import("../../settings/root.zig");
    const types = @import("../../settings/types.zig");
    var chain: types.Chain = undefined;
    chain.name = "isolated-lazy-scraper";
    chain.domain = 99994;
    chain.protocol = .ethereum;
    chain.index = .{ .chunk = 10 };
    var other = chain;
    other.name = "isolated-lazy-cosmos-scraper";
    other.domain = 99989;
    other.protocol = .cosmosnative;
    var chains = [_]types.Chain{ chain, other };
    const info = try std.process.getEnvVarOwned(allocator, "ZIGGY_PG_FIXTURE");
    defer allocator.free(info);
    if (!std.mem.startsWith(u8, info, "host=127.0.0.1 port=") or std.mem.indexOf(u8, info, " dbname=ziggy user=ziggy ") == null) return error.NotIsolatedPostgresFixture;
    var configured: config.Settings = undefined;
    configured.chains = &chains;
    configured.role = .{ .scraper = .{
        .ccr_routers = &.{
            .{ .domain = chain.domain, .router = .{1} ** 20, .token = .{2} ** 20 },
            .{ .domain = chain.domain, .router = .{3} ** 20, .token = .{4} ** 20 },
            .{ .domain = other.domain, .router = .{5} ** 20, .token = .{6} ** 20 },
        },
        .chains_to_scrape = &.{ chain.name, other.name },
        .db = info,
        .db_max_connections = 2,
        .db_acquire_timeout_ms = 100,
    } };
    var env = std.process.EnvMap.init(allocator);
    defer env.deinit();
    const library = std.process.getEnvVarOwned(allocator, "HYPERLANE_CURL_LIBRARY") catch return error.SkipZigTest;
    defer allocator.free(library);
    const tasks = try task.TaskSet.open(allocator, &configured, &env, .{ .curl_library = library });
    defer tasks.deinit();
    try std.testing.expectEqual(@as(usize, 9), tasks.descriptors().len);
    try std.testing.expectEqual(tasks.descriptors().len, tasks.initialized_lanes);
    try std.testing.expectEqual(@as(usize, 2), tasks.chains[0].routers.len);
    try std.testing.expectEqual(@as(usize, 0), tasks.chains[1].routers.len);
    try std.testing.expectEqual(@as(u8, 31), tasks.chains[0].required_mask);
    try std.testing.expectEqual(@as(u8, 15), tasks.chains[1].required_mask);
    var ordinary: [2]usize = .{ 0, 0 };
    var optional_ccr: [2]usize = .{ 0, 0 };
    for (tasks.lanes) |lane| {
        try std.testing.expect(lane.chain.configured.domain == chain.domain or lane.chain.configured.domain == other.domain);
        const index: usize = if (lane.chain.configured.domain == chain.domain) 0 else 1;
        if (lane.kind == .ccr) optional_ccr[index] += 1 else ordinary[index] += 1;
        try std.testing.expect(lane.ccr_lane == null and lane.ccr_page == null);
    }
    try std.testing.expectEqual([2]usize{ 4, 4 }, ordinary);
    try std.testing.expectEqual([2]usize{ 1, 0 }, optional_ccr);
    try std.testing.expectEqual(@as(u64, 1), tasks.database.snapshot().opened);
    var cancelled = std.atomic.Value(bool).init(true);
    for (tasks.descriptors(), 0..) |descriptor, index| {
        try std.testing.expectError(error.RequestCancelled, descriptor.run(descriptor.context, .{ .unix_ms = 1000, .monotonic_ms = 1000 }, &cancelled));
        for (tasks.descriptors()[0..index]) |previous| try std.testing.expect(previous.context != descriptor.context);
    }
    for (tasks.lanes) |lane| try std.testing.expect(lane.resources == null and lane.head_service == null);
    try std.testing.expectEqual(@as(u64, 1), tasks.database.snapshot().opened);
    try std.testing.expectEqual(@as(usize, 0), tasks.database.snapshot().leased);
}

test "scraper native PG unresolved source transaction metadata stays SQLNULL and never enters receipt pages" {
    var connection = try connect();
    defer connection.deinit();
    const domain = 99990;
    try seed(&connection, domain);
    var all = events(domain);
    all[2].tx_hash = null;
    all[3].tx_hash = null;
    var chain: fixture.Chain = .{ .head = 3, .tag = 3, .fork = 0xf4, .items = &all };
    const source = chain.interface();
    var store: head.Store = .{ .connection = &connection, .domain = domain, .writer_id = "ziggy-null-source-metadata" };
    try store.initialize(try source.header(.{ .height = 0 }), contracts);
    var worker: runtime.Worker(head.Store) = .{ .allocator = allocator, .source = source, .store = &store, .options = .{ .period = .latest, .chunk_size = 10 } };
    try std.testing.expectEqual(@as(u64, 3), (try worker.cycle()).confirmed);
    try std.testing.expectEqual(@as(u64, 1), try rows(&connection, "SELECT count(*) AS count FROM confirmed_delivered_message WHERE domain=99990 AND transaction_hash IS NULL"));
    try std.testing.expectEqual(@as(u64, 1), try rows(&connection, "SELECT count(*) AS count FROM confirmed_gas_payment WHERE domain=99990 AND transaction_hash IS NULL"));
    const receipts: storage.Store = .{ .connection = &connection, .domain = domain, .mailbox = contracts.mailbox };
    var delivery: enrich.Lane = .{ .stream = .delivery };
    var gas: enrich.Lane = .{ .stream = .gas };
    var delivery_page = try delivery.plan(allocator, receipts);
    defer delivery_page.deinit();
    var gas_page = try gas.plan(allocator, receipts);
    defer gas_page.deinit();
    try std.testing.expectEqual(@as(usize, 0), delivery_page.requests.len);
    try std.testing.expectEqual(@as(usize, 0), gas_page.requests.len);
}
