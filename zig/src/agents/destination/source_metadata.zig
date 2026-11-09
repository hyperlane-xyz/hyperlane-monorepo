//! Read-only native ISM source. Forks own typed RPC state and replay journals;
//! they borrow the parent global transports, byte budget and origin history.
//! Module addresses remain full32 bytes, validator identities remain20 bytes.
const std = @import("std");
const resources = @import("../chain_source.zig");
const protocol = @import("../../protocol/root.zig");
const metadata = @import("../../relayer/metadata.zig");
const quorum = @import("../../relayer/quorum.zig");
const ccip = @import("../../relayer/ccip.zig");
const contract_cache = @import("../../relayer/contract_cache.zig");
const cached = @import("../../relayer/cached_source.zig");
const storage = @import("../../storage/objects.zig");
const common = @import("../scraper/receipts_common.zig");
const felt = @import("../../starknet/codec.zig").Felt;
const A = std.mem.Allocator;
const Hash = [32]u8;
const Address = [20]u8;
pub const LookupCache = struct { cache: *contract_cache.CacheFor([32]u8).Cache, context: contract_cache.Context, now_ms: u64 };
pub const Options = struct {
    deadline_ns: u64,
    cancel: ?*const std.atomic.Value(bool) = null,
    svm_payer: ?Hash = null,
    svm_identity: ?Hash = null,
    tron_sender: ?Address = null,
    executor: ?*@import("../../relayer/metadata_parallel.zig").Executor = null,
    observation: ?metadata.Observation = null,
    app_context: ?[]const u8 = null,
    default_ism_cache: ?*contract_cache.CacheFor([32]u8).Cache = null,
    ccip_handler: ?ccip.Handler = null,
    lookup_cache: ?LookupCache = null,
};
pub fn Source(comptime Origin: type) type {
    return struct {
        const Self = @This();
        const sessions = @hasDecl(Origin, "forkMetadata");
        const Session = if (sessions) Origin.MetadataSession else void;
        pub const ModuleAddress = Hash;
        pub const parallel_quorum = true;
        pub const parallel_latest = @hasDecl(Origin, "fetchLatestIndices");
        allocator: A,
        readers: *resources.Resources,
        origin: *Origin,
        options: Options,
        owned: bool = false,
        owns_handler: bool = false,
        session: if (sessions) ?Session else void = if (sessions) null else {},
        view: View = undefined,
        svm_mailbox: @import("../../sealevel/mailbox.zig").Mailbox = undefined,
        svm_inline_members: ?@import("../../sealevel/metadata.zig").InlineMembers = null,
        owns_svm_inline_members: bool = false,
        metadata_parent: ?@import("../../relayer/metadata_parallel.zig").CancelLink = null,

        pub fn init(a: A, readers: *resources.Resources, origin: *Origin, options: Options) Self {
            return .{ .allocator = a, .readers = readers, .origin = origin, .options = options };
        }
        fn check(self: *Self) !void {
            if (self.options.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
            if (self.metadata_parent) |parent| if (parent.poll()) return error.RequestCancelled;
            _ = try common.milliseconds(self.options.deadline_ns);
        }
        pub fn setMetadataParent(self: *Self, parent: ?@import("../../relayer/metadata_parallel.zig").CancelLink) void {
            if (parent) |link| link.retain();
            if (self.metadata_parent) |link| link.release();
            self.metadata_parent = parent;
        }
        /// Same raw monotonic epoch as Factory.active_cache_ms; evaluate after
        /// the default-ISM fetch rather than reusing the wrapper's lookup time.
        pub fn defaultIsmNow(_: *Self) !u64 {
            return (try @import("../scraper/receipts_evm.zig").nowNs()) / std.time.ns_per_ms;
        }
        fn bind(self: *Self) !void {
            try self.check();
            self.view = .{ .owner = self };
            // Every physical native request receives the remaining absolute
            // attempt budget, including replayed/fallback calls.
            const remaining = try common.milliseconds(self.options.deadline_ns);
            self.readers.http.timeout_ms = @min(self.readers.options.request_timeout_ms, remaining);
            self.readers.http.connect_timeout_ms = @min(5000, self.readers.http.timeout_ms);
            self.readers.setCancellation(self.options.cancel);
            switch (self.readers.clients) {
                .sealevel => |client| {
                    client.deadline_ns = self.options.deadline_ns;
                    self.svm_mailbox = .{ .client = client, .program = self.readers.chain.contracts.mailbox, .domain = self.readers.chain.domain, .payer = self.options.svm_payer };
                },
                .tron => |provider| provider.signer_address = self.options.tron_sender,
                .cosmos => |*clients| clients.queries.timeout_ms = @min(self.readers.options.request_timeout_ms, remaining),
                else => {},
            }
        }
        pub fn fork(self: *Self, a: A, cancel: *const std.atomic.Value(bool)) !*Self {
            try self.check();
            const child = try a.create(Self);
            errdefer a.destroy(child);
            const cloned = try self.readers.forkRead(a);
            errdefer cloned.deinit();
            child.* = init(a, cloned, self.origin, self.options);
            child.owned = true;
            child.setMetadataParent(self.metadata_parent);
            errdefer child.setMetadataParent(null);
            if (self.svm_inline_members) |set| {
                child.svm_inline_members = .{ .validators = try a.dupe(Address, set.validators), .threshold = set.threshold };
                child.owns_svm_inline_members = true;
            }
            errdefer if (child.owns_svm_inline_members) a.free(child.svm_inline_members.?.validators);
            const remaining = @min(cloned.options.read_attempt_timeout_ms, try common.milliseconds(self.options.deadline_ns));
            const started = try std.time.Instant.now();
            if (cloned.read_replay) |replay| {
                replay.config.max_attempt_ms = remaining;
                replay.started = started;
            }
            if (cloned.http_replay) |replay| {
                replay.config.max_attempt_ms = remaining;
                replay.started = started;
            }
            child.options.cancel = cancel;
            if (sessions) {
                child.session = try self.origin.forkMetadata(a, cancel);
                child.session.?.shared_budget = cloned.options.read_budget;
            }
            errdefer if (sessions) if (child.session) |*session| session.deinit();
            if (self.options.ccip_handler) |handler| {
                child.options.ccip_handler = try handler.nativeFork(a, child.lookupSource(), 0, cancel);
                child.owns_handler = true;
            }
            return child;
        }
        pub fn deinitFork(self: *Self) void {
            std.debug.assert(self.owned);
            if (self.owns_handler) if (self.options.ccip_handler) |*handler| handler.deinit();
            if (sessions) if (self.session) |*session| session.deinit();
            self.readers.deinit();
            if (self.owns_svm_inline_members) self.allocator.free(self.svm_inline_members.?.validators);
            self.setMetadataParent(null);
            self.allocator.destroy(self);
        }
        pub fn beginPass(self: *Self, cancel: ?*const std.atomic.Value(bool)) !void {
            self.options.cancel = cancel;
            try self.bind();
            try self.readers.beginReadPass(cancel);
            errdefer self.readers.endReadPass(error.RequestCancelled);
            if (sessions) if (self.session) |*session| try session.beginPass(cancel);
        }
        pub fn endPass(self: *Self, failure: ?anyerror) void {
            if (sessions) if (self.session) |*session| session.endPass(failure);
            self.readers.endReadPass(failure);
        }
        fn svm(self: *Self) !@import("../../sealevel/metadata.zig").Source(View) {
            try self.bind();
            return .{ .allocator = self.allocator, .ism = .{ .mailbox = &self.svm_mailbox, .identity = self.options.svm_identity }, .origin = &self.view, .cancel = self.options.cancel, .inline_executor = if (self.options.executor) |executor| .{ .executor = executor, .context = self, .fork_fn = inlineFork } else null, .leaf_builder = .{ .context = self, .build_fn = inlineLeaf } };
        }
        fn inlineLeaf(context: *anyopaque, a: A, address: Hash, message: protocol.Message, set: @import("../../sealevel/metadata.zig").InlineMembers) ![]u8 {
            const self: *Self = @ptrCast(@alignCast(context));
            var leaf = self.*;
            leaf.allocator = a;
            leaf.svm_inline_members = set;
            leaf.owns_svm_inline_members = false;
            var builder: metadata.Builder(Self) = .{
                .allocator = a,
                .source = &leaf,
                .executor = self.options.executor,
                .observation = self.options.observation,
                .app_context = self.options.app_context orelse "Unknown",
                .cancel = self.options.cancel,
                .parent_link = self.metadata_parent,
            };
            return builder.build(address, message);
        }
        fn inlineFork(context: *anyopaque, a: A, cancel: *const std.atomic.Value(bool)) !@import("../../sealevel/metadata.zig").InlineView {
            const self: *Self = @ptrCast(@alignCast(context));
            const child = try self.fork(a, cancel);
            return .{ .context = child, .build_fn = inlineBuild, .begin_fn = inlineBegin, .end_fn = inlineEnd, .deinit_fn = inlineDeinit };
        }
        fn inlineBuild(context: *anyopaque, a: A, address: Hash, message: protocol.Message, spec: @import("../../sealevel/instructions.zig").MetadataSpec, depth: usize) ![]u8 {
            const self: *Self = @ptrCast(@alignCast(context));
            var source = try self.svm();
            source.allocator = a;
            return source.buildSpecDepth(address, message, spec, depth);
        }
        fn inlineBegin(context: *anyopaque, cancel: *const std.atomic.Value(bool)) !void {
            const self: *Self = @ptrCast(@alignCast(context));
            return self.beginPass(cancel);
        }
        fn inlineEnd(context: *anyopaque, failure: ?anyerror) void {
            const self: *Self = @ptrCast(@alignCast(context));
            self.endPass(failure);
        }
        fn inlineDeinit(context: *anyopaque) void {
            const self: *Self = @ptrCast(@alignCast(context));
            self.deinitFork();
        }
        fn cosmos(self: *Self) !@import("cosmos.zig").Source(View) {
            try self.bind();
            var queries = self.readers.clients.cosmos.queries;
            queries.allocator = self.allocator;
            queries.cancel = self.options.cancel;
            queries.timeout_ms = @min(queries.timeout_ms, try common.milliseconds(self.options.deadline_ns));
            return .{ .queries = queries, .native = self.readers.chain.protocol == .cosmosnative, .origin = &self.view };
        }
        fn radix(self: *Self) !@import("radix.zig").Source(View) {
            try self.bind();
            var client = self.readers.clients.radix;
            client.allocator = self.allocator;
            return .{ .chain = .{ .provider = client, .mailbox = try @import("../../radix/address.zig").node(self.readers.chain.contracts.mailbox), .domain = self.readers.chain.domain }, .origin = &self.view };
        }
        fn tron(self: *Self) !@import("../../tron/contracts.zig").Source(View) {
            try self.bind();
            return .{ .chain = .{ .provider = self.readers.clients.tron, .mailbox = try evm(self.readers.chain.contracts.mailbox), .hook = try evm(self.readers.chain.contracts.merkle_tree_hook), .domain = self.readers.chain.domain }, .origin = &self.view };
        }
        fn starknet(self: *Self) !@import("../../starknet/contracts.zig").Source(View) {
            try self.bind();
            return .{ .chain = .{ .provider = &self.readers.clients.starknet.provider, .mailbox = try felt.fromBytes(self.readers.chain.contracts.mailbox), .hook = try felt.fromBytes(self.readers.chain.contracts.merkle_tree_hook), .domain = self.readers.chain.domain }, .origin = &self.view };
        }
        fn aleo(self: *Self) !@import("../../aleo/contracts.zig").Source(View) {
            try self.bind();
            const factory = self.readers.clients.aleo;
            return .{ .chain = try @import("../../aleo/contracts.zig").Contracts.init(&factory.provider, factory.configuration), .origin = &self.view };
        }
        pub fn defaultIsm(self: *Self) !Hash {
            switch (self.readers.clients) {
                .sealevel => {
                    _ = try self.svm();
                    return (try self.svm_mailbox.inbox()).value.default_ism;
                },
                .cosmos => {
                    var source = try self.cosmos();
                    if (!source.native) return source.queries.wasmDefaultIsm(self.readers.chain.contracts.mailbox);
                    var mailbox = try source.queries.nativeMailbox(self.readers.chain.contracts.mailbox, null);
                    defer mailbox.deinit();
                    return @import("../../cosmos/types.zig").hash(mailbox.value.default_ism);
                },
                .radix => {
                    var source = try self.radix();
                    return @import("../../radix/address.zig").h256(try source.chain.defaultIsm());
                },
                .tron => {
                    var source = try self.tron();
                    return padded(try source.chain.defaultIsm());
                },
                .starknet => {
                    var source = try self.starknet();
                    return (try source.chain.defaultIsm()).toBytes();
                },
                .aleo => {
                    var source = try self.aleo();
                    return (try source.chain.mailbox(false)).default_ism;
                },
                .ethereum => return error.UseEvmMetadataSource,
            }
        }
        pub fn moduleType(self: *Self, address: Hash) !metadata.ModuleType {
            if (self.svm_inline_members != null) {
                try self.check();
                return .message_id_multisig;
            }
            switch (self.readers.clients) {
                .sealevel => {
                    var source = try self.svm();
                    return source.moduleType(address);
                },
                .cosmos => {
                    var source = try self.cosmos();
                    return source.moduleType(address);
                },
                .radix => {
                    var source = try self.radix();
                    return source.moduleType(address);
                },
                .tron => {
                    var source = try self.tron();
                    return source.moduleType(try evm(address));
                },
                .starknet => {
                    var source = try self.starknet();
                    return source.moduleType(try felt.fromBytes(address));
                },
                .aleo => {
                    var source = try self.aleo();
                    return source.moduleType(address);
                },
                .ethereum => return error.UseEvmMetadataSource,
            }
        }
        pub fn route(self: *Self, address: Hash, message: protocol.Message) !Hash {
            switch (self.readers.clients) {
                .sealevel => {
                    var source = try self.svm();
                    return source.route(address, message);
                },
                .cosmos => {
                    var source = try self.cosmos();
                    return source.route(address, message);
                },
                .radix => {
                    var source = try self.radix();
                    return source.route(address, message);
                },
                .tron => {
                    var source = try self.tron();
                    return padded(try source.route(try evm(address), message));
                },
                .starknet => {
                    var source = try self.starknet();
                    return (try source.route(try felt.fromBytes(address), message)).toBytes();
                },
                .aleo => {
                    var source = try self.aleo();
                    return source.route(address, message);
                },
                .ethereum => return error.UseEvmMetadataSource,
            }
        }
        pub fn members(self: *Self, address: Hash, message: protocol.Message, comptime validators: bool) !metadata.ModuleMembers(if (validators) Address else Hash) {
            if (self.svm_inline_members) |set| {
                try self.check();
                if (!validators) return error.UnsupportedSvmExternalAggregation;
                return .{ .addresses = try self.allocator.dupe(Address, set.validators), .threshold = set.threshold };
            }
            switch (self.readers.clients) {
                .sealevel => {
                    var source = try self.svm();
                    return source.members(address, message, validators);
                },
                .cosmos => {
                    var source = try self.cosmos();
                    return source.members(address, message, validators);
                },
                .radix => {
                    var source = try self.radix();
                    return source.members(address, message, validators);
                },
                .tron => {
                    var source = try self.tron();
                    const result = try source.members(try evm(address), message, validators);
                    defer self.readers.allocator.free(result.addresses);
                    if (validators) return .{ .addresses = try self.allocator.dupe(Address, result.addresses), .threshold = result.threshold };
                    const addresses = try self.allocator.alloc(Hash, result.addresses.len);
                    for (result.addresses, addresses) |entry, *out| out.* = padded(entry);
                    return .{ .addresses = addresses, .threshold = result.threshold };
                },
                .starknet => {
                    var source = try self.starknet();
                    const result = try source.members(try felt.fromBytes(address), message, validators);
                    defer self.readers.allocator.free(result.addresses);
                    if (validators) return .{ .addresses = try self.allocator.dupe(Address, result.addresses), .threshold = result.threshold };
                    const addresses = try self.allocator.alloc(Hash, result.addresses.len);
                    for (result.addresses, addresses) |entry, *out| out.* = entry.toBytes();
                    return .{ .addresses = addresses, .threshold = result.threshold };
                },
                .aleo => {
                    var source = try self.aleo();
                    const result = try source.members(address, message, validators);
                    defer self.readers.allocator.free(result.addresses);
                    return .{ .addresses = try self.allocator.dupe(if (validators) Address else Hash, result.addresses), .threshold = result.threshold };
                },
                .ethereum => return error.UseEvmMetadataSource,
            }
        }
        pub fn verifyCandidate(self: *Self, address: Hash, message: protocol.Message, bytes: []const u8) !metadata.Verification {
            switch (self.readers.clients) {
                .sealevel => {
                    var source = try self.svm();
                    return source.verifyCandidate(address, message, bytes);
                },
                .cosmos => {
                    var source = try self.cosmos();
                    return source.verifyCandidate(address, message, bytes);
                },
                .radix => {
                    var source = try self.radix();
                    return source.verifyCandidate(address, message, bytes);
                },
                .tron => {
                    var source = try self.tron();
                    return .{ .valid = true, .cost = try source.verify(try evm(address), message, bytes) };
                },
                .starknet => {
                    var source = try self.starknet();
                    return source.verifyCandidate(try felt.fromBytes(address), message, bytes);
                },
                .aleo => {
                    var source = try self.aleo();
                    return .{ .valid = true, .cost = try source.verify(address, message, bytes) };
                },
                .ethereum => return error.UseEvmMetadataSource,
            }
        }
        pub fn offchainLookup(self: *Self, address: Hash, message: protocol.Message) !@import("../../relayer/ccip.zig").Lookup {
            // Actual Rust chain factory exposes CCIP only for Ethereum and Tron.
            // Every other native tag explicitly reports unsupported there too.
            if (self.readers.clients != .tron) return error.UnsupportedNativeCcipRead;
            var source = try self.tron();
            return source.chain.offchainLookup(self.allocator, try evm(address), message);
        }
        pub fn ccipMetadata(self: *Self, address: Hash, message: protocol.Message) ![]u8 {
            try self.bind();
            if (self.readers.clients != .tron) return error.UnsupportedNativeCcipRead;
            const handler = self.options.ccip_handler orelse return error.CcipReadNotConfigured;
            return handler.fetch(try evm(address), message);
        }
        pub fn lookupSource(self: *Self) ccip.LookupSource {
            return .{ .context = self, .lookup_fn = nativeLookup };
        }
        fn nativeLookup(context: *anyopaque, a: A, address: Address, message: protocol.Message, _: u64, cancel: ?*const std.atomic.Value(bool)) !ccip.Lookup {
            const self: *Self = @ptrCast(@alignCast(context));
            if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
            if (self.readers.clients != .tron) return error.UnsupportedNativeCcipRead;
            if (self.options.lookup_cache) |binding| return cached.offchainLookupFor(Hash, binding.cache, binding.context, padded(address), message, .{ .context = self, .get_fn = uncachedLookup }, binding.now_ms);
            var source = try self.tron();
            // Tron exposes latest solidified constant calls, with no historical
            // block parameter. Never attach a fabricated EVM block selector.
            return source.chain.offchainLookup(a, address, message);
        }
        fn uncachedLookup(context: *anyopaque, address: Hash, message: protocol.Message) !ccip.Lookup {
            const self: *Self = @ptrCast(@alignCast(context));
            return self.offchainLookup(address, message);
        }
        pub fn compositeMetadata(self: *Self, address: Hash, message: protocol.Message) ![]u8 {
            if (self.readers.clients != .sealevel) return error.UnsupportedCompositeIsm;
            var source = try self.svm();
            return source.compositeMetadata(address, message);
        }
        pub fn leafIndex(self: *Self, id: Hash) !?u32 {
            try self.check();
            return self.origin.leafIndex(id);
        }
        pub fn highestKnownLeafIndex(self: *Self) !?u32 {
            try self.check();
            return self.origin.highestKnownLeafIndex();
        }
        pub fn proof(self: *Self, index: u32, checkpoint: protocol.Checkpoint) !protocol.Proof {
            try self.check();
            return self.origin.proof(index, checkpoint) catch |err| {
                if (err == error.MerkleRootMismatch) if (self.options.observation) |observation| {
                    if (observation.merkle_mismatch_fn) |notify| notify(observation.context, checkpoint.mailbox_domain) catch {};
                };
                return err;
            };
        }
        pub fn fetchCheckpoint(self: *Self, validator: Address, index: u32) !?storage.SignedCheckpoint {
            try self.check();
            if (sessions) if (self.session) |*session| return session.fetchCheckpoint(validator, index);
            return self.origin.fetchCheckpoint(validator, index);
        }
        pub fn latestIndex(self: *Self, validator: Address) !?u32 {
            try self.check();
            if (sessions) if (self.session) |*session| return session.latestIndex(validator);
            return self.origin.latestIndex(validator);
        }
        pub fn fetchQuorum(self: *Self, a: A, validators: []const Address, threshold: usize, index: u32, errors: *usize) !?quorum.Quorum {
            var found = (try self.standardQuorum(a, validators, threshold, index, errors)) orelse return null;
            if (self.readers.chain.protocol != .aleo) return found;
            defer found.deinit();
            return try padAleo(a, validators, found);
        }
        fn standardQuorum(self: *Self, a: A, validators: []const Address, threshold: usize, index: u32, errors: *usize) !?quorum.Quorum {
            try self.check();
            if (sessions) if (self.session) |*session| return session.fetchQuorum(a, validators, threshold, index, errors);
            if (@hasDecl(Origin, "fetchQuorum")) return self.origin.fetchQuorum(a, validators, threshold, index, errors, self.options.cancel);
            var collector = try quorum.Collector.init(a, validators, threshold, index, .standard);
            for (validators, 0..) |validator, position| {
                const signed = self.origin.fetchCheckpoint(validator, index) catch |err| {
                    if (metadata.hardFailure(err)) return err;
                    errors.* += 1;
                    continue;
                };
                if (signed) |value| if (try collector.push(.{ .validator_index = position, .signed = value })) |found| return found;
            }
            return null;
        }
        pub fn fetchLatestIndices(self: *Self, validators: []const Address, output: []?u32, errors: *usize) !void {
            try self.check();
            if (validators.len != output.len) return error.InvalidLatestIndicesLength;
            if (sessions) if (self.session) |*session| return session.fetchLatestIndices(validators, output, errors);
            if (@hasDecl(Origin, "fetchLatestIndices")) return self.origin.fetchLatestIndices(validators, output, errors, self.options.cancel);
            for (validators, output) |validator, *out| out.* = self.origin.latestIndex(validator) catch |err| {
                if (metadata.hardFailure(err)) return err;
                errors.* += 1;
                out.* = null;
                continue;
            };
        }
        const View = struct {
            owner: *Self,
            pub fn leafIndex(self: *View, id: Hash) !?u32 {
                return self.owner.leafIndex(id);
            }
            pub fn highestKnownLeafIndex(self: *View) !?u32 {
                return self.owner.highestKnownLeafIndex();
            }
            pub fn proof(self: *View, index: u32, checkpoint: protocol.Checkpoint) !protocol.Proof {
                return self.owner.proof(index, checkpoint);
            }
            pub fn fetchCheckpoint(self: *View, validator: Address, index: u32) !?storage.SignedCheckpoint {
                return self.owner.fetchCheckpoint(validator, index);
            }
            pub fn latestIndex(self: *View, validator: Address) !?u32 {
                return self.owner.latestIndex(validator);
            }
            pub fn fetchQuorum(self: *View, a: A, validators: []const Address, threshold: usize, index: u32, errors: *usize, _: ?*const std.atomic.Value(bool)) !?quorum.Quorum {
                return self.owner.fetchQuorum(a, validators, threshold, index, errors);
            }
            pub fn fetchLatestIndices(self: *View, validators: []const Address, output: []?u32, errors: *usize, _: ?*const std.atomic.Value(bool)) !void {
                return self.owner.fetchLatestIndices(validators, output, errors);
            }
        };
    };
}
fn evm(address: Hash) !Address {
    if (!std.mem.allEqual(u8, address[0..12], 0)) return error.InvalidTronModuleAddress;
    return address[12..32].*;
}
fn padded(address: Address) Hash {
    return .{0} ** 12 ++ address;
}

/// Aleo expects one signature per configured validator position. The quorum
/// winner is still selected by the common arrival-ordered authenticated collector.
fn padAleo(a: A, validators: []const Address, found: quorum.Quorum) !quorum.Quorum {
    if (validators.len > 256 or found.signatures.len > validators.len) return error.InvalidAleoQuorum;
    const signatures = try a.alloc(storage.Signature, validators.len);
    errdefer a.free(signatures);
    @memset(signatures, .{ .r = 1, .s = 1, .v = 1 });
    var filled: [256]bool = @splat(false);
    for (found.signatures) |signature| {
        const signed: storage.SignedCheckpoint = .{ .value = found.checkpoint, .signature = signature };
        const signer = try signed.recover();
        const position = for (validators, 0..) |validator, i| {
            if (std.mem.eql(u8, &validator, &signer)) break i;
        } else return error.InvalidAleoQuorumSigner;
        if (filled[position]) return error.DuplicateAleoQuorumSigner;
        filled[position] = true;
        signatures[position] = signature;
    }
    return .{ .allocator = a, .checkpoint = found.checkpoint, .signatures = signatures };
}

const EmptyHistory = struct {
    pub fn leafIndex(_: *EmptyHistory, _: Hash) !?u32 {
        return null;
    }
    pub fn highestKnownLeafIndex(_: *EmptyHistory) !?u32 {
        return null;
    }
    pub fn proof(_: *EmptyHistory, _: u32, _: protocol.Checkpoint) !protocol.Proof {
        return error.NoProof;
    }
    pub fn fetchCheckpoint(_: *EmptyHistory, _: Address, _: u32) !?storage.SignedCheckpoint {
        return null;
    }
    pub fn latestIndex(_: *EmptyHistory, _: Address) !?u32 {
        return null;
    }
};
test "native metadata source preserves full felt addresses and rejects non-padded Tron modules before IO" {
    const a = std.testing.allocator;
    var history: EmptyHistory = .{};
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    var owner: resources.Resources = undefined;
    owner.allocator = a;
    owner.environment = &env;
    owner.options = .{ .curl_library = "unused", .request_timeout_ms = 1000 };
    owner.http = @import("../../cloud/http.zig").HttpTransport.init(a);
    defer owner.http.deinit();
    owner.cancel = null;
    owner.rpc_client = null;
    owner.svm_client = null;
    owner.source_cache = null;
    owner.aleo_factory = null;
    owner.receipt_binding = null;
    var tron_provider: @import("../../tron/provider.zig").Provider = undefined;
    owner.clients = .{ .tron = &tron_provider };
    owner.chain.contracts = .{ .mailbox = .{0} ** 32, .merkle_tree_hook = .{0} ** 32, .interchain_gas_paymaster = .{0} ** 32, .validator_announce = .{0} ** 32 };
    owner.chain.domain = 2;
    var source = Source(EmptyHistory).init(a, &owner, &history, .{ .deadline_ns = try testDeadline() });
    var address: Hash = .{0} ** 32;
    address[0] = 1;
    try std.testing.expectError(error.InvalidTronModuleAddress, source.moduleType(address));
    try std.testing.expectError(error.InvalidTronModuleAddress, source.route(address, .{ .origin = 1, .destination = 2, .body = "" }));
    try std.testing.expectError(error.InvalidTronModuleAddress, source.members(address, .{ .origin = 1, .destination = 2, .body = "" }, false));
    try std.testing.expectError(error.InvalidTronModuleAddress, source.verifyCandidate(address, .{ .origin = 1, .destination = 2, .body = "" }, ""));
    try std.testing.expectEqual(address, (try felt.fromBytes(address)).toBytes());
    // Compile every delegated API against full32 addresses and the real builder.
    std.testing.refAllDecls(Source(EmptyHistory));
}
fn testDeadline() !u64 {
    return try std.math.add(u64, try @import("../scraper/receipts_evm.zig").nowNs(), 10 * std.time.ns_per_s);
}

test {
    _ = @import("source_metadata_testing.zig");
    _ = @import("source_metadata_svm_test.zig");
}

test "native metadata Aleo pads authenticated quorum signatures at original validator positions" {
    const a = std.testing.allocator;
    const secp = @import("../../protocol/signature.zig");
    const keys = [_]Hash{ .{0x11} ** 32, .{0x22} ** 32, .{0x33} ** 32 };
    var validators: [3]Address = undefined;
    for (keys, &validators) |key, *validator| validator.* = try secp.secretKeyAddress(key);
    const checkpoint: protocol.Checkpoint = .{ .merkle_tree_hook_address = .{1} ** 32, .mailbox_domain = 1, .root = .{2} ** 32, .index = 3, .message_id = .{4} ** 32 };
    var signatures: [2]storage.Signature = .{ storage.Signature.fromBytes(try secp.signDigest(keys[2], checkpoint.digest(), null)), storage.Signature.fromBytes(try secp.signDigest(keys[0], checkpoint.digest(), null)) };
    const found: quorum.Quorum = .{ .allocator = a, .checkpoint = checkpoint, .signatures = &signatures };
    var result = try padAleo(a, &validators, found);
    defer result.deinit();
    try std.testing.expectEqual(@as(usize, 3), result.signatures.len);
    try std.testing.expectEqual(signatures[1], result.signatures[0]);
    try std.testing.expectEqual(storage.Signature{ .r = 1, .s = 1, .v = 1 }, result.signatures[1]);
    try std.testing.expectEqual(signatures[0], result.signatures[2]);
    signatures[1] = signatures[0];
    try std.testing.expectError(error.DuplicateAleoQuorumSigner, padAleo(a, &validators, found));
}
