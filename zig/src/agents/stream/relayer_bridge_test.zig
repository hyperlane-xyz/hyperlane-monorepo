const std = @import("std");
const bridge_mod = @import("relayer_bridge.zig");
const relayer = @import("relayer.zig");
const origins = @import("../origin_tasks.zig");
const resources = @import("../chain_source.zig");
const remote = @import("../../relayer/remote_checkpoints.zig");
const protocol = @import("../../protocol/root.zig");
const settings = @import("../../settings/types.zig");
const evm = @import("../../evm/indexer.zig");
const rpc = @import("../../evm/provider.zig");
const curl = @import("../../net/curl.zig");
const observer = @import("observer.zig");
const stream_metrics = @import("../../ops/stream_metrics.zig");
const metrics = @import("../../ops/metrics.zig");
const A = std.mem.Allocator;
const fixture_allocator = if (@import("builtin").is_test) std.testing.allocator else std.heap.page_allocator;
const domain = 99995;
const destination = domain;
const libcurl = switch (@import("builtin").os.tag) {
    .macos => "/usr/lib/libcurl.4.dylib",
    .linux => "libcurl.so.4",
    else => @compileError("unsupported native Curl fixture OS"),
};

const RecordingObserver = struct {
    allocator: A,
    changes: std.ArrayList(observer.Change) = .empty,

    fn deinit(self: *RecordingObserver) void {
        self.changes.deinit(self.allocator);
    }

    fn interface(self: *RecordingObserver) observer.Observer {
        return .{ .context = self, .notify_fn = notify };
    }

    fn notify(context: *anyopaque, _: []const u8, change: observer.Change) void {
        const self: *RecordingObserver = @ptrCast(@alignCast(context));
        self.changes.append(self.allocator, change) catch unreachable;
    }

    fn count(self: *const RecordingObserver, comptime tag: std.meta.Tag(observer.Change)) usize {
        var result: usize = 0;
        for (self.changes.items) |change| if (change == tag) {
            result += 1;
        };
        return result;
    }

    fn hasState(self: *const RecordingObserver, authority: bool) bool {
        for (self.changes.items) |change| switch (change) {
            .state => |state| if (state.authority == authority) return true,
            else => {},
        };
        return false;
    }

    fn hasEvent(self: *const RecordingObserver, kind: observer.EventType, result: observer.EventResult) bool {
        for (self.changes.items) |change| switch (change) {
            .event => |event| if (event.kind == kind and event.result == result) return true,
            else => {},
        };
        return false;
    }

    fn hasCursor(self: *const RecordingObserver, kind: observer.SequencedKind, sequence: u32) bool {
        for (self.changes.items) |change| switch (change) {
            .cursor => |cursor| if (cursor.kind == kind and cursor.sequence == sequence) return true,
            else => {},
        };
        return false;
    }
};

const TeeObserver = struct {
    recorder: *RecordingObserver,
    production: *stream_metrics.StreamMetrics,

    fn interface(self: *TeeObserver) observer.Observer {
        return .{ .context = self, .notify_fn = notify };
    }

    fn notify(context: *anyopaque, chain: []const u8, change: observer.Change) void {
        const self: *TeeObserver = @ptrCast(@alignCast(context));
        RecordingObserver.notify(self.recorder, chain, change);
        self.production.interface().notify(chain, change);
    }
};

fn metricSample(wire: []const u8, name: []const u8, labels: []const []const u8) !i64 {
    var lines = std.mem.splitScalar(u8, wire, '\n');
    lines: while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, name) or line.len <= name.len or line[name.len] != '{') continue;
        for (labels) |label| if (std.mem.indexOf(u8, line, label) == null) continue :lines;
        const split = std.mem.lastIndexOfScalar(u8, line, ' ') orelse return error.MissingMetricValue;
        return std.fmt.parseInt(i64, line[split + 1 ..], 10);
    }
    return error.MissingMetricSample;
}

fn testChain(url: []const u8, contracts: settings.Contracts) settings.Chain {
    return .{
        .name = "fixture",
        .domain = domain,
        .protocol = .ethereum,
        .chain_id = "31337",
        .technical_stack = .other,
        .rpc_urls = &.{url},
        .grpc_urls = &.{},
        .contracts = contracts,
        .index = .{ .from = 0, .chunk = 50, .interval = 1 },
        .signer = null,
        .identity = null,
        .ccs_signer = null,
        .reorg = .{ .blocks = 0 },
        .confirmations = 0,
        .estimated_block_time = 1,
        .native_token = .{ .decimals = 18, .symbol = "TEST", .denom = "test" },
        .connection = .{ .ethereum = .{
            .consensus = .single,
            .consider_null_transaction_receipt = false,
            .fallback_hedge_delay_ms = null,
            .fallback_hedge_timeout_ms = null,
            .transaction_overrides = std.mem.zeroes(settings.TransactionOverrides),
            .mev_submission = null,
        } },
        .submitter = .classic,
        .max_batch_size = 1,
        .batch_contract_address = null,
        .bypass_batch_simulation = false,
        .max_submit_queue_length = null,
        .ignore_reorg_reports = false,
    };
}

const Receipt = struct {
    contract_address: ?[20]u8,
};

const Chain = struct {
    allocator: A,
    client: rpc.RpcClient,
    account: [20]u8,

    fn init(allocator: A, url: []const u8, native_curl: *curl.Client) !Chain {
        var client = try rpc.RpcClient.init(allocator, url, .{ .native_transport = native_curl });
        errdefer client.deinit();
        var account: [20]u8 = undefined;
        for (0..100) |_| {
            var response = client.call("eth_accounts", .{}) catch {
                std.Thread.sleep(20 * std.time.ns_per_ms);
                continue;
            };
            defer response.deinit();
            const values = response.value().array.items;
            if (values.len > 0) {
                account = try evmAddress(values[0].string);
                return .{ .allocator = allocator, .client = client, .account = account };
            }
            std.Thread.sleep(20 * std.time.ns_per_ms);
        }
        return error.AnvilReadinessDeadline;
    }

    fn deinit(self: *Chain) void {
        self.client.deinit();
    }

    fn receipt(self: *Chain, hash: []const u8) !Receipt {
        for (0..100) |_| {
            var response = try self.client.call("eth_getTransactionReceipt", .{hash});
            defer response.deinit();
            const value = response.value();
            if (value == .null) {
                std.Thread.sleep(20 * std.time.ns_per_ms);
                continue;
            }
            const status = value.object.get("status") orelse return error.MissingReceiptStatus;
            if (!std.mem.eql(u8, status.string, "0x1")) {
                std.debug.print("fixture transaction reverted: {s}\n", .{hash});
                return error.TransactionFailed;
            }
            const address = value.object.get("contractAddress") orelse return .{ .contract_address = null };
            if (address == .null) return .{ .contract_address = null };
            return .{ .contract_address = try evmAddress(address.string) };
        }
        return error.TransactionNotMined;
    }

    fn send(self: *Chain, data: []const u8, to: ?[20]u8, value: ?u256) !Receipt {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        var transaction = std.json.ObjectMap.init(allocator);
        try transaction.put("from", .{ .string = try std.fmt.allocPrint(allocator, "0x{s}", .{std.fmt.bytesToHex(self.account, .lower)}) });
        try transaction.put("data", .{ .string = data });
        try transaction.put("gas", .{ .string = "0xe00000" });
        if (to) |address| try transaction.put("to", .{ .string = try std.fmt.allocPrint(allocator, "0x{s}", .{std.fmt.bytesToHex(address, .lower)}) });
        if (value) |amount| try transaction.put("value", .{ .string = try std.fmt.allocPrint(allocator, "0x{x}", .{amount}) });
        var response = try self.client.callEnvelope("eth_sendTransaction", .{std.json.Value{ .object = transaction }});
        defer response.deinit();
        if (response.isError()) {
            std.debug.print("fixture eth_sendTransaction failed: {s}\n", .{response.bytes});
            return error.RpcError;
        }
        return self.receipt(response.value().string) catch |err| {
            std.debug.print("fixture call selector: {s}\n", .{data[0..@min(data.len, 10)]});
            return err;
        };
    }
};

fn evmAddress(text: []const u8) ![20]u8 {
    const raw = if (std.mem.startsWith(u8, text, "0x")) text[2..] else text;
    if (raw.len != 40) return error.InvalidAddress;
    var result: [20]u8 = undefined;
    _ = try std.fmt.hexToBytes(&result, raw);
    return result;
}

fn cast(allocator: A, args: []const []const u8) ![]u8 {
    const result = try std.process.Child.run(.{ .allocator = allocator, .argv = args });
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    if (result.term != .Exited or result.term.Exited != 0) return error.CastFailed;
    return allocator.dupe(u8, std.mem.trim(u8, result.stdout, " \r\n\t"));
}

fn abiEncode(allocator: A, signature: []const u8, args: []const []const u8) ![]u8 {
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(allocator);
    try argv.append(allocator, "cast");
    try argv.append(allocator, "abi-encode");
    try argv.append(allocator, signature);
    for (args) |arg| try argv.append(allocator, arg);
    const encoded = try cast(allocator, argv.items);
    if (!std.mem.startsWith(u8, encoded, "0x")) return encoded;
    const stripped = try allocator.dupe(u8, encoded[2..]);
    allocator.free(encoded);
    return stripped;
}

fn calldata(allocator: A, signature: []const u8, args: []const []const u8) ![]u8 {
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(allocator);
    try argv.append(allocator, "cast");
    try argv.append(allocator, "calldata");
    try argv.append(allocator, signature);
    for (args) |arg| try argv.append(allocator, arg);
    return cast(allocator, argv.items);
}

const Produced = struct {
    message: protocol.Message,
    block_number: u64,
    block_hash: [32]u8,
    transaction_hash: [32]u8,
    log_index: u64,
};

fn padAddress(address: [20]u8) [32]u8 {
    var result: [32]u8 = @splat(0);
    result[12..32].* = address;
    return result;
}

fn addressText(allocator: A, address: [20]u8) ![]u8 {
    return std.fmt.allocPrint(allocator, "0x{s}", .{std.fmt.bytesToHex(address, .lower)});
}

fn hexAlloc(allocator: A, bytes: []const u8) ![]u8 {
    const alphabet = "0123456789abcdef";
    const result = try allocator.alloc(u8, 2 + bytes.len * 2);
    result[0..2].* = "0x".*;
    for (bytes, 0..) |byte, index| {
        result[2 + index * 2] = alphabet[byte >> 4];
        result[3 + index * 2] = alphabet[byte & 0x0f];
    }
    return result;
}

const Fixture = struct {
    allocator: A,
    temporary: std.testing.TmpDir,
    db_path: []u8,
    url: []u8,
    rpc_urls: [1][]const u8,
    anvil: std.process.Child,
    anvil_running: bool = false,
    native_curl: curl.Client,
    chain: Chain,
    owner: *origins.DatabaseOwner,
    engine: *remote.Engine,
    environment: std.process.EnvMap,
    chains: [2]settings.Chain,
    set: *origins.Set,
    server: WsServer,
    recipient: [20]u8,
    bodies: [2][]u8,
    produced: [2]Produced,

    fn create(mode: WsServer.Mode) !*Fixture {
        const allocator = fixture_allocator;
        const self = try allocator.create(Fixture);
        errdefer allocator.destroy(self);
        self.allocator = allocator;
        self.bodies = .{ &.{}, &.{} };
        errdefer for (self.bodies) |body| if (body.len > 0) allocator.free(body);
        self.temporary = std.testing.tmpDir(.{});
        errdefer self.temporary.cleanup();
        const directory = try self.temporary.dir.realpathAlloc(allocator, ".");
        defer allocator.free(directory);
        self.db_path = try std.fs.path.join(allocator, &.{ directory, "db" });
        errdefer allocator.free(self.db_path);
        const port = try freePort();
        const port_text = try std.fmt.allocPrint(allocator, "{d}", .{port});
        defer allocator.free(port_text);
        self.anvil = std.process.Child.init(&.{ "anvil", "--host", "127.0.0.1", "--port", port_text, "--chain-id", "31337", "--silent" }, allocator);
        try self.anvil.spawn();
        self.anvil_running = true;
        errdefer _ = self.anvil.kill() catch unreachable;
        self.native_curl = try curl.Client.init(allocator, libcurl);
        errdefer self.native_curl.deinit();
        self.url = try std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}", .{port});
        errdefer allocator.free(self.url);
        self.rpc_urls = .{self.url};
        self.chain = try Chain.init(allocator, self.url, &self.native_curl);
        errdefer self.chain.deinit();
        self.owner = try origins.DatabaseOwner.init(allocator, self.db_path);
        errdefer self.owner.deinit();
        self.engine = try remote.Engine.start(allocator, .{ .multi = .{ .library_path = libcurl }, .allow_insecure_loopback = true });
        errdefer self.engine.deinit();
        const contracts = try deployContracts(self);
        var chain_config = testChain(self.url, contracts);
        chain_config.rpc_urls = self.rpc_urls[0..];
        var late_config = chain_config;
        late_config.name = "fixture-late";
        late_config.domain = domain + 1;
        self.chains = .{ chain_config, late_config };
        self.environment = std.process.EnvMap.init(allocator);
        errdefer self.environment.deinit();
        self.set = try origins.Set.open(allocator, self.chains[0..], &self.environment, self.owner, self.engine, .{ .source = .{ .curl_library = libcurl, .cooperative_reads = true, .allow_insecure_loopback = true } });
        errdefer self.set.deinit();
        try self.readySlot(0);
        try self.produce(0);
        try self.produce(1);
        try self.backfill();
        self.server = try WsServer.init(self, mode);
        return self;
    }

    fn deinit(self: *Fixture) void {
        self.server.deinit();
        self.set.deinit();
        self.environment.deinit();
        self.engine.deinit();
        self.owner.deinit();
        self.chain.deinit();
        self.native_curl.deinit();
        if (self.anvil_running) _ = self.anvil.kill() catch unreachable;
        for (self.bodies) |body| if (body.len > 0) self.allocator.free(body);
        self.allocator.free(self.url);
        self.allocator.free(self.db_path);
        self.temporary.cleanup();
        self.allocator.destroy(self);
    }

    fn stopAnvil(self: *Fixture) !void {
        if (!self.anvil_running) return;
        _ = try self.anvil.kill();
        self.anvil_running = false;
    }

    fn readySlot(self: *Fixture, index: usize) !void {
        const slot = &self.set.slots[index];
        const chain = slot.chain;
        const network = try resources.Resources.open(self.allocator, chain, slot.environment, .{ .curl_library = libcurl, .cooperative_reads = true, .allow_insecure_loopback = true });
        errdefer network.deinit();
        slot.network = network;
        var cancel: std.atomic.Value(bool) = .init(false);
        while (true) {
            try network.beginReadPass(&cancel);
            var failure: ?anyerror = null;
            defer network.endReadPass(failure);
            const service = @import("../evm_origin.zig").Service.open(self.allocator, chain, if (network.rpc_client) |*client| client else return error.MissingEvmSourceClient, try self.owner.get(&cancel), self.engine, true) catch |err| {
                failure = err;
                if (err == error.PendingReadIo) continue;
                return err;
            };
            network.commitReadSection() catch |err| {
                failure = err;
                service.deinit();
                if (err == error.PendingReadIo or err == error.PendingReadSection) continue;
                return err;
            };
            slot.implementation = .{ .ethereum = service };
            slot.ready.store(true, .release);
            return;
        }
    }

    fn backfill(self: *Fixture) !void {
        var client = self.chain.client;
        const chain = self.set.slots[0].chain;
        var indexer = try evm.Indexer.init(self.allocator, &client, .{
            .chain_id = 31337,
            .domain = domain,
            .mailbox = chain.contracts.mailbox[12..32].*,
            .hook = chain.contracts.merkle_tree_hook[12..32].*,
            .paymaster = chain.contracts.interchain_gas_paymaster[12..32].*,
            .reorg_period = .{ .blocks = 0 },
        });
        try indexer.check();
        const height = try client.blockNumber();
        const tip = std.math.cast(u32, height) orelse return error.FixtureHeightOverflow;
        var dispatch = try indexer.fetch(.dispatch, .{ .from = 0, .to = tip }, height);
        defer dispatch.deinit();
        _ = try dispatch.store(self.set.slots[0].handle().?.store);
        var insertion = try indexer.fetch(.insertion, .{ .from = 0, .to = tip }, height);
        defer insertion.deinit();
        _ = try insertion.store(self.set.slots[0].handle().?.store);
        var gas = try indexer.fetch(.gas, .{ .from = 0, .to = tip }, height);
        defer gas.deinit();
        _ = try gas.store(self.set.slots[0].handle().?.store);
        if (dispatch.logs.len != self.produced.len) return error.UnexpectedDispatchCount;
        for (dispatch.logs, 0..) |log, index| {
            const message = try protocol.Message.decode((try log.event()).dispatch.message);
            if (!std.mem.eql(u8, &message.id(), &self.produced[index].message.id())) return error.UnexpectedMessage;
            self.produced[index].block_number = log.block_number;
            self.produced[index].block_hash = log.block_hash;
            self.produced[index].transaction_hash = log.transaction_hash;
            self.produced[index].log_index = log.log_index;
        }
    }

    fn produce(self: *Fixture, index: u32) !void {
        const contracts = self.set.slots[0].chain.contracts;
        self.bodies[index] = try std.fmt.allocPrint(self.allocator, "fixture message {d}", .{index});
        self.produced[index].message = .{
            .nonce = index,
            .origin = domain,
            .sender = padAddress(self.chain.account),
            .destination = destination,
            .recipient = padAddress(self.recipient),
            .body = self.bodies[index],
        };
        const message = self.produced[index].message;
        const recipient32 = try std.fmt.allocPrint(self.allocator, "0x{s}", .{std.fmt.bytesToHex(message.recipient, .lower)});
        defer self.allocator.free(recipient32);
        const body = try hexAlloc(self.allocator, message.body);
        defer self.allocator.free(body);
        const data = try calldata(self.allocator, "dispatch(uint32,bytes32,bytes)", &.{ "99995", recipient32, body });
        defer self.allocator.free(data);
        _ = try self.chain.send(data, contracts.mailbox[12..32].*, null);
        const encoded = try message.encodeAlloc(self.allocator);
        defer self.allocator.free(encoded);
        const encoded_text = try hexAlloc(self.allocator, encoded);
        defer self.allocator.free(encoded_text);
        const process_data = try calldata(self.allocator, "process(bytes,bytes)", &.{ "0x", encoded_text });
        defer self.allocator.free(process_data);
        _ = try self.chain.send(process_data, contracts.mailbox[12..32].*, null);
        const id_text = try std.fmt.allocPrint(self.allocator, "0x{s}", .{std.fmt.bytesToHex(message.id(), .lower)});
        defer self.allocator.free(id_text);
        const account = try addressText(self.allocator, self.chain.account);
        defer self.allocator.free(account);
        const igp_data = try calldata(self.allocator, "payForGas(bytes32,uint32,uint256,address)", &.{ id_text, "99995", "100", account });
        defer self.allocator.free(igp_data);
        _ = try self.chain.send(igp_data, contracts.interchain_gas_paymaster[12..32].*, 1000);
    }
};

fn freePort() !u16 {
    var server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{});
    defer server.deinit();
    return server.listen_address.getPort();
}

fn deployContracts(fixture: *Fixture) !settings.Contracts {
    const manifest = try std.fs.cwd().readFileAlloc(fixture.allocator, "zig/integration/.cache/contracts.json", 4 * 1024 * 1024);
    defer fixture.allocator.free(manifest);
    var parsed = try std.json.parseFromSlice(std.json.Value, fixture.allocator, manifest, .{});
    defer parsed.deinit();
    const contracts = parsed.value.object.get("contracts").?.object;
    const mailbox = try deploy(fixture, contracts.get("Mailbox").?.string, "constructor(uint32)", &.{"99995"});
    const mailbox_text = try addressText(fixture.allocator, mailbox);
    defer fixture.allocator.free(mailbox_text);
    const hook = try deploy(fixture, contracts.get("MerkleTreeHook").?.string, "constructor(address)", &.{mailbox_text});
    const required = try deploy(fixture, contracts.get("TestPostDispatchHook").?.string, null, &.{});
    const ism = try deploy(fixture, contracts.get("TestIsm").?.string, null, &.{});
    fixture.recipient = try deploy(fixture, contracts.get("TestRecipient").?.string, null, &.{});
    const igp = try deploy(fixture, contracts.get("TestInterchainGasPaymaster").?.string, null, &.{});
    const account = try addressText(fixture.allocator, fixture.chain.account);
    defer fixture.allocator.free(account);
    const ism_text = try addressText(fixture.allocator, ism);
    defer fixture.allocator.free(ism_text);
    const hook_text = try addressText(fixture.allocator, hook);
    defer fixture.allocator.free(hook_text);
    const required_text = try addressText(fixture.allocator, required);
    defer fixture.allocator.free(required_text);
    const init_data = try calldata(fixture.allocator, "initialize(address,address,address,address)", &.{ account, ism_text, hook_text, required_text });
    defer fixture.allocator.free(init_data);
    _ = try fixture.chain.send(init_data, mailbox, null);
    return .{ .mailbox = padAddress(mailbox), .interchain_gas_paymaster = padAddress(igp), .validator_announce = padAddress(required), .merkle_tree_hook = padAddress(hook) };
}

fn deploy(fixture: *Fixture, bytecode: []const u8, signature: ?[]const u8, args: []const []const u8) ![20]u8 {
    const encoded = if (signature) |sig| try abiEncode(fixture.allocator, sig, args) else try fixture.allocator.dupe(u8, "");
    defer fixture.allocator.free(encoded);
    const data = try std.fmt.allocPrint(fixture.allocator, "0x{s}{s}", .{ bytecode, encoded });
    defer fixture.allocator.free(data);
    const receipt = try fixture.chain.send(data, null, null);
    return receipt.contract_address orelse return error.MissingContractAddress;
}

const Frame = struct {
    opcode: u8,
    payload: []u8,
    fn deinit(self: Frame, allocator: A) void {
        allocator.free(self.payload);
    }
};

fn waitRead(stream: std.net.Stream) !void {
    var fds = [_]std.posix.pollfd{.{ .fd = stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
    if (try std.posix.poll(&fds, 5000) == 0) return error.FixtureReadTimeout;
}

fn readExact(stream: std.net.Stream, bytes: []u8) !void {
    var used: usize = 0;
    while (used < bytes.len) {
        try waitRead(stream);
        const count = try stream.read(bytes[used..]);
        if (count == 0) return error.FrameEof;
        used += count;
    }
}

fn readFrame(allocator: A, stream: std.net.Stream) !Frame {
    var header: [10]u8 = undefined;
    try readExact(stream, header[0..2]);
    const opcode = header[0] & 0x0f;
    if (header[1] & 0x80 == 0) return error.UnmaskedClientFrame;
    var length: u64 = header[1] & 0x7f;
    if (length == 126) {
        try readExact(stream, header[2..4]);
        length = std.mem.readInt(u16, header[2..4], .big);
    } else if (length == 127) {
        try readExact(stream, header[2..10]);
        length = std.mem.readInt(u64, header[2..10], .big);
    }
    var mask: [4]u8 = undefined;
    try readExact(stream, &mask);
    const payload = try allocator.alloc(u8, std.math.cast(usize, length) orelse return error.FrameTooLarge);
    errdefer allocator.free(payload);
    try readExact(stream, payload);
    for (payload, 0..) |*byte, index| byte.* ^= mask[index % 4];
    return .{ .opcode = opcode, .payload = payload };
}

fn writeFrame(stream: std.net.Stream, opcode: u8, payload: []const u8) !void {
    var header: [10]u8 = undefined;
    var length: usize = 2;
    header[0] = 0x80 | opcode;
    if (payload.len < 126) {
        header[1] = @intCast(payload.len);
    } else if (payload.len <= std.math.maxInt(u16)) {
        header[1] = 126;
        std.mem.writeInt(u16, header[2..4], @intCast(payload.len), .big);
        length = 4;
    } else {
        header[1] = 127;
        std.mem.writeInt(u64, header[2..10], payload.len, .big);
        length = 10;
    }
    try stream.writeAll(header[0..length]);
    try stream.writeAll(payload);
}

fn handshake(stream: std.net.Stream) !void {
    var request: [16 * 1024]u8 = undefined;
    var used: usize = 0;
    while (std.mem.indexOf(u8, request[0..used], "\r\n\r\n") == null) {
        if (used == request.len) return error.HandshakeTooLarge;
        try waitRead(stream);
        const count = try stream.read(request[used..]);
        if (count == 0) return error.HandshakeEof;
        used += count;
    }
    const key_start = std.mem.indexOf(u8, request[0..used], "Sec-WebSocket-Key: ") orelse return error.MissingWebsocketKey;
    const key_end = std.mem.indexOfPos(u8, request[0..used], key_start, "\r\n") orelse return error.MissingWebsocketKey;
    const key = request[key_start + "Sec-WebSocket-Key: ".len .. key_end];
    var hasher = std.crypto.hash.Sha1.init(.{});
    hasher.update(key);
    hasher.update("258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    var digest: [20]u8 = undefined;
    hasher.final(&digest);
    var accept: [28]u8 = undefined;
    _ = std.base64.standard.Encoder.encode(&accept, &digest);
    var response: [512]u8 = undefined;
    const text = try std.fmt.bufPrint(&response, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: {s}\r\n\r\n", .{accept});
    try stream.writeAll(text);
}

fn rejectHandshake(stream: std.net.Stream) !void {
    var request: [16 * 1024]u8 = undefined;
    var used: usize = 0;
    while (std.mem.indexOf(u8, request[0..used], "\r\n\r\n") == null) {
        if (used == request.len) return error.HandshakeTooLarge;
        try waitRead(stream);
        const count = try stream.read(request[used..]);
        if (count == 0) return error.HandshakeEof;
        used += count;
    }
    try stream.writeAll("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
}

const WsServer = struct {
    const Mode = enum { lifecycle, downgrade, ordinary_error };

    fixture: *Fixture,
    mode: Mode,
    listener: std.net.Server,
    thread: ?std.Thread = null,
    stop: std.atomic.Value(bool) = .init(false),
    http_503_sent: std.atomic.Value(bool) = .init(false),
    finish_first: std.atomic.Value(bool) = .init(false),
    resume_seed: std.atomic.Value(bool) = .init(false),
    second_backfilled: std.atomic.Value(bool) = .init(false),
    expanded_subscription: std.atomic.Value(bool) = .init(false),
    downgrade_sequenced_only: std.atomic.Value(bool) = .init(false),
    dispatch_events_sent: std.atomic.Value(usize) = .init(0),
    merkle_events_sent: std.atomic.Value(usize) = .init(0),
    gas_events_sent: std.atomic.Value(usize) = .init(0),
    failure: ?anyerror = null,

    fn init(fixture: *Fixture, mode: Mode) !WsServer {
        return .{ .fixture = fixture, .mode = mode, .listener = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}) };
    }

    fn url(self: *WsServer, allocator: A) ![]u8 {
        return std.fmt.allocPrint(allocator, "ws://127.0.0.1:{d}/events", .{self.listener.listen_address.getPort()});
    }

    fn start(self: *WsServer) !void {
        self.thread = try std.Thread.spawn(.{}, serve, .{self});
    }

    fn deinit(self: *WsServer) void {
        self.stop.store(true, .release);
        const wake = std.net.tcpConnectToAddress(self.listener.listen_address) catch null;
        if (wake) |stream| stream.close();
        if (self.thread) |thread| thread.join();
        self.listener.deinit();
        if (self.failure) |err| std.debug.panic("WS fixture failed: {s}", .{@errorName(err)});
    }

    fn serve(self: *WsServer) void {
        self.run() catch |err| {
            if (!self.stop.load(.acquire)) self.failure = err;
        };
    }

    fn run(self: *WsServer) !void {
        switch (self.mode) {
            .lifecycle => try self.runLifecycle(),
            .downgrade => try self.runDowngrade(),
            .ordinary_error => try self.runOrdinaryError(),
        }
    }

    fn runLifecycle(self: *WsServer) !void {
        for (0..3) |index| {
            if (index == 2) while (!self.resume_seed.load(.acquire) and !self.stop.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
            const connection = try self.listener.accept();
            defer connection.stream.close();
            if (index == 0) {
                try rejectHandshake(connection.stream);
                self.http_503_sent.store(true, .release);
                continue;
            }
            try handshake(connection.stream);
            if (index == 1) {
                try writeFrame(connection.stream, 0x1, "{\"type\":\"ready\",\"streamCursorVersions\":{\"gas_payment\":2}}");
            } else {
                try writeFrame(connection.stream, 0x1, "{\"type\":\"ready\",\"streamCursorVersions\":{\"gas_payment\":3}}");
            }
            const subscribe = try readFrame(self.fixture.allocator, connection.stream);
            defer subscribe.deinit(self.fixture.allocator);
            var parsed = try std.json.parseFromSlice(std.json.Value, self.fixture.allocator, subscribe.payload, .{});
            defer parsed.deinit();
            const streams = parsed.value.object.get("streams").?.array;
            if (index == 2) {
                var expanded = streams.items.len == 3;
                for (streams.items) |stream| {
                    const domains = stream.object.get("domains").?.array.items;
                    if (domains.len != 2 or domains[0].integer != domain or domains[1].integer != domain + 1) expanded = false;
                }
                self.expanded_subscription.store(expanded, .release);
            }
            // Source ACKs confirm cursor positions, without subscribe-only options.
            for (streams.items) |*subscribed_stream| {
                if (subscribed_stream.object.getPtr("cursors")) |cursors| {
                    for (cursors.array.items) |*cursor| _ = cursor.object.swapRemove("allowReplay");
                }
            }
            const ack = try std.json.Stringify.valueAlloc(self.fixture.allocator, .{ .type = "subscribed", .streams = std.json.Value{ .array = streams } }, .{});
            defer self.fixture.allocator.free(ack);
            try writeFrame(connection.stream, 0x1, ack);
            try self.backfill(connection.stream, streams, index == 2);
            if (index == 1) while (!self.finish_first.load(.acquire) and !self.stop.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
            if (index == 2) {
                self.second_backfilled.store(true, .release);
                while (!self.stop.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
            }
        }
    }

    fn v3Subscription(self: *WsServer, connection: std.net.Server.Connection) !std.json.Parsed(std.json.Value) {
        try handshake(connection.stream);
        try writeFrame(connection.stream, 0x1, "{\"type\":\"ready\",\"streamCursorVersions\":{\"gas_payment\":3}}");
        const subscribe = try readFrame(self.fixture.allocator, connection.stream);
        defer subscribe.deinit(self.fixture.allocator);
        return std.json.parseFromSlice(std.json.Value, self.fixture.allocator, subscribe.payload, .{});
    }

    fn acknowledgeSubscription(self: *WsServer, connection: std.net.Server.Connection, streams: std.json.Array) !void {
        for (streams.items) |*subscribed_stream| {
            if (subscribed_stream.object.getPtr("cursors")) |cursors| {
                for (cursors.array.items) |*cursor| _ = cursor.object.swapRemove("allowReplay");
            }
        }
        const ack = try std.json.Stringify.valueAlloc(self.fixture.allocator, .{ .type = "subscribed", .streams = std.json.Value{ .array = streams } }, .{});
        defer self.fixture.allocator.free(ack);
        try writeFrame(connection.stream, 0x1, ack);
    }

    fn runDowngrade(self: *WsServer) !void {
        for (0..2) |index| {
            const connection = try self.listener.accept();
            defer connection.stream.close();
            var parsed = try self.v3Subscription(connection);
            defer parsed.deinit();
            const streams = parsed.value.object.get("streams").?.array;
            if (index == 0) {
                if (streams.items.len != 3) return error.ExpectedGasSubscription;
                try writeFrame(connection.stream, 0x1, "{\"type\":\"error\",\"error\":\"cursors are only supported for sequenced streams\"}");
                continue;
            }
            if (streams.items.len != 2) return error.ExpectedSequencedOnlySubscription;
            self.downgrade_sequenced_only.store(true, .release);
            try self.acknowledgeSubscription(connection, streams);
            try self.backfill(connection.stream, streams, false);
            self.second_backfilled.store(true, .release);
            while (!self.stop.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
        }
    }

    fn runOrdinaryError(self: *WsServer) !void {
        const connection = try self.listener.accept();
        defer connection.stream.close();
        var parsed = try self.v3Subscription(connection);
        defer parsed.deinit();
        const streams = parsed.value.object.get("streams").?.array;
        if (streams.items.len != 3) return error.ExpectedGasSubscription;
        try writeFrame(connection.stream, 0x1, "{\"type\":\"error\",\"error\":\"temporary upstream failure\"}");
    }

    const Replay = struct { dispatch: ?i64 = null, merkle: ?i64 = null, gas: ?u64 = null };

    fn replayCursors(streams: std.json.Array) !Replay {
        var result: Replay = .{};
        for (streams.items) |stream| {
            const event_type = stream.object.get("eventType").?.string;
            const cursors = stream.object.get("cursors") orelse continue;
            if (cursors.array.items.len == 0) continue;
            const cursor = cursors.array.items[0];
            if (std.mem.eql(u8, event_type, relayer.EventKind.dispatch.label())) {
                if (cursor.object.get("afterSequence")) |value| result.dispatch = try std.fmt.parseInt(i64, value.string, 10);
            } else if (std.mem.eql(u8, event_type, relayer.EventKind.merkle_tree_insertion.label())) {
                if (cursor.object.get("afterSequence")) |value| result.merkle = try std.fmt.parseInt(i64, value.string, 10);
            } else if (std.mem.eql(u8, event_type, relayer.EventKind.gas_payment.label())) {
                if (cursor.object.get("afterStreamCursor")) |value| result.gas = try std.fmt.parseInt(u64, value.string, 10);
            }
        }
        return result;
    }

    fn backfill(self: *WsServer, stream: std.net.Stream, streams: std.json.Array, gas: bool) !void {
        const replay = try replayCursors(streams);
        for (self.fixture.produced, 0..) |event, index| {
            const message = event.message;
            const id = message.id();
            const id_text = try std.fmt.allocPrint(self.fixture.allocator, "0x{s}", .{std.fmt.bytesToHex(id, .lower)});
            defer self.fixture.allocator.free(id_text);
            const mailbox = try std.fmt.allocPrint(self.fixture.allocator, "0x{s}", .{std.fmt.bytesToHex(self.fixture.set.slots[0].chain.contracts.mailbox[12..], .lower)});
            defer self.fixture.allocator.free(mailbox);
            const hook = try std.fmt.allocPrint(self.fixture.allocator, "0x{s}", .{std.fmt.bytesToHex(self.fixture.set.slots[0].chain.contracts.merkle_tree_hook[12..], .lower)});
            defer self.fixture.allocator.free(hook);
            const tx = try std.fmt.allocPrint(self.fixture.allocator, "0x{s}", .{std.fmt.bytesToHex(event.transaction_hash, .lower)});
            defer self.fixture.allocator.free(tx);
            const block = try std.fmt.allocPrint(self.fixture.allocator, "0x{s}", .{std.fmt.bytesToHex(event.block_hash, .lower)});
            defer self.fixture.allocator.free(block);
            const sender = try std.fmt.allocPrint(self.fixture.allocator, "0x{s}", .{std.fmt.bytesToHex(message.sender, .lower)});
            defer self.fixture.allocator.free(sender);
            const recipient = try std.fmt.allocPrint(self.fixture.allocator, "0x{s}", .{std.fmt.bytesToHex(message.recipient, .lower)});
            defer self.fixture.allocator.free(recipient);
            const body = try hexAlloc(self.fixture.allocator, message.body);
            defer self.fixture.allocator.free(body);
            const dispatch = try std.fmt.allocPrint(self.fixture.allocator, "{{\"type\":\"event\",\"data\":{{\"destination_domain\":{d},\"id\":\"{d}\",\"msg_body\":\"{s}\",\"msg_id\":\"{s}\",\"nonce\":\"{d}\",\"origin_block_hash\":\"{s}\",\"origin_block_height\":\"{d}\",\"origin_domain\":{d},\"origin_mailbox\":\"{s}\",\"origin_tx_hash\":\"{s}\",\"recipient\":\"{s}\",\"sender\":\"{s}\",\"time_created\":\"fixture\"}},\"domain\":{d},\"eventType\":\"dispatch\",\"sequence\":\"{d}\"}}", .{ message.destination, index + 1, body, id_text, message.nonce, block, event.block_number, message.origin, mailbox, tx, recipient, sender, message.origin, message.nonce });
            defer self.fixture.allocator.free(dispatch);
            if (replay.dispatch) |after| if (after < @as(i64, @intCast(message.nonce))) {
                try writeFrame(stream, 0x1, dispatch);
                _ = self.dispatch_events_sent.fetchAdd(1, .acq_rel);
            };
            const merkle = try std.fmt.allocPrint(self.fixture.allocator, "{{\"type\":\"event\",\"data\":{{\"block_number\":\"{d}\",\"domain\":{d},\"leaf_index\":\"{d}\",\"merkle_tree_hook\":\"{s}\",\"message_id\":\"{s}\"}},\"domain\":{d},\"eventType\":\"merkle_tree_insertion\",\"sequence\":\"{d}\"}}", .{ event.block_number, message.origin, index, hook, id_text, message.origin, index });
            defer self.fixture.allocator.free(merkle);
            if (replay.merkle) |after| if (after < @as(i64, @intCast(index))) {
                try writeFrame(stream, 0x1, merkle);
                _ = self.merkle_events_sent.fetchAdd(1, .acq_rel);
            };
            if (gas) {
                const paymaster = try std.fmt.allocPrint(self.fixture.allocator, "0x{s}", .{std.fmt.bytesToHex(self.fixture.set.slots[0].chain.contracts.interchain_gas_paymaster[12..], .lower)});
                defer self.fixture.allocator.free(paymaster);
                const payment = try std.fmt.allocPrint(self.fixture.allocator, "{{\"type\":\"event\",\"data\":{{\"destination\":{d},\"domain\":{d},\"gas_amount\":\"100\",\"id\":\"{d}\",\"interchain_gas_paymaster\":\"{s}\",\"log_index\":\"{d}\",\"msg_id\":\"{s}\",\"origin\":{d},\"origin_block_hash\":\"{s}\",\"origin_block_height\":\"{d}\",\"origin_tx_hash\":\"{s}\",\"payment\":\"1000\",\"sequence\":\"{d}\",\"time_created\":\"fixture\",\"tx_id\":null}},\"domain\":{d},\"eventType\":\"gas_payment\",\"legacyMaxStreamCursor\":\"0\",\"rowId\":\"{d}\",\"streamCursor\":\"{d}\"}}", .{ message.destination, message.origin, index + 1, paymaster, index, id_text, message.origin, block, event.block_number, tx, index, message.origin, index + 1, index + 1 });
                defer self.fixture.allocator.free(payment);
                if (replay.gas) |after| if (after < index + 1) {
                    try writeFrame(stream, 0x1, payment);
                    _ = self.gas_events_sent.fetchAdd(1, .acq_rel);
                };
            }
        }
        const dispatch_caught = try std.fmt.allocPrint(self.fixture.allocator, "{{\"type\":\"caught_up\",\"address\":\"0x{s}\",\"domain\":{d},\"eventType\":\"dispatch\",\"sequence\":\"1\"}}", .{ std.fmt.bytesToHex(self.fixture.set.slots[0].chain.contracts.mailbox[12..], .lower), domain });
        defer self.fixture.allocator.free(dispatch_caught);
        try writeFrame(stream, 0x1, dispatch_caught);
        const merkle_caught = try std.fmt.allocPrint(self.fixture.allocator, "{{\"type\":\"caught_up\",\"address\":\"0x{s}\",\"domain\":{d},\"eventType\":\"merkle_tree_insertion\",\"sequence\":\"1\"}}", .{ std.fmt.bytesToHex(self.fixture.set.slots[0].chain.contracts.merkle_tree_hook[12..], .lower), domain });
        defer self.fixture.allocator.free(merkle_caught);
        try writeFrame(stream, 0x1, merkle_caught);
        if (gas) {
            const gas_caught = try std.fmt.allocPrint(self.fixture.allocator, "{{\"type\":\"caught_up\",\"address\":\"0x{s}\",\"domain\":{d},\"eventType\":\"gas_payment\",\"legacyMaxStreamCursor\":\"0\",\"streamCursor\":\"2\"}}", .{ std.fmt.bytesToHex(self.fixture.set.slots[0].chain.contracts.interchain_gas_paymaster[12..], .lower), domain });
            defer self.fixture.allocator.free(gas_caught);
            try writeFrame(stream, 0x1, gas_caught);
        }
    }
};

fn poll(bridge: *bridge_mod.Bridge, cancel: *std.atomic.Value(bool)) !void {
    const now: u64 = @intCast(std.time.milliTimestamp());
    _ = try bridge_mod.Bridge.poll(bridge, .{ .unix_ms = now, .monotonic_ms = now }, cancel);
}

fn acknowledge(slot: *origins.Slot) void {
    const command = slot.authority.snapshot();
    _ = slot.authority.acknowledge(command.generation, command.requested);
}

pub fn runNativeFixture() !void {
    const fixture = try Fixture.create(.lifecycle);
    defer fixture.deinit();
    const url = try fixture.server.url(fixture_allocator);
    defer fixture_allocator.free(url);
    var recorder: RecordingObserver = .{ .allocator = fixture_allocator };
    defer recorder.deinit();
    const registry = try metrics.Registry.init(fixture_allocator, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const adapter = try stream_metrics.StreamMetrics.init(fixture_allocator, registry, .{});
    defer adapter.deinit();
    var tee: TeeObserver = .{ .recorder = &recorder, .production = adapter };
    const options: bridge_mod.Options = .{
        .url = url,
        .origins = fixture.set,
        .controller = .{ .authority_enabled = true, .parity_retry_attempts = 2, .parity_retry_delay_ms = 1, .progress_grace_ms = 1, .authoritative_probe_interval_ms = 50 },
        .transport = .{ .transport = .{ .library_path = libcurl }, .retry_delay_ns = std.time.ns_per_ms, .wake = undefined, .max_events = 4 },
        .observer = tee.interface(),
        .probe_timeout_ms = 1000,
        .max_events_per_poll = 1,
    };
    const bridge = try bridge_mod.Bridge.init(fixture_allocator, options);
    defer bridge.deinit();
    try fixture.server.start();
    var cancel: std.atomic.Value(bool) = .init(false);
    const slot = &fixture.set.slots[0];
    try std.testing.expect(!bridge.owner.snapshot().thread_started);
    try poll(bridge, &cancel);
    try std.testing.expect(bridge.owner.snapshot().thread_started);
    try std.testing.expect(bridge.descriptor().stop_fn != null);
    acknowledge(slot);
    const state = bridge.origins.get(domain) orelse return error.MissingOriginState;
    try std.testing.expect(fixture.set.slots[1].handle() == null);
    var deadline = std.time.milliTimestamp() + 15000;
    while (try state.controller.rpcRequired(domain)) {
        if (std.time.milliTimestamp() > deadline) {
            if (bridge.last_error) |err| std.debug.print("bridge error: {s}\n", .{@errorName(err)});
            if (fixture.server.failure) |err| std.debug.print("server error: {s}\n", .{@errorName(err)});
            return error.FirstCutoverDeadline;
        }
        try poll(bridge, &cancel);
        acknowledge(slot);
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(!try state.controller.gasAuthority(domain));
    const first_generation = slot.authority.snapshot().generation;
    const first_mask = slot.authority.snapshot().requested;
    try std.testing.expect(first_mask.dispatch and first_mask.insertion and !first_mask.gas);
    try std.testing.expect(fixture.server.http_503_sent.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), fixture.server.dispatch_events_sent.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), fixture.server.merkle_events_sent.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), fixture.server.gas_events_sent.load(.acquire));
    const first_render = try registry.render(fixture_allocator);
    defer fixture_allocator.free(first_render);
    try std.testing.expectEqual(@as(i64, 1), try metricSample(first_render, "hyperlane_relayer_scraper_websocket_active", &.{"chain=\"fixture\""}));
    try std.testing.expectEqual(@as(i64, 1), try metricSample(first_render, "hyperlane_relayer_scraper_websocket_authority", &.{"chain=\"fixture\""}));
    try std.testing.expectEqual(@as(i64, 1), try metricSample(first_render, "hyperlane_relayer_scraper_websocket_caught_up", &.{"event_type=\"dispatch\""}));
    try std.testing.expectEqual(@as(i64, 1), try metricSample(first_render, "hyperlane_cursor_current_sequence", &.{ "event_type=\"hyperlane_message\"", "cursor_type=\"forward_sequenced\"" }));
    try fixture.readySlot(1);
    fixture.server.finish_first.store(true, .release);

    deadline = std.time.milliTimestamp() + 15000;
    while (!try state.controller.rpcRequired(domain)) {
        if (std.time.milliTimestamp() > deadline) {
            std.debug.print("fallback state online={} subscribed={} socket_gen={d} owner_gen={d} probe={}\n", .{ bridge.online, bridge.subscribed, bridge.socket_generation, bridge.owner.snapshot().generation, state.probe != null });
            if (bridge.last_error) |err| std.debug.print("bridge error: {s}\n", .{@errorName(err)});
            if (fixture.server.failure) |err| std.debug.print("server error: {s}\n", .{@errorName(err)});
            return error.FallbackDeadline;
        }
        try poll(bridge, &cancel);
        acknowledge(slot);
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(!try state.controller.gasAuthority(domain));
    try std.testing.expect(!slot.authority.acknowledge(first_generation, first_mask));
    const fallback_render = try registry.render(fixture_allocator);
    defer fixture_allocator.free(fallback_render);
    std.debug.print("native fallback metrics:\n{s}\n", .{fallback_render});
    try std.testing.expectEqual(@as(i64, 0), try metricSample(fallback_render, "hyperlane_relayer_scraper_websocket_active", &.{"chain=\"fixture\""}));
    try std.testing.expectEqual(@as(i64, 0), try metricSample(fallback_render, "hyperlane_relayer_scraper_websocket_authority", &.{"chain=\"fixture\""}));
    try std.testing.expectEqual(@as(i64, 0), try metricSample(fallback_render, "hyperlane_relayer_scraper_websocket_fresh", &.{"chain=\"fixture\""}));
    try std.testing.expectEqual(@as(i64, 0), try metricSample(fallback_render, "hyperlane_relayer_scraper_websocket_caught_up", &.{"event_type=\"dispatch\""}));
    try std.testing.expectEqual(@as(i64, 0), try metricSample(fallback_render, "hyperlane_relayer_scraper_websocket_parity_pending", &.{"event_type=\"dispatch\""}));
    try state.adapter.storeGasPaymentCursor(.{ .fingerprint = null, .legacy_max_stream_cursor = 0, .stream_cursor = 0 });
    fixture.server.resume_seed.store(true, .release);

    deadline = std.time.milliTimestamp() + 15000;
    while ((try state.controller.rpcRequired(domain)) or !try state.controller.gasAuthority(domain)) {
        if (std.time.milliTimestamp() > deadline) return error.ReconnectCutoverDeadline;
        try poll(bridge, &cancel);
        acknowledge(slot);
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(fixture.server.second_backfilled.load(.acquire));
    const gas_subscription = try state.controller.subscription(domain, .gas_payment);
    try std.testing.expectEqual(@as(u64, 2), gas_subscription.after_stream_cursor.?);
    try std.testing.expectEqual(@as(usize, 1), fixture.server.dispatch_events_sent.load(.acquire));
    try std.testing.expectEqual(@as(usize, 1), fixture.server.merkle_events_sent.load(.acquire));
    try std.testing.expectEqual(@as(usize, 2), fixture.server.gas_events_sent.load(.acquire));
    try std.testing.expect(fixture.server.expanded_subscription.load(.acquire));
    try std.testing.expectEqual(@as(usize, 2), bridge.origins.count());
    const late_state = bridge.origins.get(domain + 1) orelse return error.MissingLateOriginState;
    try std.testing.expect(try late_state.controller.rpcRequired(domain + 1));
    try std.testing.expect(fixture.server.failure == null);
    const resume_render = try registry.render(fixture_allocator);
    defer fixture_allocator.free(resume_render);
    std.debug.print("native resumed metrics:\n{s}\n", .{resume_render});
    try std.testing.expectEqual(@as(i64, 1), try metricSample(resume_render, "hyperlane_relayer_scraper_websocket_authority", &.{"chain=\"fixture\""}));
    try std.testing.expectEqual(@as(i64, 1), try metricSample(resume_render, "hyperlane_relayer_scraper_websocket_caught_up", &.{"event_type=\"dispatch\""}));
    try std.testing.expectEqual(@as(i64, 1), try metricSample(resume_render, "hyperlane_relayer_scraper_websocket_parity", &.{ "event_type=\"dispatch\"", "result=\"match\"" }));
    try std.testing.expectEqual(@as(i64, 2), try metricSample(resume_render, "hyperlane_relayer_scraper_websocket_events", &.{ "event_type=\"gas_payment\"", "result=\"accepted\"" }));
    try std.testing.expectEqual(@as(i64, 1), try metricSample(resume_render, "hyperlane_cursor_current_sequence", &.{ "event_type=\"hyperlane_message\"", "cursor_type=\"forward_sequenced\"" }));
    try std.testing.expectEqual(@as(i64, 1), try metricSample(resume_render, "hyperlane_cursor_max_sequence", &.{"event_type=\"hyperlane_message\""}));

    const probe = state.probe orelse return error.MissingCanonicalProbe;
    const previous_runs = probe.runs.load(.acquire);
    deadline = std.time.milliTimestamp() + 15000;
    while (probe.runs.load(.acquire) == previous_runs or probe.plan != null) {
        if (std.time.milliTimestamp() > deadline) return error.AuthoritativeAuditDeadline;
        try poll(bridge, &cancel);
        acknowledge(slot);
        std.Thread.sleep(std.time.ns_per_ms);
    }
    const idle_runs = probe.runs.load(.acquire);
    const idle_changes = recorder.changes.items.len;
    for (0..5) |_| {
        try poll(bridge, &cancel);
        acknowledge(slot);
        try std.testing.expectEqual(idle_runs, probe.runs.load(.acquire));
        try std.testing.expectEqual(idle_changes, recorder.changes.items.len);
    }
    std.Thread.sleep(60 * std.time.ns_per_ms);
    deadline = std.time.milliTimestamp() + 15000;
    while (probe.runs.load(.acquire) == idle_runs) {
        if (std.time.milliTimestamp() > deadline) return error.AuthoritativeAuditDeadline;
        try poll(bridge, &cancel);
        acknowledge(slot);
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(!try state.controller.rpcRequired(domain));

    try fixture.stopAnvil();
    deadline = std.time.milliTimestamp() + 15000;
    while (!try state.controller.rpcRequired(domain)) {
        if (std.time.milliTimestamp() > deadline) return error.AuthoritativeFallbackDeadline;
        try poll(bridge, &cancel);
        acknowledge(slot);
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(try state.controller.rpcRequired(domain));
    try std.testing.expectEqual(@as(usize, 0), bridge.owner.snapshot().retained_events);
    const outage_render = try registry.render(fixture_allocator);
    defer fixture_allocator.free(outage_render);
    std.debug.print("native outage metrics:\n{s}\n", .{outage_render});
    try std.testing.expectEqual(@as(i64, 0), try metricSample(outage_render, "hyperlane_relayer_scraper_websocket_authority", &.{"chain=\"fixture\""}));
    try std.testing.expectEqual(@as(i64, 0), try metricSample(outage_render, "hyperlane_relayer_scraper_websocket_fresh", &.{"chain=\"fixture\""}));
    try std.testing.expectEqual(@as(u64, 0), adapter.failures.load(.acquire));
    try std.testing.expectEqual(@as(usize, 2), recorder.count(.initial));
    try std.testing.expect(recorder.hasState(true));
    try std.testing.expect(recorder.hasState(false));
    try std.testing.expect(recorder.hasEvent(.gas_payment, .accepted));
    try std.testing.expect(recorder.hasEvent(.dispatch, .accepted));
    try std.testing.expect(recorder.hasCursor(.dispatch, 1));
    try std.testing.expect(recorder.hasCursor(.merkle_tree_insertion, 1));
    try std.testing.expectEqual(@as(usize, 2), recorder.count(.parity));

    bridge.descriptor().stop_fn.?(bridge);
    try std.testing.expect(bridge.stopping.load(.acquire));
    cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, poll(bridge, &cancel));
}

test "native WS Rocks backfill cutover disconnect reconnect stale generation and gas versions" {
    try runNativeFixture();
}

pub fn runGasDowngradeFixture() !void {
    {
        const fixture = try Fixture.create(.downgrade);
        defer fixture.deinit();
        const url = try fixture.server.url(fixture_allocator);
        defer fixture_allocator.free(url);
        const bridge = try bridge_mod.Bridge.init(fixture_allocator, .{
            .url = url,
            .origins = fixture.set,
            .controller = .{ .authority_enabled = true, .parity_retry_attempts = 2, .parity_retry_delay_ms = 1, .progress_grace_ms = 1, .authoritative_probe_interval_ms = 50 },
            .transport = .{ .transport = .{ .library_path = libcurl }, .retry_delay_ns = std.time.ns_per_ms, .wake = undefined, .max_events = 4 },
            .probe_timeout_ms = 1000,
            .max_events_per_poll = 1,
        });
        defer bridge.deinit();
        try fixture.server.start();
        var cancel: std.atomic.Value(bool) = .init(false);
        const slot = &fixture.set.slots[0];
        try poll(bridge, &cancel);
        acknowledge(slot);
        const state = bridge.origins.get(domain) orelse return error.MissingOriginState;
        const deadline = std.time.milliTimestamp() + 15000;
        while (try state.controller.rpcRequired(domain)) {
            if (std.time.milliTimestamp() > deadline) return error.GasDowngradeDeadline;
            try poll(bridge, &cancel);
            acknowledge(slot);
            std.Thread.sleep(std.time.ns_per_ms);
        }
        try std.testing.expect(bridge.gas_row_unsupported);
        try std.testing.expect(fixture.server.downgrade_sequenced_only.load(.acquire));
        try std.testing.expect(fixture.server.second_backfilled.load(.acquire));
        try std.testing.expect(!try state.controller.gasAuthority(domain));
        try std.testing.expect(fixture.server.failure == null);
        bridge.descriptor().stop_fn.?(bridge);
    }
    {
        const fixture = try Fixture.create(.ordinary_error);
        defer fixture.deinit();
        const url = try fixture.server.url(fixture_allocator);
        defer fixture_allocator.free(url);
        const bridge = try bridge_mod.Bridge.init(fixture_allocator, .{
            .url = url,
            .origins = fixture.set,
            .controller = .{ .authority_enabled = true, .parity_retry_attempts = 2, .parity_retry_delay_ms = 1, .progress_grace_ms = 1, .authoritative_probe_interval_ms = 50 },
            .transport = .{ .transport = .{ .library_path = libcurl }, .retry_delay_ns = std.time.ns_per_ms, .wake = undefined, .max_events = 4 },
            .probe_timeout_ms = 1000,
            .max_events_per_poll = 1,
        });
        defer bridge.deinit();
        try fixture.server.start();
        var cancel: std.atomic.Value(bool) = .init(false);
        const slot = &fixture.set.slots[0];
        const state = blk: {
            try poll(bridge, &cancel);
            acknowledge(slot);
            break :blk bridge.origins.get(domain) orelse return error.MissingOriginState;
        };
        const deadline = std.time.milliTimestamp() + 15000;
        while (bridge.last_error == null or bridge.last_error.? != error.RejectedStream) {
            if (std.time.milliTimestamp() > deadline) return error.OrdinaryErrorDeadline;
            try poll(bridge, &cancel);
            acknowledge(slot);
            std.Thread.sleep(std.time.ns_per_ms);
        }
        try std.testing.expect(!bridge.gas_row_unsupported);
        for (0..5) |_| {
            try poll(bridge, &cancel);
            acknowledge(slot);
            try std.testing.expect(try state.controller.rpcRequired(domain));
        }
        bridge.descriptor().stop_fn.?(bridge);
    }
}

test "native gas row cursor downgrade and ordinary error control" {
    try runGasDowngradeFixture();
}
