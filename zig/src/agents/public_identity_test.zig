const std = @import("std");
const identity = @import("public_identity.zig");
const settings = @import("../settings/root.zig");
const source = @import("chain_source.zig");
const cloud = @import("../cloud/root.zig");
const signing = @import("signer.zig");
const fixture = @import("../testing/fixture.zig");
const a = std.testing.allocator;
const key: [32]u8 = @splat(0x11);
fn scalarChain(protocol: settings.Protocol, signer: settings.Signer) settings.Chain {
    var chain: settings.Chain = undefined;
    chain.protocol = protocol;
    chain.signer = signer;
    return chain;
}
fn emptyReaders() source.Resources {
    var readers: source.Resources = undefined;
    readers.options = .{ .curl_library = "must-not-load-for-local-or-injected-identity" };
    readers.clients = .{ .ethereum = undefined };
    return readers;
}
fn expectPublic(chain: *settings.Chain, readers: *source.Resources, expected: []const u8) !void {
    var configured: settings.Settings = undefined;
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    var resolver = try identity.Resolver.init(a, &configured, chain, &env, .{});
    defer resolver.deinit();
    try std.testing.expectEqual(@as(usize, 0), resolver.len);
    try std.testing.expect(resolver.native == null and resolver.manager == null);
    var cancel = std.atomic.Value(bool).init(false);
    var out: [256]u8 = undefined;
    try std.testing.expectEqualStrings(expected, (try resolver.resolve(readers, &cancel, 1, &out)).?);
    try std.testing.expect(resolver.native == null and resolver.manager == null and resolver.transport == null);
    try std.testing.expectEqualStrings(expected, (try resolver.resolve(readers, &cancel, 2, &out)).?);
    try std.testing.expectError(error.InvalidHealthWalletBuffer, resolver.resolve(readers, &cancel, 2, out[0..1]));
    cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, resolver.resolve(readers, &cancel, 2, &out));
}
test "public identity local Ethereum Tron Cosmos and CosmosNative match production SDK identities without auth" {
    var readers = emptyReaders();
    var ethereum = scalarChain(.ethereum, .{ .hex_key = key });
    try expectPublic(&ethereum, &readers, "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a");
    var tron = scalarChain(.tron, .{ .hex_key = key });
    try expectPublic(&tron, &readers, "TCLBgkbfVkJroVBJVqBEsxtPNQEQMTQCLQ");
    const sdk = try fixture.parse(struct { cosmos: struct { bech32: []const u8 } }, a, @embedFile("../altvm/fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true });
    defer sdk.deinit();
    for ([_]settings.Protocol{ .cosmos, .cosmosnative }) |protocol| {
        var chain = scalarChain(protocol, .{ .cosmos_key = .{ .key = key, .prefix = "cosmos", .account_address_type = "bitcoin" } });
        const config: @import("../settings/types.zig").Cosmos = .{ .chain_id = "fixture", .bech32_prefix = "cosmos", .gas_price = .{ .amount = "0", .denom = "uatom" }, .contract_address_bytes = 32, .gas_multiplier = 1, .compat_mode = null, .canonical_asset = "uatom" };
        chain.connection = if (protocol == .cosmos) .{ .cosmos = config } else .{ .cosmosnative = config };
        try expectPublic(&chain, &readers, sdk.value.cosmos.bech32);
    }
}
test "public identity SVM Radix and Starknet retain Source public address formats without signing" {
    var readers = emptyReaders();
    var svm = scalarChain(.sealevel, .{ .hex_key = @splat(0) });
    var configured: settings.Settings = undefined;
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    var resolver = try identity.Resolver.init(a, &configured, &svm, &env, .{});
    defer resolver.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    var out: [256]u8 = undefined;
    const text = (try resolver.resolve(&readers, &cancel, 1, &out)).?;
    const decoded = try @import("../altvm/base58.zig").decode(a, text);
    defer a.free(decoded);
    const expected = try @import("../evm/codecs.zig").hexAlloc(a, decoded);
    defer a.free(expected);
    try std.testing.expectEqualStrings("0x" ++ "3b6a27bcceb6a42d62a3a8d02a6f0d7" ++ "3653215771de243a63ac048a18b59da" ++ "29", expected);
    const sdk = try fixture.parse(struct { account_text: []const u8 }, a, @embedFile("../radix/fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true });
    defer sdk.deinit();
    readers.clients = .{ .radix = undefined };
    readers.clients.radix.network = .mainnet;
    var radix = scalarChain(.radix, .{ .radix_key = .{ .key = key, .suffix = "rdx" } });
    try expectPublic(&radix, &readers, sdk.value.account_text);
    var starknet = scalarChain(.starknet, .{ .stark_key = .{ .key = @splat(0), .address = @splat(0), .legacy = false } });
    starknet.signer.?.stark_key.key[31] = 1;
    starknet.signer.?.stark_key.address[30] = 1;
    starknet.signer.?.stark_key.address[31] = 0x23;
    try expectPublic(&starknet, &readers, "0x123");
}
test "public identity absent signer cancellation and invalid key fail before transport discovery" {
    var configured: settings.Settings = undefined;
    var chain = scalarChain(.ethereum, .{ .hex_key = @splat(0) });
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    var readers = emptyReaders();
    var resolver = try identity.Resolver.init(a, &configured, &chain, &env, .{});
    defer resolver.deinit();
    var cancel = std.atomic.Value(bool).init(true);
    var out: [256]u8 = undefined;
    try std.testing.expectError(error.RequestCancelled, resolver.resolve(&readers, &cancel, 1, &out));
    cancel.store(false, .release);
    try std.testing.expectError(error.InvalidSecretKey, resolver.resolve(&readers, &cancel, 1, &out));
    try std.testing.expect(resolver.native == null and resolver.manager == null and resolver.timer == null);
    chain.signer = null;
    try std.testing.expect((try resolver.resolve(&readers, &cancel, 1, &out)) == null);
    try std.testing.expect(resolver.timer == null);
}
pub const PublicKeyOnly = struct {
    response: []const u8,
    google: bool = false,
    pending: bool = false,
    calls: usize = 0,
    leases: usize = 0,
    lease_pending: bool = false,
    pub fn provider(self: *PublicKeyOnly) identity.CredentialsProvider {
        return .{ .context = self, .lease_fn = lease };
    }
    fn send(context: *anyopaque, allocator: std.mem.Allocator, request: cloud.http.Request) anyerror!cloud.http.Response {
        const self: *PublicKeyOnly = @ptrCast(@alignCast(context));
        self.calls += 1;
        if (self.google) {
            try std.testing.expectEqual(std.http.Method.GET, request.method);
            try std.testing.expect(std.mem.endsWith(u8, request.url, "/publicKey"));
        } else {
            try std.testing.expectEqual(std.http.Method.POST, request.method);
            var public_target = false;
            for (request.headers) |header| if (std.ascii.eqlIgnoreCase(header.name, "x-amz-target")) {
                try std.testing.expectEqualStrings("TrentService.GetPublicKey", header.value);
                public_target = true;
            };
            try std.testing.expect(public_target);
            try std.testing.expect(std.mem.indexOf(u8, request.body.?, "alias/fixture") != null);
        }
        if (self.pending) {
            self.pending = false;
            return error.PendingReadIo;
        }
        return .{ .allocator = allocator, .bytes = try allocator.dupe(u8, self.response), .status = 200 };
    }
    fn lease(context: *anyopaque, _: u64, cancel: *const std.atomic.Value(bool)) anyerror!signing.Credentials {
        const self: *PublicKeyOnly = @ptrCast(@alignCast(context));
        if (cancel.load(.acquire)) return error.RequestCancelled;
        self.leases += 1;
        if (self.lease_pending) {
            self.lease_pending = false;
            return error.PendingReadIo;
        }
        return .{ .transport = .{ .context = self, .send_fn = send }, .aws = .{ .access_key_id = "EXAMPLE", .secret_access_key = "public-fixture" }, .gcp_bearer = "public-fixture", .amz_date = "20261106T000000Z" };
    }
};
pub fn publicResponse(google: bool) ![]u8 {
    const encoded_public = "034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
    var public: [33]u8 = undefined;
    _ = try std.fmt.hexToBytes(&public, encoded_public);
    var der: [56]u8 = undefined;
    der[0..23].* = .{ 0x30, 54, 0x30, 0x10, 6, 7, 0x2a, 0x86, 0x48, 0xce, 0x3d, 2, 1, 6, 5, 0x2b, 0x81, 4, 0, 0x0a, 3, 34, 0 };
    @memcpy(der[23..], &public);
    var encoded: [80]u8 = undefined;
    const b64 = std.base64.standard.Encoder.encode(&encoded, &der);
    if (google) {
        const pem = try std.fmt.allocPrint(a, "-----BEGIN PUBLIC KEY-----\n{s}\n-----END PUBLIC KEY-----\n", .{b64});
        defer a.free(pem);
        const checksum = try std.fmt.allocPrint(a, "{d}", .{cloud.kms.crc32c(pem)});
        defer a.free(checksum);
        return std.json.Stringify.valueAlloc(a, .{ .name = "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1", .algorithm = "EC_SIGN_SECP256K1_SHA256", .protectionLevel = "HSM", .pem = pem, .pemCrc32c = checksum }, .{});
    }
    return std.json.Stringify.valueAlloc(a, .{ .KeyId = "arn:aws:kms:us-east-1:000000000000:key/fixture", .KeySpec = "ECC_SECG_P256K1", .KeyUsage = "SIGN_VERIFY", .SigningAlgorithms = .{"ECDSA_SHA_256"}, .PublicKey = b64 }, .{});
}
test "public identity AWS and GCP query public key only retain pending attempt and never sign or discover native auth for injected lease" {
    for ([_]bool{ false, true }) |google| {
        const response = try publicResponse(google);
        defer a.free(response);
        var backend: PublicKeyOnly = .{ .response = response, .google = google, .pending = true, .lease_pending = true };
        var configured: settings.Settings = undefined;
        var chain = scalarChain(.ethereum, if (google) .{ .gcp = .{ .key_version_name = "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1" } } else .{ .aws = .{ .id = "alias/fixture", .region = "us-east-1" } });
        var env = std.process.EnvMap.init(a);
        defer env.deinit();
        var readers = emptyReaders();
        var resolver = try identity.Resolver.init(a, &configured, &chain, &env, .{ .credentials_provider = .{ .context = &backend, .lease_fn = PublicKeyOnly.lease } });
        defer resolver.deinit();
        var cancel = std.atomic.Value(bool).init(false);
        var out: [256]u8 = undefined;
        try std.testing.expectError(error.PendingReadIo, resolver.resolve(&readers, &cancel, 1, &out));
        resolver.endPass(error.PendingReadIo);
        try std.testing.expectError(error.PendingReadIo, resolver.resolve(&readers, &cancel, 2, &out));
        resolver.endPass(error.PendingReadIo);
        try std.testing.expectEqualStrings("0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a", (try resolver.resolve(&readers, &cancel, 3, &out)).?);
        try std.testing.expectEqual(@as(usize, 2), backend.calls);
        try std.testing.expectEqual(@as(usize, 3), backend.leases);
        try std.testing.expect(resolver.manager == null and resolver.native == null and resolver.timer == null);
        _ = try resolver.resolve(&readers, &cancel, 4, &out);
        try std.testing.expectEqual(@as(usize, 2), backend.calls);
    }
}
test "public identity explicit signer credential scope uses real Manager without unrelated ambient identities" {
    const response = try publicResponse(false);
    defer a.free(response);
    var backend: PublicKeyOnly = .{ .response = response, .pending = true };
    var configured: settings.Settings = undefined;
    var chain = scalarChain(.ethereum, .{ .aws = .{ .id = "alias/fixture", .region = "us-east-1" } });
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    try env.put("AWS_ACCESS_KEY_ID", "EXAMPLE");
    try env.put("AWS_SECRET_ACCESS_KEY", "public-fixture");
    var readers = emptyReaders();
    var resolver = try identity.Resolver.init(a, &configured, &chain, &env, .{ .credential_options = .{ .transport_override = .{ .context = &backend, .send_fn = PublicKeyOnly.send }, .metadata_transport_override = .{ .context = &backend, .send_fn = PublicKeyOnly.send } } });
    defer resolver.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    var out: [256]u8 = undefined;
    try std.testing.expectError(error.PendingReadIo, resolver.resolve(&readers, &cancel, 1, &out));
    try std.testing.expect(resolver.manager != null and resolver.native == null);
    resolver.endPass(error.PendingReadIo);
    try std.testing.expectEqualStrings("0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a", (try resolver.resolve(&readers, &cancel, 2, &out)).?);
    try std.testing.expect(resolver.manager == null and resolver.transport == null);
    try std.testing.expectEqual(@as(usize, 2), backend.calls);
}
test "public identity Aleo resolves actual private key through existing isolated SDK worker without proving" {
    const worker = std.process.getEnvVarOwned(a, "HYPERLANE_ALEO_VM_WORKER") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(worker);
    const library = std.process.getEnvVarOwned(a, "HYPERLANE_ALEO_VM_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(library);
    const crypto_path = std.process.getEnvVarOwned(a, "HYPERLANE_ALEO_CRYPTO_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(crypto_path);
    var native = try @import("../aleo/crypto.zig").Crypto.init(crypto_path);
    defer native.deinit();
    var factory: @import("scraper/aleo.zig").Factory = undefined;
    factory.decoder = .{ .executable = worker, .library = library, .network = 0, .limits = .{ .timeout_ms = 30000 } };
    factory.provider.native = &native;
    var readers = emptyReaders();
    readers.clients = .{ .aleo = &factory };
    var configured: settings.Settings = undefined;
    var chain = scalarChain(.aleo, .{ .hex_key = key });
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    var resolver = try identity.Resolver.init(a, &configured, &chain, &env, .{});
    defer resolver.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    var out: [256]u8 = undefined;
    const text = (try resolver.resolve(&readers, &cancel, 1, &out)).?;
    // Public seed 0x11*32, independently derived through the pinned SnarkVM
    // private-key/address FFI; this also checks worker input/format conversion.
    try std.testing.expectEqualStrings("aleo1tp9ng9fyzkcg0trk6k26hl43ar7frgkapmwa2vzazarz9ydacs9qjretgq", text);
    const address = try native.address(text);
    try std.testing.expect(!std.mem.allEqual(u8, &address, 0));
    // A second call needs neither a native worker nor a live SDK decoder.
    factory.decoder.executable = "must-not-run-after-resolution";
    try std.testing.expectEqualStrings(text, (try resolver.resolve(&readers, &cancel, 2, &out)).?);
}

test "public identity canceled managed pending lookup retires all auth and restarts a fresh attempt" {
    const response = try publicResponse(false);
    defer a.free(response);
    var backend: PublicKeyOnly = .{ .response = response, .pending = true };
    var configured: settings.Settings = undefined;
    var chain = scalarChain(.ethereum, .{ .aws = .{ .id = "alias/fixture", .region = "us-east-1" } });
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    try env.put("AWS_ACCESS_KEY_ID", "EXAMPLE");
    try env.put("AWS_SECRET_ACCESS_KEY", "public-fixture");
    var readers = emptyReaders();
    var resolver = try identity.Resolver.init(a, &configured, &chain, &env, .{ .credential_options = .{ .transport_override = .{ .context = &backend, .send_fn = PublicKeyOnly.send }, .metadata_transport_override = .{ .context = &backend, .send_fn = PublicKeyOnly.send } } });
    defer resolver.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    var out: [256]u8 = undefined;
    try std.testing.expectError(error.PendingReadIo, resolver.resolve(&readers, &cancel, 1, &out));
    resolver.endPass(error.PendingReadIo);
    try std.testing.expect(resolver.manager != null);
    cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, resolver.resolve(&readers, &cancel, 2, &out));
    try std.testing.expect(resolver.manager == null and resolver.native == null and resolver.transport == null and resolver.timer == null);
    try std.testing.expectEqual(@as(usize, 0), resolver.len);
    try std.testing.expectEqual(@as(usize, 1), backend.calls);
    cancel.store(false, .release);
    try std.testing.expectEqualStrings("0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a", (try resolver.resolve(&readers, &cancel, 3, &out)).?);
    try std.testing.expectEqual(@as(usize, 2), backend.calls);
}
test "public identity pending lookup honors one absolute deadline without another request" {
    const response = try publicResponse(true);
    defer a.free(response);
    var backend: PublicKeyOnly = .{ .response = response, .google = true, .lease_pending = true };
    var configured: settings.Settings = undefined;
    var chain = scalarChain(.ethereum, .{ .gcp = .{ .key_version_name = "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1" } });
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    var readers = emptyReaders();
    var resolver = try identity.Resolver.init(a, &configured, &chain, &env, .{ .timeout_ms = 1, .connect_timeout_ms = 1, .credentials_provider = .{ .context = &backend, .lease_fn = PublicKeyOnly.lease } });
    defer resolver.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    var out: [256]u8 = undefined;
    try std.testing.expectError(error.PendingReadIo, resolver.resolve(&readers, &cancel, 1, &out));
    resolver.endPass(error.PendingReadIo);
    std.Thread.sleep(2 * std.time.ns_per_ms);
    try std.testing.expectError(error.RequestDeadlineExceeded, resolver.resolve(&readers, &cancel, 2, &out));
    try std.testing.expectEqual(@as(usize, 0), backend.calls);
    try std.testing.expectEqual(@as(usize, 1), backend.leases);
    try std.testing.expect(resolver.timer == null and resolver.manager == null);
}
fn allocationCase(allocator: std.mem.Allocator, response: []const u8) !void {
    var backend: PublicKeyOnly = .{ .response = response };
    var configured: settings.Settings = undefined;
    var chain = scalarChain(.ethereum, .{ .aws = .{ .id = "alias/fixture", .region = "us-east-1" } });
    var env = std.process.EnvMap.init(allocator);
    defer env.deinit();
    try env.put("AWS_ACCESS_KEY_ID", "EXAMPLE");
    try env.put("AWS_SECRET_ACCESS_KEY", "public-fixture");
    var readers = emptyReaders();
    var resolver = try identity.Resolver.init(allocator, &configured, &chain, &env, .{ .credential_options = .{ .transport_override = .{ .context = &backend, .send_fn = PublicKeyOnly.send }, .metadata_transport_override = .{ .context = &backend, .send_fn = PublicKeyOnly.send } } });
    defer resolver.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    var out: [256]u8 = undefined;
    try std.testing.expectEqualStrings("0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a", (try resolver.resolve(&readers, &cancel, 1, &out)).?);
    try std.testing.expect(resolver.manager == null and resolver.native == null and resolver.transport == null);
}
test "public identity every allocation failure releases signer manager response and public storage" {
    const response = try publicResponse(false);
    defer a.free(response);
    try std.testing.checkAllAllocationFailures(a, allocationCase, .{response});
}

const NativePublicKey = struct {
    server: std.net.Server,
    body: []const u8,
    stop: std.atomic.Value(bool) = .init(false),
    failure: ?anyerror = null,
    calls: usize = 0,
    signed_public_request: bool = false,
    fn run(self: *NativePublicKey) void {
        self.serve() catch |err| {
            self.failure = err;
        };
    }
    fn ready(self: *NativePublicKey, fd: std.posix.fd_t) !void {
        var timer = try std.time.Timer.start();
        while (true) {
            if (self.stop.load(.acquire)) return error.RequestCancelled;
            if (timer.read() > 3 * std.time.ns_per_s) return error.NativePublicKeyFixtureTimeout;
            var polls = [_]std.posix.pollfd{.{ .fd = fd, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&polls, 10) == 0) continue;
            if (polls[0].revents & std.posix.POLL.NVAL != 0) return error.NativePublicKeyFixtureClosed;
            if (polls[0].revents & (std.posix.POLL.IN | std.posix.POLL.HUP) != 0) return;
        }
    }
    fn serve(self: *NativePublicKey) !void {
        try self.ready(self.server.stream.handle);
        const connection = try self.server.accept();
        defer connection.stream.close();
        var buffer: [8192]u8 = undefined;
        var used: usize = 0;
        var header_end: ?usize = null;
        var length: usize = 0;
        while (true) {
            if (used == buffer.len) return error.NativePublicKeyRequestTooLarge;
            try self.ready(connection.stream.handle);
            const count = try connection.stream.read(buffer[used..]);
            if (count == 0) return error.EndOfStream;
            used += count;
            if (header_end == null) if (std.mem.indexOf(u8, buffer[0..used], "\r\n\r\n")) |end| {
                header_end = end + 4;
                try std.testing.expect(std.mem.startsWith(u8, buffer[0..used], "POST / HTTP/1.1\r\n"));
                var lines = std.mem.splitSequence(u8, buffer[0..end], "\r\n");
                var public_target = false;
                var signature = false;
                while (lines.next()) |line| {
                    const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
                    const name = line[0..colon];
                    const value = std.mem.trim(u8, line[colon + 1 ..], " \t");
                    if (std.ascii.eqlIgnoreCase(name, "content-length")) length = try std.fmt.parseInt(usize, value, 10);
                    if (std.ascii.eqlIgnoreCase(name, "x-amz-target")) public_target = std.mem.eql(u8, value, "TrentService.GetPublicKey");
                    if (std.ascii.eqlIgnoreCase(name, "authorization")) signature = std.mem.startsWith(u8, value, "AWS4-HMAC-SHA256 ");
                }
                self.signed_public_request = public_target and signature;
            };
            if (header_end) |end| if (used - end >= length) break;
        }
        const request = try std.json.parseFromSlice(struct { KeyId: []const u8 }, a, buffer[header_end.?..][0..length], .{});
        defer request.deinit();
        try std.testing.expectEqualStrings("alias/fixture", request.value.KeyId);
        self.calls += 1;
        var header: [256]u8 = undefined;
        const prefix = try std.fmt.bufPrint(&header, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{self.body.len});
        try connection.stream.writeAll(prefix);
        try connection.stream.writeAll(self.body);
    }
};
test "public identity real auth-only native transport performs one signed GetPublicKey then retires without chain replay" {
    const library = try @import("../evm/pool_testing.zig").nativeLibrary(a);
    defer a.free(library);
    const response = try publicResponse(false);
    defer a.free(response);
    var server: NativePublicKey = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .body = response };
    defer server.server.deinit();
    const endpoint = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}", .{server.server.listen_address.getPort()});
    defer a.free(endpoint);
    const thread = try std.Thread.spawn(.{}, NativePublicKey.run, .{&server});
    var joined = false;
    defer if (!joined) {
        server.stop.store(true, .release);
        thread.join();
    };
    var configured: settings.Settings = undefined;
    var chain = scalarChain(.ethereum, .{ .aws = .{ .id = "alias/fixture", .region = "us-east-1" } });
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    try env.put("AWS_ACCESS_KEY_ID", "EXAMPLE");
    try env.put("AWS_SECRET_ACCESS_KEY", "public-fixture");
    var readers = emptyReaders();
    readers.options.curl_library = library;
    readers.options.allow_insecure_loopback = true;
    var resolver = try identity.Resolver.init(a, &configured, &chain, &env, .{ .credential_options = .{ .kms_endpoint = endpoint } });
    defer resolver.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    var out: [256]u8 = undefined;
    try std.testing.expectEqualStrings("0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a", (try resolver.resolve(&readers, &cancel, 1, &out)).?);
    thread.join();
    joined = true;
    if (server.failure) |err| return err;
    try std.testing.expectEqual(@as(usize, 1), server.calls);
    try std.testing.expect(server.signed_public_request);
    try std.testing.expect(resolver.native == null and resolver.manager == null and resolver.transport == null);
}

const CommandBudget = struct {
    cancel: *const std.atomic.Value(bool),
    calls: usize = 0,
    timeout_ms: u32 = 0,
    fn read(_: ?*anyopaque, allocator: std.mem.Allocator, path: []const u8, _: usize) !?[]u8 {
        try std.testing.expectEqualStrings("/public-fixture/adc", path);
        return try allocator.dupe(u8, "{\"type\":\"external_account\",\"audience\":\"//iam.googleapis.com/projects/p/locations/global/workloadIdentityPools/w/providers/i\",\"subject_token_type\":\"urn:ietf:params:oauth:token-type:jwt\",\"token_url\":\"https://sts.googleapis.com/v1/token\",\"credential_source\":{\"executable\":{\"command\":\"fixture-command --flag\",\"timeout_millis\":30000}}}");
    }
    fn command(context: ?*anyopaque, _: std.mem.Allocator, argv: []const []const u8, _: *const std.process.EnvMap, limits: cloud.command.Limits) anyerror![]u8 {
        const self: *CommandBudget = @ptrCast(@alignCast(context.?));
        try std.testing.expectEqualStrings("fixture-command", argv[0]);
        try std.testing.expectEqual(@as(usize, 2), argv.len);
        try std.testing.expect(limits.cancel == self.cancel);
        self.calls += 1;
        self.timeout_ms = limits.timeout_ms;
        return error.ObservedPublicIdentityCommandBudget;
    }
    fn noHttp(_: *anyopaque, _: std.mem.Allocator, _: cloud.http.Request) anyerror!cloud.http.Response {
        return error.UnexpectedPublicIdentityHttp;
    }
};
test "public identity actual ADC executable receives aggregate remaining budget and cancellation before any HTTP" {
    var configured: settings.Settings = undefined;
    var chain = scalarChain(.ethereum, .{ .gcp = .{ .key_version_name = "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1" } });
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    try env.put("GOOGLE_APPLICATION_CREDENTIALS", "/public-fixture/adc");
    try env.put("GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES", "1");
    var cancel = std.atomic.Value(bool).init(false);
    var budget: CommandBudget = .{ .cancel = &cancel };
    var readers = emptyReaders();
    const transport: cloud.http.Transport = .{ .context = &budget, .send_fn = CommandBudget.noHttp };
    var resolver = try identity.Resolver.init(a, &configured, &chain, &env, .{ .timeout_ms = 1234, .connect_timeout_ms = 1234, .credential_options = .{ .file_reader = .{ .read_fn = CommandBudget.read }, .command_runner = .{ .context = &budget, .argv_fn = CommandBudget.command }, .transport_override = transport, .metadata_transport_override = transport } });
    defer resolver.deinit();
    var out: [256]u8 = undefined;
    try std.testing.expectError(error.ObservedPublicIdentityCommandBudget, resolver.resolve(&readers, &cancel, 1, &out));
    try std.testing.expectEqual(@as(usize, 1), budget.calls);
    try std.testing.expect(budget.timeout_ms > 0 and budget.timeout_ms <= 1234);
    try std.testing.expect(resolver.manager == null and resolver.transport == null and resolver.native == null);
    try std.testing.expectEqual(@as(usize, 0), resolver.len);
}
