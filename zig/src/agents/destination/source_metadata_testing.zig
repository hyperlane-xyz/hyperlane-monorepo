//! Actual native HTTP replay plus native metadata builder. Public local fixture
//! contracts answer the same Solidity ABI/Tron wallet JSON used by the adapter.
const std = @import("std");
const source = @import("source_metadata.zig");
const resources = @import("../chain_source.zig");
const settings = @import("../../settings/types.zig");
const fixture = @import("../../evm/pool_testing.zig");
const abi = @import("../../evm/codecs.zig");
const metadata = @import("../../relayer/metadata.zig");
const parallel = @import("../../relayer/metadata_parallel.zig");
const protocol = @import("../../protocol/root.zig");
const objects = @import("../../storage/objects.zig");
const ccip = @import("../../relayer/ccip.zig");
const A = std.mem.Allocator;
const Hash = [32]u8;
const Address = [20]u8;
const History = struct {
    pub fn leafIndex(_: *History, _: Hash) !?u32 {
        return null;
    }
    pub fn highestKnownLeafIndex(_: *History) !?u32 {
        return null;
    }
    pub fn proof(_: *History, _: u32, _: protocol.Checkpoint) !protocol.Proof {
        return error.NoProof;
    }
    pub fn fetchCheckpoint(_: *History, _: Address, _: u32) !?objects.SignedCheckpoint {
        return null;
    }
    pub fn latestIndex(_: *History, _: Address) !?u32 {
        return null;
    }
};
fn respond(a: A, bytes: []const u8, estimate: bool, ccip_mode: bool) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer parsed.deinit();
    const object = parsed.value.object;
    const data = object.get("data").?.string;
    try std.testing.expectEqualStrings("41" ++ "07" ** 20, object.get("owner_address").?.string);
    const address = object.get("contract_address").?.string;
    var selector: [4]u8 = undefined;
    _ = try std.fmt.hexToBytes(&selector, data[0..8]);
    const last = try std.fmt.parseInt(u8, address[address.len - 2 ..], 16);
    var words: [192]u8 = .{0} ** 192;
    var length: usize = 32;
    if (std.mem.eql(u8, &selector, &abi.selector("moduleType()"))) {
        std.mem.writeInt(u256, words[0..32], if (last == 0x11) 2 else if (ccip_mode) 7 else 6, .big);
    } else if (std.mem.eql(u8, &selector, &abi.selector("modulesAndThreshold(bytes)"))) {
        std.mem.writeInt(u256, words[0..32], 64, .big);
        std.mem.writeInt(u256, words[32..64], if (ccip_mode) 1 else 2, .big);
        std.mem.writeInt(u256, words[64..96], if (ccip_mode) 1 else 3, .big);
        if (ccip_mode) {
            @memset(words[108..128], 3);
            length = 128;
        } else {
            words[127] = 0x22;
            words[159] = 0x33;
            words[191] = 0x44;
            length = words.len;
        }
    } else if (std.mem.eql(u8, &selector, &abi.selector("verify(bytes,bytes)"))) {
        // Physical read remains live until cancellation while later children
        // finish; absence of its response cannot block threshold completion.
        if (!ccip_mode and last == 0x22) return error.FixtureStall;
        std.mem.writeInt(u256, words[0..32], 1, .big);
    } else if (ccip_mode and std.mem.eql(u8, &selector, &abi.selector("getOffchainVerifyInfo(bytes)"))) {
        var parsed_lookup = try std.json.parseFromSlice(std.json.Value, a, @embedFile("../../relayer/testing/ccip-lookup.json"), .{});
        defer parsed_lookup.deinit();
        var encoded: std.ArrayList(u8) = .empty;
        defer encoded.deinit(a);
        for (parsed_lookup.value.object.get("chunks").?.array.items) |chunk| try encoded.appendSlice(a, chunk.string);
        return std.json.Stringify.valueAlloc(a, .{ .result = .{ .code = "CONTRACT_EXE_ERROR" }, .constant_result = .{encoded.items[2..]} }, .{});
    } else return error.UnexpectedMetadataFixtureCall;
    const hex = try a.alloc(u8, length * 2);
    defer a.free(hex);
    for (words[0..length], 0..) |byte, i| {
        hex[2 * i] = "0123456789abcdef"[byte >> 4];
        hex[2 * i + 1] = "0123456789abcdef"[byte & 15];
    }
    if (estimate) return std.json.Stringify.valueAlloc(a, .{ .result = .{ .result = true }, .energy_required = 10 }, .{});
    return std.json.Stringify.valueAlloc(a, .{ .result = .{ .result = true }, .constant_result = .{hex} }, .{});
}
fn chainFor(urls: []const []const u8) settings.Chain {
    return .{
        .name = "native-metadata-fixture",
        .domain = 2,
        .protocol = .tron,
        .chain_id = "1",
        .rpc_urls = urls,
        .grpc_urls = &.{},
        .index = .{},
        .contracts = .{ .mailbox = .{0} ** 31 ++ .{1}, .merkle_tree_hook = .{0} ** 31 ++ .{2}, .interchain_gas_paymaster = .{0} ** 32, .validator_announce = .{0} ** 31 ++ .{3} },
        .signer = .{ .hex_key = .{0x11} ** 32 },
        .identity = null,
        .ccs_signer = null,
        .reorg = .{ .blocks = 0 },
        .confirmations = 1,
        .estimated_block_time = 1,
        .native_token = .{ .decimals = 6, .symbol = "TRX", .denom = "sun" },
        .connection = .{ .tron = .{ .wallet_urls = urls, .wallet_solidity_urls = urls, .fee_multiplier = null } },
        .submitter = .classic,
        .max_batch_size = 1,
        .batch_contract_address = null,
        .bypass_batch_simulation = false,
        .max_submit_queue_length = null,
        .ignore_reorg_reports = false,
    };
}
test "native metadata actual Tron HTTP threshold finishes before stalled sibling with isolated replay forks" {
    try threshold(false);
}
test "native metadata cached Tron forks keep independent handlers and immutable classification" {
    try threshold(true);
}
fn threshold(comptime use_cache: bool) !void {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    var server = try WalletFixture.init();
    try server.start();
    defer server.deinit();
    const url = try server.url(a);
    defer a.free(url);
    var chain = chainFor(&.{url});
    const wallet_url = try std.fmt.allocPrint(a, "{s}/wallet", .{url});
    defer a.free(wallet_url);
    const solidity_url = try std.fmt.allocPrint(a, "{s}/walletsolidity", .{url});
    defer a.free(solidity_url);
    chain.connection.tron.wallet_urls = &.{wallet_url};
    chain.connection.tron.wallet_solidity_urls = &.{solidity_url};
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    try env.put("PRIVATE_TEST_KEY_DO_NOT_COPY", "fixture-only");
    var budget: resources.ReadReplay.ByteBudget = .{ .maximum = 1024 * 1024 };
    const http = try resources.HttpRuntime.Runtime.start(a, .{ .multi = .{ .library_path = library, .max_response_bytes = 8 * 1024 * 1024, .max_request_bytes = 65536, .max_reserved_bytes = 64 * 1024 * 1024, .max_pending = 32, .max_concurrent = 32 }, .max_sessions = 32 });
    defer http.deinit();
    const owner = try resources.Resources.open(a, &chain, &env, .{ .curl_library = library, .allow_insecure_loopback = true, .http_runtime = http, .read_budget = &budget, .rpc_max_response_bytes = 65536, .request_timeout_ms = 8000 });
    defer owner.deinit();
    var cache = try @import("../../relayer/contract_cache.zig").CacheFor(Hash).Cache.init(a, .{});
    defer cache.deinit();
    const executor = try parallel.Root.start(a, .{ .workers = 2 });
    // Join retiring jobs before borrowed resources/history/transport are freed.
    defer executor.deinit();
    var history: History = .{};
    var hooks: ForkHooks = .{ .allocator = a };
    const now = try @import("../scraper/receipts_evm.zig").nowNs();
    var root = source.Source(History).init(a, owner, &history, .{ .deadline_ns = now + 8 * std.time.ns_per_s, .executor = &executor.executor, .ccip_handler = hooks.handler(), .tron_sender = .{7} ** 20 });
    hooks.root_context = &root;
    var cancel = std.atomic.Value(bool).init(false);
    const first = try root.fork(a, &cancel);
    var first_live = true;
    defer if (first_live) first.deinitFork();
    const second = try root.fork(a, &cancel);
    var second_live = true;
    defer if (second_live) second.deinitFork();
    try std.testing.expect(first.readers.http_replay.? != second.readers.http_replay.?);
    try std.testing.expect(first.readers.clients.tron != second.readers.clients.tron);
    try std.testing.expect(first.readers.options.http_runtime == http and second.readers.options.http_runtime == http);
    try std.testing.expect(first.readers.chain.signer == null and first.readers.environment.get("PRIVATE_TEST_KEY_DO_NOT_COPY") == null);
    try std.testing.expect(first.readers.http_replay.?.config.max_attempt_ms <= 8000);
    try first.beginPass(&cancel);
    const ccip_bytes = try first.ccipMetadata(.{0} ** 31 ++ .{3}, .{ .origin = 1, .destination = 2 });
    defer a.free(ccip_bytes);
    first.endPass(null);
    try std.testing.expectEqualStrings("public native CCIP fixture", ccip_bytes);
    var timer = try std.time.Timer.start();
    const message: protocol.Message = .{ .origin = 1, .destination = 2, .body = "" };
    const module: Hash = .{0} ** 31 ++ .{0x11};
    const output = if (use_cache) cached_result: {
        const Cached = @import("../../relayer/cached_source.zig").CachedSource(@TypeOf(root));
        var wrapper = Cached.initBorrowed(a, &root, &cache, .{ .context = .{ .domain_name = chain.name, .context_hash = .{1} ** 32 }, .configs = &.{.{ .selector = .{ .app_context = "immutable-application" }, .module_types = &.{2}, .chains = null, .cache_policy = .ism_specific }} });
        wrapper.setMessage(module, "immutable-application", 1000);
        var builder: metadata.Builder(Cached) = .{ .allocator = a, .source = &wrapper, .executor = &executor.executor };
        break :cached_result try builder.build(module, message);
    } else uncached_result: {
        var builder: metadata.Builder(@TypeOf(root)) = .{ .allocator = a, .source = &root, .executor = &executor.executor };
        break :uncached_result try builder.build(module, message);
    };
    defer a.free(output);
    try std.testing.expect(timer.read() < 2 * std.time.ns_per_s);
    try std.testing.expect(server.stalled.load(.acquire) > 0);
    try std.testing.expectEqual(@as(usize, 24), output.len);
    try std.testing.expect(std.mem.allEqual(u8, output[0..8], 0));
    try std.testing.expectEqual(@as(u32, 24), std.mem.readInt(u32, output[8..12], .big));
    try std.testing.expectEqual(@as(u32, 24), std.mem.readInt(u32, output[16..20], .big));
    cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, first.beginPass(&cancel));
    var drain = try std.time.Timer.start();
    while (executor.executor.retainedJobs() != 0) {
        if (drain.read() > 2 * std.time.ns_per_s) return error.MetadataFixtureRetirementTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(@as(usize, 0), budget.used);
    try std.testing.expectEqual(@as(usize, 0), executor.executor.retainedOutputBytes());
    try std.testing.expect(hooks.created.load(.acquire) >= 5);
    try std.testing.expectEqual(hooks.created.load(.acquire) - 2, hooks.destroyed.load(.acquire));
    first.deinitFork();
    first_live = false;
    second.deinitFork();
    second_live = false;
    try std.testing.expectEqual(hooks.created.load(.acquire), hooks.destroyed.load(.acquire));
    try server.check();
}

const WalletFixture = struct {
    listener: std.net.Server,
    stop: std.atomic.Value(bool) = .init(false),
    failure: ?anyerror = null,
    stalled: std.atomic.Value(usize) = .init(0),
    lookups: std.atomic.Value(usize) = .init(0),
    ccip_mode: bool = false,
    thread: ?std.Thread = null,
    fn init() !WalletFixture {
        return .{ .listener = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}) };
    }
    fn start(self: *WalletFixture) !void {
        self.thread = try std.Thread.spawn(.{}, run, .{self});
    }
    fn url(self: *WalletFixture, a: A) ![]u8 {
        return std.fmt.allocPrint(a, "http://127.0.0.1:{d}", .{self.listener.listen_address.getPort()});
    }
    fn check(self: *WalletFixture) !void {
        if (self.failure) |failure| return failure;
    }
    fn deinit(self: *WalletFixture) void {
        self.stop.store(true, .release);
        if (self.thread) |thread| thread.join();
        self.listener.deinit();
    }
    fn run(self: *WalletFixture) void {
        self.serve() catch |failure| {
            self.failure = failure;
        };
    }
    fn serve(self: *WalletFixture) !void {
        var retained: [32]std.net.Stream = undefined;
        var retained_count: usize = 0;
        defer for (retained[0..retained_count]) |stream| stream.close();
        while (!self.stop.load(.acquire)) {
            var listen_fd = [_]std.posix.pollfd{.{ .fd = self.listener.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&listen_fd, 10) == 0) continue;
            const connection = try self.listener.accept();
            var retained_stream = false;
            defer if (!retained_stream) connection.stream.close();
            var buffer: [8192]u8 = undefined;
            var used: usize = 0;
            var body_at: ?usize = null;
            var content_length: ?usize = null;
            var timer = try std.time.Timer.start();
            while (body_at == null or content_length == null or used - body_at.? < content_length.?) {
                if (timer.read() > std.time.ns_per_s) return error.FixtureReadTimeout;
                var fd = [_]std.posix.pollfd{.{ .fd = connection.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
                if (try std.posix.poll(&fd, 10) == 0) continue;
                if (used == buffer.len) return error.FixtureRequestTooLarge;
                const got = try connection.stream.read(buffer[used..]);
                if (got == 0) return error.FixtureRequestEof;
                used += got;
                if (body_at == null) if (std.mem.indexOf(u8, buffer[0..used], "\r\n\r\n")) |end| {
                    body_at = end + 4;
                    var lines = std.mem.splitSequence(u8, buffer[0..end], "\r\n");
                    _ = lines.next();
                    while (lines.next()) |line| {
                        const colon = std.mem.indexOfScalar(u8, line, ':') orelse return error.FixtureBadHeader;
                        if (std.ascii.eqlIgnoreCase(line[0..colon], "content-length")) content_length = try std.fmt.parseInt(usize, std.mem.trim(u8, line[colon + 1 ..], " \t"), 10);
                    }
                };
            }
            const body = buffer[body_at.?..][0..content_length.?];
            const first_line_end = std.mem.indexOf(u8, buffer[0..used], "\r\n").?;
            const request_line = buffer[0..first_line_end];
            const estimate = std.mem.indexOf(u8, request_line, "/estimateenergy ") != null;
            if (!estimate and std.mem.indexOf(u8, request_line, "/triggerconstantcontract ") == null) return error.FixtureWrongWalletRoute;
            const lookup_selector = std.fmt.bytesToHex(abi.selector("getOffchainVerifyInfo(bytes)"), .lower);
            if (std.mem.indexOf(u8, body, &lookup_selector) != null) _ = self.lookups.fetchAdd(1, .acq_rel);
            const response = respond(std.heap.page_allocator, body, estimate, self.ccip_mode) catch |failure| {
                if (failure != error.FixtureStall) return failure;
                if (retained_count == retained.len) return error.FixtureTooManyStalls;
                retained[retained_count] = connection.stream;
                retained_count += 1;
                _ = self.stalled.fetchAdd(1, .release);
                retained_stream = true;
                continue;
            };
            defer std.heap.page_allocator.free(response);
            var header: [256]u8 = undefined;
            const text = try std.fmt.bufPrint(&header, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{response.len});
            connection.stream.writeAll(text) catch |failure| switch (failure) {
                error.BrokenPipe, error.ConnectionResetByPeer => continue,
                else => return failure,
            };
            connection.stream.writeAll(response) catch |failure| switch (failure) {
                error.BrokenPipe, error.ConnectionResetByPeer => continue,
                else => return failure,
            };
        }
    }
};

const ForkHooks = struct {
    allocator: A,
    root_context: ?*anyopaque = null,
    created: std.atomic.Value(usize) = .init(0),
    destroyed: std.atomic.Value(usize) = .init(0),
    fn handler(self: *ForkHooks) ccip.Handler {
        return .{ .context = self, .fetch_fn = unexpected, .native_fork_fn = forkRoot };
    }
    fn unexpected(_: *anyopaque, _: Address, _: protocol.Message) ![]u8 {
        return error.UnexpectedRootCcipFetch;
    }
    fn forkRoot(context: *anyopaque, a: A, lookup: ccip.LookupSource, _: u64, _: *const std.atomic.Value(bool)) !ccip.Handler {
        const self: *ForkHooks = @ptrCast(@alignCast(context));
        return self.clone(a, lookup);
    }
    fn clone(self: *ForkHooks, a: A, lookup: ccip.LookupSource) !ccip.Handler {
        if (lookup.context == self.root_context) return error.BorrowedMutableNativeLookup;
        const lease = try a.create(Lease);
        lease.* = .{ .allocator = a, .owner = self, .lookup = lookup };
        _ = self.created.fetchAdd(1, .acq_rel);
        return .{ .context = lease, .fetch_fn = Lease.fetch, .native_fork_fn = Lease.forkChild, .deinit_fn = Lease.deinit };
    }
    const Lease = struct {
        allocator: A,
        owner: *ForkHooks,
        lookup: ccip.LookupSource,
        fn fetch(context: *anyopaque, _: Address, _: protocol.Message) ![]u8 {
            const self: *Lease = @ptrCast(@alignCast(context));
            return self.allocator.dupe(u8, "public native CCIP fixture");
        }
        fn forkChild(context: *anyopaque, a: A, lookup: ccip.LookupSource, _: u64, _: *const std.atomic.Value(bool)) !ccip.Handler {
            const self: *Lease = @ptrCast(@alignCast(context));
            if (self.lookup.context == lookup.context) return error.ReusedMutableNativeLookup;
            return self.owner.clone(a, lookup);
        }
        fn deinit(context: *anyopaque) void {
            const self: *Lease = @ptrCast(@alignCast(context));
            _ = self.owner.destroyed.fetchAdd(1, .acq_rel);
            self.allocator.destroy(self);
        }
    };
};

const PublicCcip = struct {
    allocator: A,
    active: std.atomic.Value(bool) = .init(false),
    submits: std.atomic.Value(usize) = .init(0),
    polls: std.atomic.Value(usize) = .init(0),
    fn interface(self: *PublicCcip) ccip.AsyncTransport {
        return .{ .context = self, .has_active_fn = hasActive, .submit_fn = submit, .poll_fn = poll, .cancel_fn = cancel };
    }
    fn hasActive(context: *anyopaque) bool {
        const self: *PublicCcip = @ptrCast(@alignCast(context));
        return self.active.load(.acquire);
    }
    fn submit(context: *anyopaque, request: @import("../../net/curl.zig").Request) !void {
        const self: *PublicCcip = @ptrCast(@alignCast(context));
        try std.testing.expect(!self.active.swap(true, .acq_rel));
        try std.testing.expect(request.public_only and request.method == .get and request.body == null);
        const sender = try abi.hexAlloc(self.allocator, &(.{3} ** 20));
        defer self.allocator.free(sender);
        const expected = try std.fmt.allocPrint(self.allocator, "https://ccs.example/{s}/0x0011ff", .{sender});
        defer self.allocator.free(expected);
        try std.testing.expectEqualStrings(expected, request.url);
        _ = self.submits.fetchAdd(1, .acq_rel);
    }
    fn poll(context: *anyopaque) !?@import("../../net/curl.zig").Response {
        const self: *PublicCcip = @ptrCast(@alignCast(context));
        const count = self.polls.fetchAdd(1, .acq_rel);
        if (count % 3 != 2) return null;
        self.active.store(false, .release);
        return .{ .allocator = self.allocator, .status = 200, .http_version = 2, .body = try self.allocator.dupe(u8, "{\"data\":\"0x123456\"}"), .headers = &.{}, .header_storage = &.{} };
    }
    fn cancel(context: *anyopaque) void {
        const self: *PublicCcip = @ptrCast(@alignCast(context));
        self.active.store(false, .release);
    }
    fn origin(_: *anyopaque, _: Hash) !?[64]u8 {
        return .{0} ** 32 ++ .{0x77} ** 32;
    }
};
test "native EVM origin to Tron CCIP metadata uses actual wallet revert nativeFork and cached full32 wrapper" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    var server = try WalletFixture.init();
    server.ccip_mode = true;
    try server.start();
    defer server.deinit();
    const url = try server.url(a);
    defer a.free(url);
    const wallet = try std.fmt.allocPrint(a, "{s}/wallet", .{url});
    defer a.free(wallet);
    const solidity = try std.fmt.allocPrint(a, "{s}/walletsolidity", .{url});
    defer a.free(solidity);
    var chain = chainFor(&.{url});
    chain.connection.tron.wallet_urls = &.{wallet};
    chain.connection.tron.wallet_solidity_urls = &.{solidity};
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    const http = try resources.HttpRuntime.Runtime.start(a, .{ .multi = .{ .library_path = library, .max_response_bytes = 8 * 1024 * 1024, .max_reserved_bytes = 64 * 1024 * 1024, .max_pending = 32, .max_concurrent = 32 }, .max_sessions = 32 });
    defer http.deinit();
    const readers = try resources.Resources.open(a, &chain, &env, .{ .curl_library = library, .allow_insecure_loopback = true, .http_runtime = http, .rpc_max_response_bytes = 65536 });
    defer readers.deinit();
    var cache = try @import("../../relayer/contract_cache.zig").CacheFor(Hash).Cache.init(a, .{});
    defer cache.deinit();
    const sessions = @import("../relayer/ccip_sessions.zig");
    var owner = try sessions.Owner.init(a, .{ .allow_caching = false });
    defer owner.deinit();
    const executor = try parallel.Root.start(a, .{ .workers = 2 });
    defer executor.deinit();
    var history: History = .{};
    var public: PublicCcip = .{ .allocator = a };
    var cancel = std.atomic.Value(bool).init(false);
    const now_ns = try @import("../scraper/receipts_evm.zig").nowNs();
    const cache_context: @import("../../relayer/contract_cache.zig").Context = .{ .domain_name = chain.name, .context_hash = .{9} ** 32 };
    var root = source.Source(History).init(a, readers, &history, .{ .deadline_ns = now_ns + 5 * std.time.ns_per_s, .cancel = &cancel, .tron_sender = .{7} ** 20, .executor = &executor.executor, .lookup_cache = .{ .cache = &cache, .context = cache_context, .now_ms = now_ns / std.time.ns_per_ms } });
    const Cached = @import("../../relayer/cached_source.zig").CachedSource(@TypeOf(root));
    const module: Hash = .{0} ** 31 ++ .{0x11};
    const message: protocol.Message = .{ .version = 3, .origin = 1, .destination = 2, .sender = .{0} ** 31 ++ .{0x11}, .recipient = .{0} ** 31 ++ .{0x22}, .body = "EVM dispatch to Tron fixture" };
    // The public CCS response is injected; actual libcurl public-egress tests
    // remain strict and no DNS/network request is made to ccs.example.
    for (0..2) |_| {
        const bound = try owner.bind(.{ .allocator = a, .origin_store = .{ .context = &public, .dispatched_transaction_fn = PublicCcip.origin }, .client = null, .native_lookup = root.lookupSource(), .native = &readers.native, .block_number = 0, .now_ms = now_ns / std.time.ns_per_ms, .cancel = &cancel, .context_hash = cache_context.context_hash, .async_fixture = public.interface() });
        var bound_live = true;
        defer if (bound_live) bound.deinit();
        root.options.ccip_handler = bound.handler();
        var wrapper = Cached.initBorrowed(a, &root, &cache, .{ .context = cache_context, .configs = &.{.{ .selector = .{ .app_context = "fixture-application" }, .module_types = &.{2}, .chains = null, .cache_policy = .ism_specific }} });
        wrapper.setMessage(module, "fixture-application", now_ns / std.time.ns_per_ms);
        var builder: metadata.Builder(Cached) = .{ .allocator = a, .source = &wrapper, .executor = &executor.executor };
        const output = try builder.build(module, message);
        defer a.free(output);
        // Root handler can close before independent child bindings retire.
        bound.deinit();
        bound_live = false;
        root.options.ccip_handler = null;
        try std.testing.expectEqualSlices(u8, &.{ 0, 0, 0, 8, 0, 0, 0, 11, 0x12, 0x34, 0x56 }, output);
    }
    var timer = try std.time.Timer.start();
    while (executor.executor.retainedJobs() != 0) {
        if (timer.read() > 2 * std.time.ns_per_s) return error.MetadataFixtureRetirementTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(@as(usize, 1), server.lookups.load(.acquire));
    try std.testing.expectEqual(@as(usize, 2), public.submits.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), owner.stats().borrowed);
    try std.testing.expectEqual(@as(usize, 0), executor.executor.retainedOutputBytes());
    try server.check();
}
