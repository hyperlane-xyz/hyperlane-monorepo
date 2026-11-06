//! Production-default chain transport, using actual native HTTP on loopback.
const std = @import("std");
const source = @import("chain_source.zig");
const fixture = @import("../evm/pool_testing.zig");
const http = @import("../cloud/http.zig");
const Curl = @import("../net/curl.zig");
const deadlines = @import("scraper/receipts_common.zig");
const A = std.mem.Allocator;

fn echoId(a: A, bytes: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer parsed.deinit();
    return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = parsed.value.object.get("id").?, .result = "0x1" }, .{});
}

test "configured RPC production-default Tron HTTP reaches native transport while cloud remains strict" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = echoId }};
    var server = try fixture.Fixture.init(1, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var chain = @import("chain_source_testing.zig").chainFor(&.{url});
    chain.protocol = .tron;
    chain.connection = .{ .tron = .{ .wallet_urls = &.{url}, .wallet_solidity_urls = &.{url}, .fee_multiplier = null } };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const resource = try source.Resources.open(a, &chain, &environment, .{ .curl_library = library });
    defer resource.deinit();
    try std.testing.expect(!resource.http.allow_insecure_loopback);
    try std.testing.expectEqual(@as(usize, 0), server.acceptedCount());
    var response = try resource.clients.tron.jsonrpc.call("eth_chainId", .{});
    defer response.deinit();
    try std.testing.expectEqualStrings("0x1", @import("../tron/rpc.zig").result(response).string);
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    try std.testing.expectError(error.InsecureCloudUrl, resource.http.interface().send(a, .{ .method = .GET, .url = url }));
    try std.testing.expect(!resource.http.allow_insecure_loopback);
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    try server.check();
}

fn roundTrip(native: ?*Curl.Client, status: u16, limit: usize) !u16 {
    const a = std.testing.allocator;
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = if (status == 200) "ok" else "", .status = status, .extra_response_headers = "Location: http://127.0.0.1:1/never-follow\r\n" }} }};
    var server = try fixture.Fixture.init(1, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    owner.native_curl = native;
    try std.testing.expectError(error.InsecureCloudUrl, owner.interface().send(a, .{ .method = .POST, .url = url, .body = "{}" }));
    var response = try owner.configuredRpcInterface().send(a, .{ .method = .POST, .url = url, .body = "{}", .max_response_bytes = limit });
    defer response.deinit();
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    try std.testing.expectError(error.InsecureCloudUrl, owner.interface().send(a, .{ .method = .POST, .url = url, .body = "{}" }));
    try std.testing.expect(!owner.allow_insecure_loopback and !owner.allow_metadata_http);
    try server.check();
    return response.status;
}

test "configured RPC standard HTTP preserves response bounds redirects and strict same-owner auth" {
    try std.testing.expectEqual(@as(u16, 200), try roundTrip(null, 200, 3));
    try std.testing.expectEqual(@as(u16, 302), try roundTrip(null, 302, 3));
    try std.testing.expectError(error.CloudResponseTooLarge, roundTrip(null, 200, 2));
}

test "configured RPC native HTTP preserves response bounds redirects and strict same-owner auth" {
    const library = try fixture.nativeLibrary(std.testing.allocator);
    defer std.testing.allocator.free(library);
    var native = try Curl.Client.init(std.testing.allocator, library);
    defer native.deinit();
    try std.testing.expectEqual(@as(u16, 200), try roundTrip(&native, 200, 3));
    try std.testing.expectEqual(@as(u16, 302), try roundTrip(&native, 302, 3));
    try std.testing.expectError(error.CloudResponseTooLarge, roundTrip(&native, 200, 2));
}

test "configured RPC rejects unsafe schemes userinfo fragments headers and limits before connecting" {
    const a = std.testing.allocator;
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    const Case = struct { request: http.Request, err: anyerror };
    for ([_]Case{
        .{ .request = .{ .method = .GET, .url = "ftp://127.0.0.1:1/" }, .err = error.InsecureCloudUrl },
        .{ .request = .{ .method = .GET, .url = "http://public:fixture@127.0.0.1:1/" }, .err = error.InvalidCloudUrl },
        .{ .request = .{ .method = .GET, .url = "http://127.0.0.1:1/#fragment" }, .err = error.InvalidCloudUrl },
        .{ .request = .{ .method = .GET, .url = "http://127.0.0.1:1/", .headers = &.{.{ .name = "authorization", .value = "Bearer\r\nInjected: fixture" }} }, .err = error.InvalidCloudHeader },
        .{ .request = .{ .method = .POST, .url = "http://127.0.0.1:1/", .headers = &.{.{ .name = "content-length", .value = "0" }} }, .err = error.InvalidCloudHeader },
        .{ .request = .{ .method = .GET, .url = "http://127.0.0.1:1/", .max_response_bytes = 1 }, .err = error.InvalidResponseLimit },
    }) |case| {
        owner.last_native_physical_timeout = true;
        try std.testing.expectError(case.err, owner.configuredRpcInterface().send(a, case.request));
        try std.testing.expect(!owner.last_native_physical_timeout);
        try std.testing.expect(!owner.allow_insecure_loopback and !owner.allow_metadata_http);
    }
}

test "configured RPC deadline scope preserves exact grant and never upgrades a strict auth handle" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    var native = try Curl.Client.init(a, library);
    defer native.deinit();
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "ok" }} }};
    var server = try fixture.Fixture.init(1, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    owner.native_curl = &native;
    owner.timeout_ms = 1500;
    owner.connect_timeout_ms = 500;
    const now = try http.rpcNowNs();
    owner.rpc_read_owner = .{ .deadline_ns = now + 10 * std.time.ns_per_s, .retry_physical_timeout = false };
    const saved = owner.rpc_read_owner.?;
    var budget: deadlines.DeadlineTransport = .{ .owner = &owner, .deadline_ns = now + 5 * std.time.ns_per_s, .rpc_read = true };
    try budget.verify(owner.interface());
    try std.testing.expectError(error.InsecureCloudUrl, budget.interface().send(a, .{ .method = .POST, .url = url, .body = "{}" }));
    try std.testing.expectEqual(@as(usize, 0), server.acceptedCount());
    try budget.verify(owner.configuredRpcInterface());
    var response = try budget.interface().send(a, .{ .method = .POST, .url = url, .body = "{}" });
    defer response.deinit();
    try std.testing.expectEqualStrings("ok", response.bytes);
    try std.testing.expectEqual(@as(u32, 1500), owner.timeout_ms);
    try std.testing.expectEqual(@as(u32, 500), owner.connect_timeout_ms);
    try std.testing.expectEqual(saved, owner.rpc_read_owner.?);
    budget.rpc_read = false;
    try std.testing.expectError(error.ReceiptTransportOwnerMismatch, budget.verify(owner.configuredRpcInterface()));
    try std.testing.expect(budget.delegate == null);
    try std.testing.expectError(error.InsecureCloudUrl, budget.interface().send(a, .{ .method = .POST, .url = url, .body = "{}" }));
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    try server.check();
}

test "configured RPC failed ownership and native verification erase a prior delegate" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    var native = try Curl.Client.init(a, library);
    defer native.deinit();
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    var foreign = http.HttpTransport.init(a);
    defer foreign.deinit();
    owner.native_curl = &native;
    var budget: deadlines.DeadlineTransport = .{ .owner = &owner, .deadline_ns = try http.rpcNowNs() + std.time.ns_per_s, .rpc_read = true };
    try budget.verify(owner.configuredRpcInterface());
    try std.testing.expectError(error.ReceiptTransportOwnerMismatch, budget.verify(foreign.configuredRpcInterface()));
    try std.testing.expect(budget.delegate == null);
    try budget.verify(owner.configuredRpcInterface());
    owner.native_curl = null;
    try std.testing.expectError(error.NativeReceiptTransportRequired, budget.verify(owner.configuredRpcInterface()));
    try std.testing.expect(budget.delegate == null);
}

test "configured RPC capability never enters Manager credentials or same-owner Factory signer" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const url = "http://127.0.0.1:1/public-rpc";
    var chain = @import("chain_source_testing.zig").chainFor(&.{url});
    chain.protocol = .tron;
    chain.connection = .{ .tron = .{ .wallet_urls = &.{url}, .wallet_solidity_urls = &.{url}, .fee_multiplier = null } };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const resource = try source.Resources.open(a, &chain, &environment, .{ .curl_library = library });
    defer resource.deinit();
    const settings = @import("../settings/root.zig");
    var configured: settings.Settings = .{
        .config = .{ .arena = .init(a), .root = .null },
        .chains = &.{},
        .metrics_port = 0,
        .role = .{ .scraper = .{ .ccr_routers = &.{}, .chains_to_scrape = &.{}, .db = "unused", .db_max_connections = 1, .db_acquire_timeout_ms = 1000 } },
    };
    defer configured.config.deinit();
    const signer: settings.Signer = .{ .hex_key = @splat(7) };
    const manager = try @import("credentials.zig").Manager.initForSigner(a, &configured, &environment, &resource.http, signer, .{});
    defer manager.deinit();
    var lease = try manager.lease(1793923200);
    const strict = resource.http.interface();
    const rpc = resource.http.configuredRpcInterface();
    try std.testing.expect(lease.http_owner == &resource.http);
    try std.testing.expect(lease.transport.context == strict.context and lease.transport.send_fn == strict.send_fn);
    try std.testing.expect(rpc.context == strict.context and rpc.send_fn != strict.send_fn);
    try std.testing.expectError(error.InsecureCloudUrl, lease.transport.send(a, .{ .method = .POST, .url = url, .body = "{}" }));
    try std.testing.expectError(error.InsecureCloudUrl, manager.metadata_transport.interface().send(a, .{ .method = .GET, .url = url }));
    lease.transport = rpc;
    try std.testing.expectError(error.SignerTransportOwnerMismatch, @import("destination/factory.zig").Factory.open(a, resource, signer, lease, .{}));
    try std.testing.expect(!resource.http.allow_insecure_loopback and !resource.http.allow_metadata_http);
}

test "configured RPC actual physical timeout controls retain exact owner classification and reset" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    var native = try Curl.Client.init(a, library);
    defer native.deinit();
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "", .stall = true }} }};
    // Keep the first socket retained until deinit, which joins its sole owner.
    var server = try fixture.Fixture.init(2, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    owner.native_curl = &native;
    owner.timeout_ms = 50;
    owner.connect_timeout_ms = 50;
    var cancel = std.atomic.Value(bool).init(false);
    var halt = std.atomic.Value(bool).init(false);
    owner.cancel = &cancel;
    owner.rpc_read_owner = .{ .deadline_ns = try http.rpcNowNs() + 5 * std.time.ns_per_s, .halt = &halt, .retry_physical_timeout = true };
    try std.testing.expectError(error.UpstreamReadTimeout, owner.configuredRpcInterface().send(a, .{ .method = .POST, .url = url, .body = "{}" }));
    try std.testing.expect(owner.last_native_physical_timeout);
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, owner.configuredRpcInterface().send(a, .{ .method = .POST, .url = url, .body = "{}" }));
    try std.testing.expect(!owner.last_native_physical_timeout);
    cancel.store(false, .release);
    halt.store(true, .release);
    try std.testing.expectError(error.CheckpointEffectsHalted, owner.configuredRpcInterface().send(a, .{ .method = .POST, .url = url, .body = "{}" }));
    try std.testing.expect(!owner.last_native_physical_timeout);
    halt.store(false, .release);
    owner.rpc_read_owner.?.deadline_ns = try http.rpcNowNs();
    try std.testing.expectError(error.RequestDeadlineExceeded, owner.configuredRpcInterface().send(a, .{ .method = .POST, .url = url, .body = "{}" }));
    try std.testing.expect(!owner.last_native_physical_timeout);
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    try server.check();
}
