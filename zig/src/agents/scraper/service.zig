//! Concrete EVM scraper service wiring. The supervisor submits headCycle as one
//! bounded blocking job per chain; auxiliary lanes use separately owned DB/RPC
//! clients. This object is heap-stable because Worker points into its fields.
const std = @import("std");
const settings = @import("../../settings/types.zig");
const pg = @import("../../db/postgres.zig");
const head = @import("../../db/scraper_store.zig");
const rpc = @import("../../evm/provider.zig");
const evm = @import("evm.zig");
const runtime = @import("runtime.zig");
const setup = @import("setup.zig");
const storage = @import("storage.zig");
const enrich = @import("enrichment.zig");
const reconciliation = @import("reconciliation.zig");
pub const Evm = struct {
    allocator: std.mem.Allocator,
    rpc_client: *rpc.RpcClient,
    head_store: head.Store,
    source: evm.Evm,
    worker: runtime.Worker(head.Store),
    delivery: enrich.Lane = .{ .stream = .delivery },
    gas: enrich.Lane = .{ .stream = .gas },
    backoff: reconciliation.Backoff,
    pub fn init(allocator: std.mem.Allocator, rpc_client: *rpc.RpcClient, connection: *pg.Connection, chain: settings.Chain, writer_id: []const u8, db_timeout_ms: u32) !*Evm {
        if (chain.protocol != .ethereum) return error.UnsupportedConcreteScraperProtocol;
        if (rpc_client.options.native_transport == null) return error.NativeScraperTransportRequired;
        if (writer_id.len == 0 or writer_id.len > 256) return error.InvalidScraperWriterId;
        const chain_id = try std.fmt.parseInt(u256, chain.chain_id, if (std.mem.startsWith(u8, chain.chain_id, "0x")) 0 else 10);
        const reorg = try setup.period(chain.reorg);
        const poll_ms = try std.math.mul(u64, chain.index.interval, 1000);
        if (chain.index.chunk == 0) return error.InvalidScraperChunk;
        try rpc_client.checkChain(chain_id);
        const self = try allocator.create(Evm);
        errdefer allocator.destroy(self);
        self.* = .{ .allocator = allocator, .rpc_client = rpc_client, .head_store = .{ .connection = connection, .domain = chain.domain, .writer_id = writer_id }, .source = .{ .rpc_client = rpc_client, .domain = chain.domain, .contracts = .{ .mailbox = chain.contracts.mailbox, .hook = chain.contracts.merkle_tree_hook, .paymaster = chain.contracts.interchain_gas_paymaster } }, .worker = undefined, .backoff = .{ .allocator = allocator } };
        try (storage.Store{ .connection = connection, .domain = chain.domain, .mailbox = chain.contracts.mailbox }).configure(db_timeout_ms);
        const source = self.source.interface();
        try setup.prepare(source, &self.head_store, chain);
        self.worker = .{ .allocator = allocator, .source = source, .store = &self.head_store, .options = .{ .period = reorg, .chunk_size = chain.index.chunk, .poll_ms = poll_ms } };
        return self;
    }
    /// Borrowed native clients/connections remain caller-owned. Join/cancel jobs
    /// before destroying this object or releasing those borrowed resources.
    pub fn deinit(self: *Evm) void {
        const allocator = self.allocator;
        self.backoff.deinit();
        allocator.destroy(self);
    }
    pub fn headCycle(self: *Evm) !runtime.Outcome {
        return self.worker.cycle();
    }
    pub fn auxiliaryStore(self: *Evm, connection: *pg.Connection) storage.Store {
        return .{ .connection = connection, .domain = self.head_store.domain, .mailbox = self.source.contracts.mailbox };
    }
};

/// Native PG service shared by every concrete source factory. Source context,
/// writer bytes and connection are borrowed and must outlive all joined jobs.
pub const Native = struct {
    allocator: std.mem.Allocator,
    head_store: head.Store,
    worker: runtime.Worker(head.Store),
    delivery: enrich.Lane = .{ .stream = .delivery },
    gas: enrich.Lane = .{ .stream = .gas },
    backoff: reconciliation.Backoff,
    pub fn init(allocator: std.mem.Allocator, connection: *pg.Connection, source: @import("source.zig").Source, chain: *const settings.Chain, writer_id: []const u8, db_timeout_ms: u32) !*Native {
        if (writer_id.len == 0 or writer_id.len > 256) return error.InvalidScraperWriterId;
        const reorg = try setup.period(chain.reorg);
        const poll_ms = try std.math.mul(u64, chain.index.interval, 1000);
        if (chain.index.chunk == 0) return error.InvalidScraperChunk;
        if ((chain.index.mode == .sequence) != source.sequence_mode) return error.ScraperIndexModeMismatch;
        const self = try allocator.create(Native);
        errdefer allocator.destroy(self);
        self.* = .{ .allocator = allocator, .head_store = .{ .connection = connection, .domain = chain.domain, .writer_id = writer_id }, .worker = undefined, .backoff = .{ .allocator = allocator } };
        try self.auxiliaryStore(connection, chain.contracts.mailbox).configure(db_timeout_ms);
        try setup.prepare(source, &self.head_store, chain.*);
        self.worker = .{ .allocator = allocator, .source = source, .store = &self.head_store, .options = .{ .period = reorg, .chunk_size = chain.index.chunk, .poll_ms = poll_ms } };
        return self;
    }
    pub fn deinit(self: *Native) void {
        const allocator = self.allocator;
        self.backoff.deinit();
        allocator.destroy(self);
    }
    pub fn headCycle(self: *Native) !runtime.Outcome {
        return self.worker.cycle();
    }
    pub fn auxiliaryStore(self: *Native, connection: *pg.Connection, mailbox: [32]u8) storage.Store {
        return .{ .connection = connection, .domain = self.head_store.domain, .mailbox = mailbox };
    }
};

/// Pool-backed jobs retain no live database lease between cycles. Worker source
/// and its chain clients remain serial; auxiliary jobs own separate RPC clients.
pub const Pooled = struct {
    allocator: std.mem.Allocator,
    pool: *@import("../../db/pool.zig").Pool,
    native: *Native,
    mailbox: [32]u8,
    db_timeout_ms: u32,
    pub fn init(allocator: std.mem.Allocator, pool: *@import("../../db/pool.zig").Pool, source: @import("source.zig").Source, chain: *const settings.Chain, writer_id: []const u8, db_timeout_ms: u32, options: pg.IoOptions) !*Pooled {
        if (db_timeout_ms == 0) return error.InvalidScraperDbDeadline;
        if (pool.config.session_timeout_ms) |configured| if (configured != db_timeout_ms) return error.ConflictingPostgresSessionTimeout;
        var lease = try pool.acquire(options);
        defer lease.deinit();
        const self = try allocator.create(Pooled);
        errdefer allocator.destroy(self);
        source.bindCancellation(options.cancel);
        defer source.bindCancellation(null);
        const native = try Native.init(allocator, lease.connection(), source, chain, writer_id, db_timeout_ms);
        self.* = .{ .allocator = allocator, .pool = pool, .native = native, .mailbox = chain.contracts.mailbox, .db_timeout_ms = db_timeout_ms };
        return self;
    }
    pub fn deinit(self: *Pooled) void {
        self.native.deinit();
        const a = self.allocator;
        a.destroy(self);
    }
    pub fn headCycle(self: *Pooled, options: pg.IoOptions) !runtime.Outcome {
        var lease = try self.pool.acquire(options);
        defer lease.deinit();
        self.native.head_store.connection = lease.connection();
        if (self.pool.config.session_timeout_ms != self.db_timeout_ms) try self.native.auxiliaryStore(lease.connection(), self.mailbox).configure(self.db_timeout_ms);
        self.native.worker.source.bindCancellation(options.cancel);
        defer self.native.worker.source.bindCancellation(null);
        return self.native.headCycle() catch |err| {
            // Read head/frontiers and reprove counts from the fresh connection
            // on the next scheduled job, including unknown COMMIT outcomes.
            self.native.worker.cache = .{};
            return err;
        };
    }
    pub fn auxiliary(self: *Pooled, options: pg.IoOptions) !Auxiliary {
        var lease = try self.pool.acquire(options);
        errdefer lease.deinit();
        const store = self.native.auxiliaryStore(lease.connection(), self.mailbox);
        if (self.pool.config.session_timeout_ms != self.db_timeout_ms) try store.configure(self.db_timeout_ms);
        return .{ .lease = lease, .store = store };
    }
    pub const Auxiliary = struct {
        lease: @import("../../db/pool.zig").Lease,
        store: storage.Store,
        pub fn deinit(self: *Auxiliary) void {
            self.lease.deinit();
        }
    };
};
