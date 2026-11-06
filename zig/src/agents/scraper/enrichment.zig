//! Receipt lanes are separate bounded state machines. plan() snapshots at most
//! 100 rows and advances its sweep watermark; each fetch job is independent and
//! persists successful neighbors. finish() links durable successes even if some
//! jobs failed/timed out. Supervisor schedules <=4 RPC jobs/domain, <=16 global,
//! <=5 DB operations, using one owned connection per job and absolute deadlines.
const std = @import("std");
const src = @import("source.zig");
pub const Stream = enum { delivery, gas };
pub const Meta = struct { block_number: u64, block_hash: src.Hash, tx_hash: [64]u8 };
pub const Row = struct { id: i64, meta: Meta };
pub const Txn = struct { hash: [64]u8, block_hash: src.Hash, block_number: u64, gas_limit: u256, max_priority_fee: ?u256 = null, max_fee: ?u256 = null, gas_price: ?u256 = null, effective_gas_price: ?u256 = null, nonce: u64, sender: src.Hash, recipient: ?src.Hash = null, gas_used: u256, cumulative_gas_used: u256, raw_input: ?[]const u8 = null };
pub const OwnedTxn = struct {
    arena: std.heap.ArenaAllocator,
    value: Txn,
    pub fn deinit(self: *OwnedTxn) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub const Request = struct { meta: Meta, block_id: ?i64 };
pub const Page = struct {
    arena: std.heap.ArenaAllocator,
    stream: Stream,
    after: i64,
    through: i64,
    rows: []const Row,
    requests: []const Request,
    pub fn deinit(self: *Page) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub const Outcome = struct { more: bool, pending: usize, linked: u64 };
pub const Lane = struct {
    stream: Stream,
    after: i64 = 0,
    pub fn plan(self: *Lane, allocator: std.mem.Allocator, store: anytype) !Page {
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const start = self.after;
        const rows = try store.pendingReceipts(a, self.stream, start, 100);
        if (rows.len > 100) return error.ScraperReceiptPageLimit;
        var previous = start;
        for (rows) |row| {
            if (row.id <= previous) return error.UnorderedReceiptPage;
            previous = row.id;
        }
        self.after = if (rows.len == 0) 0 else previous;
        var requests: std.ArrayList(Request) = .empty;
        var identities = std.AutoHashMap([64]u8, src.Hash).init(a);
        for (rows) |row| {
            if (std.mem.allEqual(u8, &row.meta.tx_hash, 0) or std.mem.allEqual(u8, &row.meta.block_hash, 0)) return error.InvalidPendingReceiptIdentity;
            const entry = try identities.getOrPut(row.meta.tx_hash);
            if (entry.found_existing) {
                if (!std.mem.eql(u8, entry.value_ptr, &row.meta.block_hash)) return error.InconsistentReceiptBlock;
                continue;
            }
            entry.value_ptr.* = row.meta.block_hash;
            const block = try store.knownBlock(row.meta);
            if (block == null) return error.MissingRetainedReceiptBlock;
            if (try store.knownTransaction(row.meta) == null) try requests.append(a, .{ .meta = row.meta, .block_id = block.? });
        }
        const owned_requests = try requests.toOwnedSlice(a);
        return .{ .arena = arena, .stream = self.stream, .after = start, .through = previous, .rows = rows, .requests = owned_requests };
    }
    pub fn finish(_: Lane, store: anytype, page: Page) !Outcome {
        const linked = if (page.through > page.after) try store.linkReceipts(page.stream, page.after, page.through) else 0;
        var pending: usize = 0;
        for (page.rows) |row| {
            if (try store.knownTransaction(row.meta) == null) pending += 1;
        }
        return .{ .more = page.rows.len == 100 and pending == 0, .pending = pending, .linked = linked };
    }
};
pub const Fetcher = struct {
    context: *anyopaque,
    fetch_fn: *const fn (*anyopaque, std.mem.Allocator, Meta, u64) anyerror!OwnedTxn,
    header_fn: ?*const fn (*anyopaque, Meta, u64) anyerror!src.Header = null,
    pub fn fetch(self: Fetcher, allocator: std.mem.Allocator, meta: Meta, deadline_ns: u64) !OwnedTxn {
        return self.fetch_fn(self.context, allocator, meta, deadline_ns);
    }
};
pub fn fetchAndPersist(allocator: std.mem.Allocator, store: anytype, fetcher: Fetcher, request: Request, deadline_ns: u64) !void {
    if (try store.knownTransaction(request.meta) != null) return;
    var result = try fetcher.fetch(allocator, request.meta, deadline_ns);
    defer result.deinit();
    if (!std.mem.eql(u8, &result.value.hash, &request.meta.tx_hash) or !std.mem.eql(u8, &result.value.block_hash, &request.meta.block_hash) or result.value.block_number != request.meta.block_number) return error.ScraperReceiptIdentityMismatch;
    const block_id = request.block_id orelse try store.knownBlock(request.meta) orelse blk: {
        const header_fn = fetcher.header_fn orelse return error.UnsupportedScraperBlockEnrichment;
        const header = try header_fn(fetcher.context, request.meta, deadline_ns);
        if (header.height != request.meta.block_number or !std.mem.eql(u8, &header.hash, &request.meta.block_hash)) return error.ScraperReceiptIdentityMismatch;
        break :blk try store.ensureBlock(header);
    };
    try store.storeTransaction(block_id, result.value);
}

/// Persist a completed RPC result without retaining a database lease while the
/// chain fetch runs. Optional missing-block header was fetched before the lease.
pub fn persistFetched(store: anytype, request: Request, value: Txn, header: ?src.Header) !void {
    if (!std.mem.eql(u8, &value.hash, &request.meta.tx_hash) or !std.mem.eql(u8, &value.block_hash, &request.meta.block_hash) or value.block_number != request.meta.block_number) return error.ScraperReceiptIdentityMismatch;
    if (try store.knownTransaction(request.meta) != null) return;
    const block_id = request.block_id orelse try store.knownBlock(request.meta) orelse blk: {
        const block = header orelse return error.MissingRetainedReceiptBlock;
        if (block.height != request.meta.block_number or !std.mem.eql(u8, &block.hash, &request.meta.block_hash)) return error.ScraperReceiptIdentityMismatch;
        break :blk try store.ensureBlock(block);
    };
    try store.storeTransaction(block_id, value);
}
