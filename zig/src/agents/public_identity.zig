//! One-time public identity for a configured scraper metrics wallet. No signing,
//! transaction factory, proving or I/O during init. All configured inputs and
//! settings are borrowed through deinit. Remote initialization owns a bounded
//! auth-only native transport; it is retired immediately after public resolution.
const std = @import("std");
const settings = @import("../settings/root.zig");
const source = @import("chain_source.zig");
const signing = @import("signer.zig");
const credentials = @import("credentials.zig");
const cloud = @import("../cloud/root.zig");
const curl = @import("../net/curl.zig");
const A = std.mem.Allocator;
const Cancel = *const std.atomic.Value(bool);
pub const CredentialsProvider = struct {
    context: *anyopaque,
    lease_fn: *const fn (*anyopaque, u64, Cancel) anyerror!signing.Credentials,
};
pub const Options = struct {
    timeout_ms: u32 = 30000,
    connect_timeout_ms: u32 = 5000,
    credential_options: credentials.Options = .{},
    credentials_provider: ?CredentialsProvider = null,
};
pub const Resolver = struct {
    allocator: A,
    configured: *const settings.Settings,
    chain: *const settings.Chain,
    environment: *const std.process.EnvMap,
    options: Options,
    text: [256]u8 = undefined,
    len: usize = 0,
    timer: ?std.time.Timer = null,
    attempt_unix_seconds: u64 = 0,
    cancel: ?Cancel = null,
    native: ?curl.Client = null,
    transport: ?cloud.http.HttpTransport = null,
    manager: ?*credentials.Manager = null,

    pub fn init(a: A, configured: *const settings.Settings, chain: *const settings.Chain, environment: *const std.process.EnvMap, options: Options) !Resolver {
        if (options.timeout_ms == 0 or options.timeout_ms > 300000 or options.connect_timeout_ms == 0 or options.connect_timeout_ms > options.timeout_ms) return error.InvalidPublicIdentityDeadline;
        return .{ .allocator = a, .configured = configured, .chain = chain, .environment = environment, .options = options };
    }
    pub fn deinit(self: *Resolver) void {
        self.resetAttempt();
        self.* = undefined;
    }
    fn resetAttempt(self: *Resolver) void {
        if (self.manager) |manager| manager.deinit();
        self.manager = null;
        if (self.transport) |*transport| transport.deinit();
        self.transport = null;
        if (self.native) |*native| native.deinit();
        self.native = null;
        self.cancel = null;
        self.timer = null;
    }
    pub fn endPass(self: *Resolver, failure: ?anyerror) void {
        self.cancel = null;
        if (failure) |err| {
            if (err == error.PendingReadIo or err == error.PendingIo) return;
            self.resetAttempt();
        } else if (self.len != 0) self.resetAttempt();
    }
    fn check(self: *Resolver) !u32 {
        if (self.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
        const elapsed = if (self.timer) |*timer| timer.read() else return error.PublicIdentityAttemptNotStarted;
        const limit = @as(u64, self.options.timeout_ms) * std.time.ns_per_ms;
        if (elapsed >= limit) return error.RequestDeadlineExceeded;
        return @intCast((limit - elapsed + std.time.ns_per_ms - 1) / std.time.ns_per_ms);
    }
    fn copy(self: *Resolver, out: []u8) ![]const u8 {
        if (out.len < self.len) return error.InvalidHealthWalletBuffer;
        @memcpy(out[0..self.len], self.text[0..self.len]);
        return out[0..self.len];
    }
    pub fn resolve(self: *Resolver, readers: *source.Resources, cancel: Cancel, unix_seconds: u64, out: []u8) !?[]const u8 {
        if (cancel.load(.acquire)) {
            self.resetAttempt();
            return error.RequestCancelled;
        }
        if (self.len != 0) return try self.copy(out);
        const signer = self.chain.signer orelse return null;
        self.cancel = cancel;
        if (self.timer == null) {
            self.timer = try std.time.Timer.start();
            self.attempt_unix_seconds = unix_seconds;
        }
        errdefer |err| if (err != error.PendingReadIo and err != error.PendingIo) self.resetAttempt();
        _ = try self.check();
        var scratch: [1024]u8 = undefined;
        var fixed = std.heap.FixedBufferAllocator.init(&scratch);
        const temporary = fixed.allocator();
        const text: []const u8 = switch (self.chain.protocol) {
            .ethereum, .tron => blk: {
                const digest = try signing.DigestSigner.open(self.allocator, signer, try self.lease(readers, signer));
                defer digest.deinit();
                if (self.chain.protocol == .ethereum) break :blk try @import("../evm/codecs.zig").hexAlloc(temporary, &digest.address);
                break :blk try @import("../altvm/tron.zig").encodeAddress(temporary, @import("../altvm/tron.zig").fromEthereumAddress(digest.address));
            },
            .sealevel => blk: {
                const secret = switch (signer) {
                    .hex_key => |key| key,
                    else => return error.SealevelSignerRequired,
                };
                var pair = try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(secret);
                defer std.crypto.secureZero(u8, std.mem.asBytes(&pair.secret_key));
                break :blk try @import("../altvm/base58.zig").encode(temporary, &pair.public_key.toBytes());
            },
            .cosmos, .cosmosnative => blk: {
                const spec = switch (signer) {
                    .cosmos_key => |value| value,
                    else => return error.CosmosSignerRequired,
                };
                const config = switch (self.chain.connection) {
                    .cosmos => |value| value,
                    .cosmosnative => |value| value,
                    else => return error.CosmosSignerRequired,
                };
                if (!std.mem.eql(u8, spec.prefix, config.bech32_prefix)) return error.WrongCosmosSignerPrefix;
                const kind: @import("../altvm/cosmos.zig").AccountAddressType = if (std.ascii.eqlIgnoreCase(spec.account_address_type, "bitcoin")) .bitcoin else if (std.ascii.eqlIgnoreCase(spec.account_address_type, "ethereum")) .ethereum else return error.UnsupportedCosmosAccountAddressType;
                const public = try @import("../altvm/cosmos.zig").compressedPublicKey(spec.key);
                const address = try @import("../altvm/cosmos.zig").publicKeyAddress(public, kind);
                break :blk try @import("../altvm/bech32.zig").encode(spec.prefix, &address, &scratch);
            },
            .radix => blk: {
                const spec = switch (signer) {
                    .radix_key => |value| value,
                    else => return error.RadixSignerRequired,
                };
                const network = if (readers.clients == .radix) readers.clients.radix.network else return error.RadixSignerRequired;
                if (!std.mem.eql(u8, spec.suffix, network.suffix)) return error.WrongRadixSignerNetwork;
                const public = try @import("../radix/crypto.zig").publicKey(spec.key);
                break :blk try @import("../radix/address.zig").encode(network, "account", &@import("../radix/crypto.zig").account(public), &scratch);
            },
            .starknet => blk: {
                const spec = switch (signer) {
                    .stark_key => |value| value,
                    else => return error.StarknetSignerRequired,
                };
                const felt = @import("../starknet/codec.zig").Felt;
                _ = try felt.fromBytes(spec.key);
                const account = try felt.fromBytes(spec.address);
                break :blk try std.fmt.bufPrint(&scratch, "0x{x}", .{account.value});
            },
            .aleo => blk: {
                const secret = switch (signer) {
                    .hex_key => |key| key,
                    else => return error.AleoSignerRequired,
                };
                if (readers.clients != .aleo) return error.AleoSignerRequired;
                const client = readers.clients.aleo;
                const address = try self.aleoAddress(client.decoder, secret);
                break :blk try client.provider.native.addressText(temporary, address);
            },
        };
        _ = try self.check();
        if (text.len == 0 or text.len > self.text.len) return error.InvalidHealthWalletAddress;
        @memcpy(self.text[0..text.len], text);
        self.len = text.len;
        self.resetAttempt();
        return try self.copy(out);
    }
    fn noNetwork(_: *anyopaque, _: A, _: cloud.http.Request) anyerror!cloud.http.Response {
        return error.UnexpectedPublicIdentityNetwork;
    }
    fn lease(self: *Resolver, readers: *source.Resources, signer: settings.Signer) !signing.Credentials {
        if (signer != .aws and signer != .gcp) return .{ .transport = .{ .context = self, .send_fn = noNetwork }, .amz_date = "" };
        if (self.options.credentials_provider) |provider_| return provider_.lease_fn(provider_.context, self.attempt_unix_seconds, self.cancel.?);
        if (self.manager == null) {
            self.transport = cloud.http.HttpTransport.init(self.allocator);
            errdefer {
                self.transport.?.deinit();
                self.transport = null;
            }
            if (self.options.credential_options.transport_override == null or self.options.credential_options.metadata_transport_override == null) {
                self.native = try curl.Client.init(self.allocator, readers.options.curl_library);
                self.transport.?.native_curl = &self.native.?;
            }
            self.transport.?.allow_insecure_loopback = readers.options.allow_insecure_loopback;
            var options = self.options.credential_options;
            if (options.libcrypto_path == null) options.libcrypto_path = self.environment.get("HYPERLANE_LIBCRYPTO_LIBRARY") orelse if (@import("builtin").os.tag == .macos) "/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib" else "libcrypto.so.3";
            options.transport_override = .{ .context = self, .send_fn = boundedSend };
            options.metadata_transport_override = .{ .context = self, .send_fn = boundedMetadataSend };
            self.manager = try credentials.Manager.initForSigner(self.allocator, self.configured, self.environment, &self.transport.?, signer, options);
        }
        self.transport.?.cancel = self.cancel;
        const remaining = try self.check();
        self.transport.?.timeout_ms = remaining;
        self.transport.?.connect_timeout_ms = @min(remaining, self.options.connect_timeout_ms);
        return self.manager.?.lease(self.attempt_unix_seconds);
    }
    fn boundedSend(context: *anyopaque, a: A, request: cloud.http.Request) anyerror!cloud.http.Response {
        const self: *Resolver = @ptrCast(@alignCast(context));
        const remaining = try self.check();
        const transport = &self.transport.?;
        transport.cancel = self.cancel;
        transport.timeout_ms = remaining;
        transport.connect_timeout_ms = @min(remaining, self.options.connect_timeout_ms);
        return (self.options.credential_options.transport_override orelse transport.interface()).send(a, request);
    }
    fn boundedMetadataSend(context: *anyopaque, a: A, request: cloud.http.Request) anyerror!cloud.http.Response {
        const self: *Resolver = @ptrCast(@alignCast(context));
        const remaining = try self.check();
        const transport = &self.manager.?.metadata_transport;
        transport.cancel = self.cancel;
        transport.timeout_ms = @min(remaining, 5000);
        transport.connect_timeout_ms = @min(transport.timeout_ms, 1000);
        return (self.options.credential_options.metadata_transport_override orelse transport.interface()).send(a, request);
    }
    fn aleoAddress(self: *Resolver, decoder: @import("../aleo/events.zig").NativeDecoder, secret: [32]u8) ![32]u8 {
        var limits = decoder.limits;
        limits.timeout_ms = @min(limits.timeout_ms, try self.check());
        limits.cancel = self.cancel;
        limits.max_input_bytes = @min(limits.max_input_bytes, 1024 * 1024);
        limits.max_output_bytes = @min(limits.max_output_bytes, 4096);
        var digits: [3][32]u8 = undefined;
        var session = try @import("../aleo/worker.zig").Session.spawn(self.allocator, &.{ decoder.executable, try std.fmt.bufPrint(&digits[0], "{d}", .{limits.memory_bytes}), try std.fmt.bufPrint(&digits[1], "{d}", .{limits.max_input_bytes}), try std.fmt.bufPrint(&digits[2], "{d}", .{limits.max_output_bytes}) }, limits);
        defer session.deinit();
        const config = try std.json.Stringify.valueAlloc(self.allocator, .{ .library = decoder.library, .network = decoder.network }, .{});
        defer self.allocator.free(config);
        self.allocator.free(try session.exchange(.init, config));
        const result = try session.exchange(.key_address, &secret);
        defer self.allocator.free(result);
        if (result.len != 32) return error.InvalidAleoSignerAddress;
        return result[0..32].*;
    }
};
