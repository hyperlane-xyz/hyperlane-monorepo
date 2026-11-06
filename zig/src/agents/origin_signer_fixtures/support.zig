const std = @import("std");
const fixture_curl_library = if (@import("builtin").os.tag == .macos) "/usr/lib/libcurl.4.dylib" else "libcurl.so.4";
const resources = @import("../chain_source.zig");
const source = @import("../origin_signer_source.zig");
const protocol = @import("../../protocol/root.zig");
const types = @import("../../settings/types.zig");
const rpc = @import("../../evm/provider.zig");
const svm = @import("../../sealevel/provider.zig");
const A = std.mem.Allocator;

pub const deadline_ns = 30 * std.time.ns_per_s;

pub fn deadlineAfter(delay_ns: u64) !u64 {
    const now = std.time.nanoTimestamp();
    if (now < 0) return error.UnsupportedClock;
    return (std.math.cast(u64, now) orelse return error.UnsupportedClock) + delay_ns;
}

pub fn deadline() !u64 {
    return deadlineAfter(deadline_ns);
}

pub const Provenance = struct {
    hash: ?[64]u8,
    height: u64 = 7,
    canonical: ?[32]u8 = null,

    pub fn interface(self: *Provenance) source.Provenance {
        return .{ .context = self, .block_fn = block, .transaction_fn = transaction };
    }
    fn block(context: *anyopaque, message: protocol.Message) !u64 {
        const self: *Provenance = @ptrCast(@alignCast(context));
        if (self.canonical) |id| if (!std.mem.eql(u8, &id, &message.id())) return error.StaleCanonicalMessage;
        return self.height;
    }
    fn transaction(context: *anyopaque, _: [32]u8) !?[64]u8 {
        const self: *Provenance = @ptrCast(@alignCast(context));
        return self.hash;
    }
};

pub fn nativeHash(short: [32]u8) [64]u8 {
    return .{0} ** 32 ++ short;
}

pub const Step = struct {
    method: []const u8,
    result: []const u8,
    remote_error: bool = false,
    svm_signature: ?[]const u8 = null,
};

pub const Rpc = struct {
    fixture: Fixture = undefined,
    server: std.net.Server = undefined,
    thread: ?std.Thread = null,
    failure: ?anyerror = null,
    delay_ms: u32 = 0,

    const Fixture = struct {
        steps: []const Step,
        calls: usize = 0,

        fn exchange(context: *anyopaque, a: A, body: []const u8, _: rpc.Options) !rpc.WireResponse {
            const self: *Fixture = @ptrCast(@alignCast(context));
            if (self.calls >= self.steps.len) return error.UnexpectedOriginSignerRpc;
            const step = self.steps[self.calls];
            self.calls += 1;
            var parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
            defer parsed.deinit();
            const actual_method = try svm.string(try svm.field(parsed.value, "method"));
            try std.testing.expectEqualStrings(step.method, actual_method);
            if (step.svm_signature) |signature| {
                const params = try svm.field(parsed.value, "params");
                try std.testing.expectEqualStrings(signature, try svm.string(params.array.items[0]));
                const config = params.array.items[1];
                try std.testing.expectEqualStrings("jsonParsed", try svm.string(try svm.field(config, "encoding")));
                try std.testing.expectEqualStrings("finalized", try svm.string(try svm.field(config, "commitment")));
            }
            const id = try svm.field(parsed.value, "id");
            const bytes = if (step.remote_error)
                try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"error\":{{\"code\":-32000,\"message\":\"fixture\"}}}}", .{id.integer})
            else
                try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ id.integer, step.result });
            return .{ .bytes = bytes, .len = bytes.len };
        }
    };

    pub fn init(steps: []const Step) !Rpc {
        return .{ .fixture = .{ .steps = steps }, .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}) };
    }
    pub fn url(self: *Rpc, a: A) ![]u8 {
        return std.fmt.allocPrint(a, "http://127.0.0.1:{d}/", .{self.server.listen_address.getPort()});
    }
    pub fn start(self: *Rpc) !void {
        self.thread = try std.Thread.spawn(.{}, Rpc.serve, .{self});
    }
    fn serve(self: *Rpc) void {
        self.run() catch |err| {
            self.failure = err;
        };
    }
    fn run(self: *Rpc) !void {
        const a = std.testing.allocator;
        for (0..self.fixture.steps.len) |_| {
            var fds = [_]std.posix.pollfd{.{ .fd = self.server.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&fds, 5000) == 0) return error.FixtureTimeout;
            const connection = try self.server.accept();
            defer connection.stream.close();
            var bytes: [16384]u8 = undefined;
            var used: usize = 0;
            const body = while (true) {
                if (used == bytes.len) return error.FixtureRequestTooLarge;
                var input = [_]std.posix.pollfd{.{ .fd = connection.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
                if (try std.posix.poll(&input, 5000) == 0) return error.FixtureTimeout;
                const count = try connection.stream.read(bytes[used..]);
                if (count == 0) return error.FixtureEof;
                used += count;
                if (std.mem.indexOf(u8, bytes[0..used], "\r\n\r\n")) |end| {
                    const lower = std.mem.indexOf(u8, bytes[0..end], "content-length: ");
                    const upper = std.mem.indexOf(u8, bytes[0..end], "Content-Length: ");
                    const length_start = (lower orelse upper orelse return error.MissingContentLength) + "content-length: ".len;
                    const line_end = std.mem.indexOfPos(u8, bytes[0..used], length_start, "\r\n") orelse return error.MissingContentLength;
                    const len = try std.fmt.parseInt(usize, bytes[length_start..line_end], 10);
                    if (used < end + 4 + len) continue;
                    break bytes[end + 4 ..][0..len];
                }
            };
            const exchange: rpc.Exchange = .{ .context = &self.fixture, .fetch_fn = Fixture.exchange };
            const result = try exchange.fetch_fn(exchange.context, a, body, .{});
            defer a.free(result.bytes);
            if (self.delay_ms > 0) std.Thread.sleep(@as(u64, self.delay_ms) * std.time.ns_per_ms);
            var header: [200]u8 = undefined;
            const text = try std.fmt.bufPrint(&header, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{result.len});
            connection.stream.writeAll(text) catch return;
            connection.stream.writeAll(result.bytes[0..result.len]) catch return;
        }
    }
    pub fn deinit(self: *Rpc) void {
        if (self.thread) |thread| thread.join();
        self.server.deinit();
        if (self.failure) |err| std.debug.panic("origin signer RPC fixture failed: {s}", .{@errorName(err)});
        std.debug.assert(self.fixture.calls == self.fixture.steps.len);
    }
};

pub fn openResources(a: A, protocol_kind: types.Protocol, urls: []const []const u8, env: *std.process.EnvMap) !*resources.Resources {
    const ethereum: types.Connection = .{ .ethereum = .{ .consensus = .single, .consider_null_transaction_receipt = false, .fallback_hedge_delay_ms = null, .fallback_hedge_timeout_ms = null, .transaction_overrides = .{ .gas_price = null, .gas_limit = null, .max_fee_per_gas = null, .max_priority_fee_per_gas = null, .priority_fee_cap = null, .min_gas_price = null, .min_fee_per_gas = null, .min_priority_fee_per_gas = null, .gas_price_multiplier_denominator = null, .gas_price_multiplier_numerator = null, .gas_price_cap_multiplier = null, .gas_price_cap = null, .gas_limit_cap = null }, .mev_submission = null } };
    const sealevel: types.Connection = .{ .sealevel = .{ .max_supported_transaction_version = 0, .transaction_submitter = .rpc, .transaction_submitter_urls = &.{}, .priority_fee = 0, .priority_fee_oracle = .{ .constant = 0 }, .mailbox_process_alts = &.{}, .process_alt_overrides = &.{}, .ur_reveal = null, .native_token_decimals = 9 } };
    const cosmos: types.Cosmos = .{ .chain_id = "fixture-1", .bech32_prefix = "cosmos", .gas_price = .{ .amount = "1", .denom = "uatom" }, .contract_address_bytes = 32, .gas_multiplier = 1, .compat_mode = "0.38", .canonical_asset = "uatom" };
    const connection: types.Connection = switch (protocol_kind) {
        .ethereum => ethereum,
        .sealevel => sealevel,
        .cosmos => .{ .cosmos = cosmos },
        .cosmosnative => .{ .cosmosnative = cosmos },
        .starknet => .{ .starknet = .{ .native_token = .{1} ** 32 } },
        .radix => .{ .radix = .{ .gateway_urls = urls, .network_name = "localnet" } },
        .aleo => .{ .aleo = .{ .mailbox_program = "mailbox.aleo", .hook_manager_program = "hook.aleo", .ism_manager_program = "ism.aleo", .validator_announce_program = "announce.aleo", .proving_service_urls = &.{}, .priority_fee_multiplier = 1 } },
        .tron => .{ .tron = .{ .wallet_urls = urls, .wallet_solidity_urls = urls, .fee_multiplier = null } },
    };
    const chain: types.Chain = .{
        .name = "fixture",
        .domain = 1000,
        .protocol = protocol_kind,
        .chain_id = if (protocol_kind == .cosmos or protocol_kind == .cosmosnative) "fixture-1" else "1",
        .rpc_urls = urls,
        .grpc_urls = if (protocol_kind == .cosmos or protocol_kind == .cosmosnative) urls else &.{},
        .contracts = .{ .mailbox = .{0x11} ** 32, .interchain_gas_paymaster = .{0x12} ** 32, .validator_announce = .{0x13} ** 32, .merkle_tree_hook = .{0x14} ** 32 },
        .index = .{},
        .signer = null,
        .identity = null,
        .ccs_signer = null,
        .reorg = .{ .blocks = 0 },
        .confirmations = 0,
        .estimated_block_time = 1,
        .native_token = .{ .decimals = 6, .symbol = "FIX", .denom = "uatom" },
        .connection = connection,
        .submitter = .classic,
        .max_batch_size = 1,
        .batch_contract_address = null,
        .bypass_batch_simulation = false,
        .max_submit_queue_length = null,
        .ignore_reorg_reports = false,
    };
    return resources.Resources.open(a, &chain, env, .{ .curl_library = fixture_curl_library, .allow_insecure_loopback = true, .direct_native_transport = true, .request_timeout_ms = 5000, .rpc_max_response_bytes = 1024 * 1024 });
}
