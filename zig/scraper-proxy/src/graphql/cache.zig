//! `response-cache.ts` + `cache-config.ts`: `@cached(ttl, refresh)` response
//! cache. Thread-safe (one mutex); prepared documents (parse + validate +
//! cache-key text) are memoized in a bounded LRU like the TS WeakMap/Map.
const std = @import("std");
const core = @import("core");
const json = core.json;
const ast = @import("ast.zig");
const parser = @import("parser.zig");
const printer = @import("printer.zig");
const schema_mod = @import("schema.zig");
const validate = @import("validate.zig");
const validation_rule = @import("validation_rule.zig");
const compat = @import("compat.zig");
const values = @import("values.zig");
const js = @import("js.zig");

const Value = json.Value;
const Schema = schema_mod.Schema;
const Allocator = std.mem.Allocator;

pub const default_cache_ttl_seconds = 60;
pub const max_cache_ttl_seconds = 300;
const max_prepared_documents = 256;
const max_prepared_document_bytes = 8_192;
const max_entries = 1_000;
const max_entry_bytes = 1_000_000;
const max_total_bytes = 16_000_000;

pub fn clampCacheTtl(ttl: f64) f64 {
    return @min(@max(ttl, 0), max_cache_ttl_seconds);
}

/// `max-age=${clampCacheTtl(ttl)}, public`.
pub fn cacheControlHeader(a: Allocator, ttl: f64) ![]const u8 {
    const clamped = clampCacheTtl(ttl);
    // Whole seconds (every hit, and integer @cached ttls) come from a table.
    if (@floor(clamped) == clamped) return cache_control_values[@intFromFloat(clamped)];
    return std.fmt.allocPrint(a, "max-age={s}, public", .{try js.numberString(a, clamped)});
}

const cache_control_values: [max_cache_ttl_seconds + 1][]const u8 = blk: {
    @setEvalBranchQuota(100_000);
    var table: [max_cache_ttl_seconds + 1][]const u8 = undefined;
    for (&table, 0..) |*v, i| v.* = std.fmt.comptimePrint("max-age={d}, public", .{i});
    break :blk table;
};

/// `query.includes('cached')`: SIMD scan for 'c', then compare.
fn containsCached(query: []const u8) bool {
    const needle = "cached";
    var i: usize = 0;
    while (std.mem.indexOfScalarPos(u8, query, i, 'c')) |at| {
        if (std.mem.startsWith(u8, query[at..], needle)) return true;
        i = at + 1;
    }
    return false;
}

pub const CacheDirective = struct { refresh: bool, ttl: f64 };

/// `cacheDirective(operation, variables)` with `valueFromASTUntyped` args.
pub fn cacheDirective(a: Allocator, op: *const ast.Operation, variables: ?Value) !?CacheDirective {
    if (op.operation != .query) return null;
    const node = for (op.directives) |*d| {
        if (std.mem.eql(u8, d.name.value, "cached")) break d;
    } else return null;
    var ttl: ?Value = null;
    var refresh: ?Value = null;
    for (node.arguments) |arg| {
        const v = try valueFromAstUntyped(a, arg.value, variables);
        if (std.mem.eql(u8, arg.name.value, "ttl")) ttl = v;
        if (std.mem.eql(u8, arg.name.value, "refresh")) refresh = v;
    }
    return .{
        .refresh = if (refresh) |r| r == .bool and r.bool else false,
        .ttl = if (ttl) |t| (if (t == .number) clampCacheTtl(t.number) else default_cache_ttl_seconds) else default_cache_ttl_seconds,
    };
}

/// graphql-js `valueFromASTUntyped`; null = undefined.
fn valueFromAstUntyped(a: Allocator, node: *const ast.Value, variables: ?Value) Allocator.Error!?Value {
    return switch (node.data) {
        .null => .null,
        .int => |text| .{ .number = parseIntJs(text) },
        .float => |text| .{ .number = std.fmt.parseFloat(f64, text) catch std.math.nan(f64) },
        .string => |s| .{ .string = s.value },
        .enum_value => |s| .{ .string = s },
        .boolean => |b| .{ .bool = b },
        .list => |items| blk: {
            const out = try a.alloc(Value, items.len);
            for (items, out) |item, *slot| slot.* = (try valueFromAstUntyped(a, item, variables)) orelse .null;
            break :blk .{ .array = out };
        },
        .object => |fields| blk: {
            var members: std.ArrayList(json.Member) = .empty;
            for (fields) |f| {
                const v = (try valueFromAstUntyped(a, f.value, variables)) orelse continue;
                try putMember(a, &members, f.name.value, v);
            }
            break :blk .{ .object = members.items };
        },
        .variable => |v| if (variables) |vars| vars.get(v.name.value) else null,
    };
}

/// UTF-8 length of `JSON.stringify([operationName, query])`.
fn documentKeyLength(k: DocKey) usize {
    const op_len = if (k.operation_name) |n| jsonStringLength(n) else 4; // null
    return 1 + op_len + 1 + jsonStringLength(k.query) + 1;
}

fn jsonStringLength(s: []const u8) usize {
    var n: usize = 2;
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        const c = s[i];
        n += switch (c) {
            '"', '\\', 0x08, 0x0C, '\n', '\r', '\t' => 2,
            0x00...0x07, 0x0B, 0x0E...0x1F => 6,
            else => 1,
        };
        // WTF-8 lone surrogates serialize as \udxxx (3 bytes -> 6).
        if (c == 0xED and i + 2 < s.len and s[i + 1] >= 0xA0) {
            n += 3;
            i += 2;
        }
    }
    return n;
}

fn parseIntJs(text: []const u8) f64 {
    if (std.fmt.parseInt(i64, text, 10)) |n| return @floatFromInt(n) else |_| {}
    return std.fmt.parseFloat(f64, text) catch std.math.nan(f64);
}

fn putMember(a: Allocator, list: *std.ArrayList(json.Member), key: []const u8, value: Value) !void {
    for (list.items) |*m| if (std.mem.eql(u8, m.key, key)) {
        m.value = value;
        return;
    };
    try list.append(a, .{ .key = key, .value = value });
}

/// A response-cache key: the exact normalized bytes TS hashes with SHA-256
/// (`operationName \0 normalizedQuery \0 sortedUsedVariables`), compared in
/// full on lookup (so two requests share an entry exactly when TS's digests
/// would match, minus SHA-256's theoretical collisions), and a wyhash of
/// them for bucketing only.
pub const Key = struct {
    hash: u64,
    bytes: []const u8,
};

const KeyContext = struct {
    pub fn hash(_: KeyContext, k: Key) u64 {
        return k.hash;
    }
    pub fn eql(_: KeyContext, x: Key, y: Key) bool {
        return x.hash == y.hash and std.mem.eql(u8, x.bytes, y.bytes);
    }
};

pub const PreparedCacheRequest = struct {
    key: Key,
    refresh: bool,
    ttl: f64,
};

pub const CachedResponse = struct { body: []const u8, ttl: f64 };

/// A cache hit sharing the stored body (no copy); `release` when written.
pub const SharedHit = struct { entry: *anyopaque, body: []const u8, ttl: f64 };

/// Most requests parked on one key's flight; later misses on that key run
/// their own query, as without single-flight. Bounds the memory a herd
/// holds (DEVIATIONS.md: ~31 KiB per parked request on Linux), where TS's
/// 25-slot admission sheds the same herd with 503s.
pub const max_flight_waiters = 1024;

/// Keys whose last flight ended without a stored response (an error,
/// `no-store`, an oversized body), remembered for `uncacheable_ms` so their
/// misses run at once, like TS, instead of each wave waiting for a leader
/// that will not cache either. Bounded: the oldest of `max_uncacheable`
/// marks is overwritten. Only the key's hash is kept, so a collision can
/// make another key's misses skip single-flight for a moment (TS's
/// behaviour), or a write of another key clear a mark early (that key's next
/// wave waits once more, as without marks); responses are correct either way.
pub const max_uncacheable = 256;
pub const uncacheable_ms = 1000;

const Uncacheable = struct {
    hashes: [max_uncacheable]u64 = @splat(0),
    until: [max_uncacheable]i64 = @splat(0),
    next: usize = 0,

    fn marked(self: *const Uncacheable, hash: u64, now: i64) bool {
        for (self.hashes, self.until) |h, until| {
            if (h == hash and until > now) return true;
        }
        return false;
    }

    fn mark(self: *Uncacheable, hash: u64, until: i64) void {
        self.clear(hash);
        self.hashes[self.next] = hash;
        self.until[self.next] = until;
        self.next = (self.next + 1) % max_uncacheable;
    }

    fn clear(self: *Uncacheable, hash: u64) void {
        for (self.hashes, &self.until) |h, *until| {
            if (h == hash) until.* = 0;
        }
    }
};

/// A request parked on another request's miss of the same key (lives on
/// the parked request's stack until it wakes).
pub const FlightWaiter = struct {
    waiter: core.fiber.Waiter = .{},
    next: ?*FlightWaiter = null,
};

/// The miss running for a key (single-flight, DEVIATIONS.md).
const Flight = struct {
    /// Owned copy of the key bytes.
    key: Key,
    waiters: ?*FlightWaiter = null,
    len: usize = 0,
};

/// `ResponseCache.lookup`.
pub const Lookup = union(enum) {
    hit: SharedHit,
    /// First miss on the key: run the query, then `land` (always).
    lead,
    /// Parked target registered: `waiter.wait()`, then `readShared` once.
    wait,
    /// Run the query without a flight (refresh, ttl 0, a full flight).
    miss,
};

/// `[operationName, query]` per schema (the TS WeakMap<schema, Map<JSON key>>).
const DocKey = struct { schema: usize, operation_name: ?[]const u8, query: []const u8 };

const DocKeyContext = struct {
    pub fn hash(_: DocKeyContext, k: DocKey) u64 {
        var h = std.hash.Wyhash.init(k.schema);
        if (k.operation_name) |n| {
            h.update("\x01");
            h.update(n);
        } else h.update("\x00");
        h.update(k.query);
        return h.final();
    }
    pub fn eql(_: DocKeyContext, a: DocKey, b: DocKey) bool {
        if (a.schema != b.schema) return false;
        if ((a.operation_name == null) != (b.operation_name == null)) return false;
        if (a.operation_name) |n| if (!std.mem.eql(u8, n, b.operation_name.?)) return false;
        return std.mem.eql(u8, a.query, b.query);
    }
};

const PreparedDocument = struct {
    arena: std.heap.ArenaAllocator,
    key: DocKey = .{ .schema = 0, .operation_name = null, .query = "" },
    /// Response-cache key when the document uses no data variables (constant;
    /// bytes in this document's arena).
    static_key: ?Key = null,
    /// The key's constant prefix (`operationName \0 normalizedQuery \0`) and
    /// its wyhash, the seed of each request's key hash.
    key_prefix: []const u8 = "",
    prefix_hash: u64 = 0,
    operation: *const ast.Operation,
    query: []const u8,
    used_variables: compat.UsedVariables,
    /// References: the cache (while `cached`) plus in-flight `prepare` calls.
    /// Taken under the cache mutex (a mapped document always holds the
    /// cache's reference); dropped lock-free, last one frees.
    refs: std.atomic.Value(u32) = .init(1),
    cached: bool = false,
    prev: ?*PreparedDocument = null,
    next: ?*PreparedDocument = null,
};

const Entry = struct {
    /// Owned copy of the key bytes.
    key: Key,
    body: []const u8,
    expires: i64,
    /// The `ttl` it was written with (a woken flight waiter only takes an
    /// entry of its own ttl).
    ttl: f64,
    /// The cache's reference (while stored) plus in-flight shared reads.
    /// Taken under the cache mutex; dropped lock-free, last one frees.
    refs: std.atomic.Value(u32) = .init(1),
    prev: ?*Entry = null,
    next: ?*Entry = null,
};

fn Lru(comptime T: type) type {
    return struct {
        head: ?*T = null, // oldest
        tail: ?*T = null, // newest
        len: usize = 0,

        fn unlink(self: *@This(), n: *T) void {
            if (n.prev) |p| p.next = n.next else self.head = n.next;
            if (n.next) |nx| nx.prev = n.prev else self.tail = n.prev;
            n.prev = null;
            n.next = null;
            self.len -= 1;
        }

        fn push(self: *@This(), n: *T) void {
            n.prev = self.tail;
            n.next = null;
            if (self.tail) |t| t.next = n else self.head = n;
            self.tail = n;
            self.len += 1;
        }

        /// Marks `n` most recently used.
        fn touch(self: *@This(), n: *T) void {
            if (self.tail == n) return;
            self.unlink(n);
            self.push(n);
        }
    };
}

pub const ResponseCache = struct {
    gpa: Allocator,
    mutex: std.Thread.Mutex = .{},
    documents: std.HashMapUnmanaged(DocKey, *PreparedDocument, DocKeyContext, std.hash_map.default_max_load_percentage) = .empty,
    document_order: Lru(PreparedDocument) = .{},
    entries: std.HashMapUnmanaged(Key, *Entry, KeyContext, std.hash_map.default_max_load_percentage) = .empty,
    entry_order: Lru(Entry) = .{},
    flights: std.HashMapUnmanaged(Key, *Flight, KeyContext, std.hash_map.default_max_load_percentage) = .empty,
    /// `max_flight_waiters` (tests lower it).
    max_waiters: usize = max_flight_waiters,
    uncacheable: Uncacheable = .{},
    bytes: usize = 0,
    /// Millisecond clock (tests inject a fake).
    now_ms: *const fn () i64 = defaultNow,
    /// Number of documents parsed+validated (test hook for memoization).
    validations: std.atomic.Value(usize) = .init(0),

    fn defaultNow() i64 {
        return std.time.milliTimestamp();
    }

    pub fn init(gpa: Allocator) ResponseCache {
        return .{ .gpa = gpa };
    }

    pub fn deinit(self: *ResponseCache) void {
        while (self.document_order.head) |d| {
            self.document_order.unlink(d);
            self.freeDocument(d);
        }
        self.documents.deinit(self.gpa);
        while (self.entry_order.head) |e| {
            self.entry_order.unlink(e);
            self.freeEntry(e);
        }
        self.entries.deinit(self.gpa);
        // Every leader lands before the route is torn down, except after a
        // forced shutdown that left a connection (and its leader) running:
        // its flight is leaked like the connection, not freed under it.
        if (self.flights.count() == 0) self.flights.deinit(self.gpa);
    }

    /// `prepare(schema, body)`: `body` is the request body / querystring object.
    /// error.StackOverflow: TS's recursive `sortObjectKeys` of the cache key
    /// overflows V8's stack on a deep variable value (see `key_budget`); the
    /// route answers like the error thrown from graphql.ts's preHandler.
    pub fn prepare(self: *ResponseCache, a: Allocator, schema: *const Schema, body: Value) (Allocator.Error || error{StackOverflow})!?PreparedCacheRequest {
        if (body != .object) return null;
        const query = body.get("query") orelse return null;
        if (query != .string or !containsCached(query.string)) return null;
        const op_name_value = body.get("operationName") orelse Value.null;
        if (op_name_value != .null and op_name_value != .string) return null;
        var variables: Value = body.get("variables") orelse Value.null;
        if (variables == .null) variables = .{ .object = &.{} };
        if (variables == .string) {
            variables = json.parse(a, variables.string, .{}) catch return null;
            if (variables == .null) variables = .{ .object = &.{} };
        }
        if (variables != .object) return null;
        const operation_name: ?[]const u8 = if (op_name_value == .string) op_name_value.string else null;

        const doc_key: DocKey = .{ .schema = @intFromPtr(schema), .operation_name = operation_name, .query = query.string };
        // The lock covers lookup/insert/LRU only; parse, validation, variable
        // coercion and key hashing run outside it on a referenced document.
        const p = (try self.acquireDocument(a, schema, doc_key)) orelse return null;
        defer self.releaseDocument(p);
        switch (try values.getVariableValues(a, schema, p.operation.variable_definitions, variables)) {
            .errors => return null,
            .coerced => {},
        }
        const directive = (try cacheDirective(a, p.operation, variables)) orelse return null;
        if (p.static_key == null and try keyOverflows(a, p, variables)) return error.StackOverflow;
        return .{
            // A static key lives in the document's arena, which may go once
            // the document is released: the request keeps its own copy.
            .key = if (p.static_key) |k| .{ .hash = k.hash, .bytes = try a.dupe(u8, k.bytes) } else try cacheKey(a, p, variables),
            .refresh = directive.refresh,
            .ttl = directive.ttl,
        };
    }

    /// Returns a referenced prepared document (cached, freshly inserted, or a
    /// private copy for oversized keys / lost insert races).
    fn acquireDocument(self: *ResponseCache, a: Allocator, schema: *const Schema, doc_key: DocKey) !?*PreparedDocument {
        self.mutex.lock();
        if (self.documents.get(doc_key)) |p| {
            self.document_order.touch(p);
            _ = p.refs.fetchAdd(1, .monotonic);
            self.mutex.unlock();
            return p;
        }
        self.mutex.unlock();
        const fresh = (try self.prepareDocument(a, schema, doc_key.query, doc_key.operation_name)) orelse return null;
        // TS retains only when Buffer.byteLength(JSON.stringify([op, query])) <= 8192.
        if (documentKeyLength(doc_key) > max_prepared_document_bytes) return fresh; // uncached
        const pa = fresh.arena.allocator();
        fresh.key = .{
            .schema = doc_key.schema,
            .operation_name = if (doc_key.operation_name) |n| (pa.dupe(u8, n) catch return fresh) else null,
            .query = pa.dupe(u8, doc_key.query) catch return fresh,
        };
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.documents.contains(doc_key)) return fresh; // lost the race: private copy
        self.documents.put(self.gpa, fresh.key, fresh) catch return fresh;
        fresh.cached = true;
        _ = fresh.refs.fetchAdd(1, .monotonic);
        self.document_order.push(fresh);
        if (self.document_order.len > max_prepared_documents) {
            const oldest = self.document_order.head.?;
            self.document_order.unlink(oldest);
            _ = self.documents.remove(oldest.key);
            oldest.cached = false;
            self.releaseDocument(oldest);
        }
        return fresh;
    }

    fn releaseDocument(self: *ResponseCache, p: *PreparedDocument) void {
        if (p.refs.fetchSub(1, .acq_rel) == 1) self.freeDocument(p);
    }

    fn freeDocument(self: *ResponseCache, p: *PreparedDocument) void {
        p.arena.deinit();
        self.gpa.destroy(p);
    }

    /// Parses, strips and validates `query` (validation scratch in `a`) and
    /// keeps only the operation AST and cache-key text in the document arena.
    /// The returned document holds one reference.
    fn prepareDocument(self: *ResponseCache, a: Allocator, schema: *const Schema, query: []const u8, operation_name: ?[]const u8) !?*PreparedDocument {
        _ = self.validations.fetchAdd(1, .monotonic);
        const p = try self.gpa.create(PreparedDocument);
        p.* = .{ .arena = std.heap.ArenaAllocator.init(self.gpa), .operation = undefined, .query = undefined, .used_variables = .empty };
        var keep = false;
        defer if (!keep) self.freeDocument(p);
        const pa = p.arena.allocator();
        var diag: parser.Diagnostic = .{};
        const owned_query = try pa.dupe(u8, query);
        const doc = parser.parse(pa, owned_query, .{ .max_tokens = validation_rule.max_graphql_tokens }, &diag) catch |err| switch (err) {
            error.SyntaxError => return null,
            error.OutOfMemory => return error.OutOfMemory,
        };
        try compat.stripUnusedVariables(pa, doc);
        if ((try validate.validate(a, schema, doc)).len > 0) return null;
        const op = getOperation(doc, operation_name) orelse return null;
        if ((try cacheDirective(a, op, null)) == null) return null;
        // Cache-key document: @cached removed, then unused variables dropped.
        const used = try compat.collectUsedVariables(pa, doc, "cached");
        var defs: std.ArrayList(ast.Definition) = .empty;
        for (doc.definitions) |def| {
            if (def != .operation) {
                try defs.append(a, def);
                continue;
            }
            const copy = try a.create(ast.Operation);
            copy.* = def.operation.*;
            var directives: std.ArrayList(ast.Directive) = .empty;
            for (copy.directives) |d| if (!std.mem.eql(u8, d.name.value, "cached")) try directives.append(a, d);
            copy.directives = directives.items;
            copy.variable_definitions = try compat.filterDefinitions(a, copy.variable_definitions, &used);
            try defs.append(a, .{ .operation = copy });
        }
        const normalized: ast.Document = .{ .source = doc.source, .definitions = defs.items, .token_count = doc.token_count };
        p.query = try pa.dupe(u8, try printer.printDocument(a, &normalized));
        p.used_variables = used;
        p.operation = op;
        p.key_prefix = try std.mem.concat(pa, u8, &.{ operation_name orelse "", "\x00", p.query, "\x00" });
        p.prefix_hash = std.hash.Wyhash.hash(0, p.key_prefix);
        if (used.count() == 0) p.static_key = try cacheKey(pa, p, .{ .object = &.{} });
        keep = true;
        return p;
    }

    /// TS builds the key with a recursive `sortObjectKeys({...used variables})`.
    /// Custom scalars pass any JSON through coercion, so a deep variable value
    /// reaches it; V8 then throws from the preHandler (mercurius answers 200
    /// `{"data":null,"errors":[{"message":"Maximum call stack size
    /// exceeded"}]}`). Calibrated on a cold TS process
    /// (bench/experiments/stack-depth/ts-thresholds.mjs method): `$x: bigint!`
    /// on an @cached query overflows here at 2734 nested arrays or 2074
    /// nested objects (each below the wrapper object of used variables).
    const key_budget = struct {
        const array_depth = 2734;
        const object_depth = 2074;
        const object: f64 = 1.0 / @as(f64, object_depth + 1);
        const array: f64 = (1.0 - object) / @as(f64, array_depth);
        const limit: f64 = 1.0 - 0.00035;
    };

    /// Whether `sortObjectKeys` over the used variables would overflow TS's
    /// stack: the costliest path (iterative walk) reaches `key_budget.limit`.
    fn keyOverflows(a: Allocator, p: *const PreparedDocument, variables: Value) Allocator.Error!bool {
        const Frame = struct { value: Value, cost: f64 };
        var stack: std.ArrayList(Frame) = .empty;
        defer stack.deinit(a);
        for (variables.object) |m| {
            if (p.used_variables.contains(m.key)) try stack.append(a, .{ .value = m.value, .cost = key_budget.object });
        }
        while (stack.pop()) |f| {
            switch (f.value) {
                .array => |items| {
                    const cost = f.cost + key_budget.array;
                    if (cost >= key_budget.limit) return true;
                    for (items) |item| if (item == .array or item == .object) try stack.append(a, .{ .value = item, .cost = cost });
                },
                .object => |members| {
                    const cost = f.cost + key_budget.object;
                    if (cost >= key_budget.limit) return true;
                    for (members) |m| if (m.value == .array or m.value == .object) try stack.append(a, .{ .value = m.value, .cost = cost });
                },
                else => {},
            }
        }
        return false;
    }

    /// `operationName \0 normalizedQuery \0 sortedUsedVariables`: TS's
    /// SHA-256 input, kept verbatim (the prefix comes from the document).
    fn cacheKey(a: Allocator, p: *const PreparedDocument, variables: Value) !Key {
        var data: std.ArrayList(json.Member) = .empty;
        for (try js.keyOrder(a, variables.object)) |idx| {
            const m = variables.object[idx];
            if (p.used_variables.contains(m.key)) try data.append(a, m);
        }
        const sorted = try sortObjectKeys(a, .{ .object = data.items });
        const serialized = try json.stringifyAlloc(a, sorted);
        const bytes = try std.mem.concat(a, u8, &.{ p.key_prefix, serialized });
        return .{ .hash = std.hash.Wyhash.hash(p.prefix_hash, serialized), .bytes = bytes };
    }

    /// `read(request)` sharing the stored body: the caller must `release` the
    /// hit after the response is written. The lock is held only for lookup.
    pub fn readShared(self: *ResponseCache, request: PreparedCacheRequest) ?SharedHit {
        return self.readSharedTtl(request, false);
    }

    /// A woken flight waiter's read: `readShared`, but only an entry written
    /// with the waiter's own ttl (another ttl's leader may have overwritten
    /// the key since; TS would have answered this miss with its own max-age),
    /// else null: the waiter runs its own query.
    pub fn readSharedForWaiter(self: *ResponseCache, request: PreparedCacheRequest) ?SharedHit {
        return self.readSharedTtl(request, true);
    }

    fn readSharedTtl(self: *ResponseCache, request: PreparedCacheRequest, same_ttl: bool) ?SharedHit {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (request.refresh) {
            self.remove(request.key);
            return null;
        }
        const entry = self.entries.get(request.key) orelse return null;
        const now = self.now_ms();
        if (entry.expires <= now) {
            self.remove(request.key);
            return null;
        }
        if (same_ttl and entry.ttl != request.ttl) return null;
        self.entry_order.touch(entry);
        _ = entry.refs.fetchAdd(1, .monotonic);
        const remaining: f64 = @floatFromInt(entry.expires - now);
        return .{ .entry = entry, .body = entry.body, .ttl = @max(0, @ceil(remaining / 1000)) };
    }

    /// `readShared`, and on a miss single-flight: the first miss on a key
    /// leads (runs the query, then `land`s); later misses on it register
    /// `waiter` and park until the leader lands. `refresh` and ttl-0 requests
    /// always run their own query (TS runs one per request; DEVIATIONS.md).
    pub fn lookup(self: *ResponseCache, request: PreparedCacheRequest, waiter: *FlightWaiter) Lookup {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (request.refresh) {
            self.remove(request.key);
            return .miss;
        }
        if (self.entries.get(request.key)) |entry| {
            const now = self.now_ms();
            if (entry.expires > now) {
                self.entry_order.touch(entry);
                _ = entry.refs.fetchAdd(1, .monotonic);
                const remaining: f64 = @floatFromInt(entry.expires - now);
                return .{ .hit = .{ .entry = entry, .body = entry.body, .ttl = @max(0, @ceil(remaining / 1000)) } };
            }
            self.remove(request.key);
        }
        if (request.ttl == 0) return .miss;
        if (self.flights.get(flightKey(request))) |flight| {
            if (flight.len >= self.max_waiters) return .miss;
            waiter.next = flight.waiters;
            flight.waiters = waiter;
            flight.len += 1;
            return .wait;
        }
        if (self.uncacheable.marked(request.key.hash, self.now_ms())) return .miss;
        // No memory for the flight: run the query without one (correct, just
        // not coalesced).
        self.startFlight(flightKey(request)) catch return .miss;
        return .lead;
    }

    /// A flight's identity: the cache key plus the request's `ttl`, so a
    /// waiter only takes a leader's entry stored with its own ttl (a TS
    /// request would answer its own `max-age`). Same bytes, different hash.
    fn flightKey(request: PreparedCacheRequest) Key {
        const ttl_bits: u64 = @bitCast(request.ttl);
        return .{ .hash = std.hash.Wyhash.hash(request.key.hash, std.mem.asBytes(&ttl_bits)), .bytes = request.key.bytes };
    }

    fn startFlight(self: *ResponseCache, key: Key) Allocator.Error!void {
        const flight = try self.gpa.create(Flight);
        errdefer self.gpa.destroy(flight);
        const bytes = try self.gpa.dupe(u8, key.bytes);
        errdefer self.gpa.free(bytes);
        flight.* = .{ .key = .{ .hash = key.hash, .bytes = bytes } };
        try self.flights.put(self.gpa, flight.key, flight);
    }

    /// The leader of `key`'s flight finished (its entry written or not):
    /// wakes every waiter. Called once per `.lead`.
    pub fn land(self: *ResponseCache, request: PreparedCacheRequest) void {
        const key = request.key;
        self.mutex.lock();
        const kv = self.flights.fetchRemove(flightKey(request));
        // Its response was not stored: the next misses on the key run at once.
        if (!self.entries.contains(key)) self.uncacheable.mark(key.hash, self.now_ms() + uncacheable_ms);
        self.mutex.unlock();
        const flight = kv.?.value;
        var next = flight.waiters;
        self.gpa.free(flight.key.bytes);
        self.gpa.destroy(flight);
        while (next) |w| {
            // Read before waking: the waiter's stack frame may go at once.
            next = w.next;
            w.waiter.wake();
        }
    }

    pub fn release(self: *ResponseCache, hit: SharedHit) void {
        const entry: *Entry = @ptrCast(@alignCast(hit.entry));
        if (entry.refs.fetchSub(1, .acq_rel) == 1) self.freeEntry(entry);
    }

    fn freeEntry(self: *ResponseCache, entry: *Entry) void {
        self.gpa.free(entry.body);
        self.gpa.free(entry.key.bytes);
        self.gpa.destroy(entry);
    }

    /// `read(request)` copying the body into `a`.
    pub fn read(self: *ResponseCache, a: Allocator, request: PreparedCacheRequest) !?CachedResponse {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (request.refresh) {
            self.remove(request.key);
            return null;
        }
        const entry = self.entries.get(request.key) orelse return null;
        const now = self.now_ms();
        if (entry.expires <= now) {
            self.remove(request.key);
            return null;
        }
        self.entry_order.touch(entry);
        const remaining: f64 = @floatFromInt(entry.expires - now);
        return .{ .body = try a.dupe(u8, entry.body), .ttl = @max(0, @ceil(remaining / 1000)) };
    }

    /// `write(request, body)`.
    pub fn write(self: *ResponseCache, request: PreparedCacheRequest, body: []const u8) !void {
        if (request.ttl == 0) return;
        if (body.len > max_entry_bytes) return;
        self.mutex.lock();
        defer self.mutex.unlock();
        self.remove(request.key);
        self.uncacheable.clear(request.key.hash);
        const entry = try self.gpa.create(Entry);
        errdefer self.gpa.destroy(entry);
        const owned = try self.gpa.dupe(u8, body);
        errdefer self.gpa.free(owned);
        const key_bytes = try self.gpa.dupe(u8, request.key.bytes);
        errdefer self.gpa.free(key_bytes);
        const key: Key = .{ .hash = request.key.hash, .bytes = key_bytes };
        entry.* = .{ .key = key, .body = owned, .expires = self.now_ms() + @as(i64, @intFromFloat(request.ttl * 1000)), .ttl = request.ttl };
        try self.entries.put(self.gpa, key, entry);
        self.entry_order.push(entry);
        self.bytes += owned.len;
        while (self.entry_order.len > max_entries or self.bytes > max_total_bytes) {
            const oldest = self.entry_order.head orelse break;
            self.remove(oldest.key);
        }
    }

    fn remove(self: *ResponseCache, key: Key) void {
        const kv = self.entries.fetchRemove(key) orelse return;
        const entry = kv.value;
        self.entry_order.unlink(entry);
        self.bytes -= entry.body.len;
        if (entry.refs.fetchSub(1, .acq_rel) == 1) self.freeEntry(entry);
    }
};

/// graphql-js `getOperationAST`.
pub fn getOperation(doc: *const ast.Document, operation_name: ?[]const u8) ?*const ast.Operation {
    var found: ?*const ast.Operation = null;
    for (doc.definitions) |def| {
        if (def != .operation) continue;
        const op = def.operation;
        if (operation_name) |name| {
            if (op.name != null and std.mem.eql(u8, op.name.?.value, name)) return op;
        } else {
            if (found != null) return null;
            found = op;
        }
    }
    return found;
}

/// `sortObjectKeys`: object keys sorted by UTF-16 code units, recursively.
fn sortObjectKeys(a: Allocator, value: Value) Allocator.Error!Value {
    switch (value) {
        .array => |items| {
            const out = try a.alloc(Value, items.len);
            for (items, out) |item, *slot| slot.* = try sortObjectKeys(a, item);
            return .{ .array = out };
        },
        .object => |members| {
            const out = try a.alloc(json.Member, members.len);
            for (members, out) |m, *slot| slot.* = .{ .key = m.key, .value = try sortObjectKeys(a, m.value) };
            std.mem.sort(json.Member, out, {}, struct {
                fn lessThan(_: void, x: json.Member, y: json.Member) bool {
                    return utf16Less(x.key, y.key);
                }
            }.lessThan);
            return .{ .object = out };
        },
        else => return value,
    }
}

fn utf16Less(x: []const u8, y: []const u8) bool {
    // UTF-8 byte order equals code point order, which differs from UTF-16
    // order only for supplementary vs U+E000..U+FFFF; keys are ASCII in practice.
    return std.mem.lessThan(u8, x, y);
}

// ---------------------------------------------------------------------------
// Tests (response-cache.test.ts)
// ---------------------------------------------------------------------------

fn parseBody(a: Allocator, text: []const u8) !Value {
    return json.parse(a, text, .{});
}

test "canonicalizes generated nested variable-key permutations" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var cache = ResponseCache.init(std.testing.allocator);
    defer cache.deinit();
    const schema = schema_mod.testing.scraper();
    const query = "\n    query Cached($filter: domain_bool_exp!) @cached(ttl: 30) {\n      domain(where: $filter) { id }\n    }\n  ";
    for (0..200) |index| {
        const q = try json.stringifyAlloc(a, .{ .string = query });
        const forward = try std.fmt.allocPrint(a, "{{\"query\":{s},\"variables\":{{\"filter\":{{\"id\":{{\"_eq\":{d}}},\"is_deprecated\":{{\"_eq\":{}}},\"name\":{{\"_eq\":\"domain-{d}\"}}}}}}}}", .{ q, index, index % 2 == 0, index });
        const reverse = try std.fmt.allocPrint(a, "{{\"query\":{s},\"variables\":{{\"filter\":{{\"name\":{{\"_eq\":\"domain-{d}\"}},\"is_deprecated\":{{\"_eq\":{}}},\"id\":{{\"_eq\":{d}}}}}}}}}", .{ q, index, index % 2 == 0, index });
        const w = (try cache.prepare(a, schema, try parseBody(a, forward))).?;
        const r = (try cache.prepare(a, schema, try parseBody(a, reverse))).?;
        const body = try std.fmt.allocPrint(a, "result-{d}", .{index});
        try cache.write(w, body);
        try std.testing.expectEqualStrings(body, (try cache.read(a, r)).?.body);
    }
}

test "memoizes query validation without reusing request variables or crossing schemas" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var cache = ResponseCache.init(std.testing.allocator);
    defer cache.deinit();
    const schema = schema_mod.testing.scraper();
    const query = "\n    query First($id: Int!, $ttl: Int!, $refresh: Boolean!) @cached(ttl: $ttl, refresh: $refresh) {\n      domain(where: {id: {_eq: $id}}) { id }\n    }\n  ";
    const q = try json.stringifyAlloc(a, .{ .string = query });
    const body = struct {
        fn make(al: Allocator, qq: []const u8, op: []const u8, vars: []const u8) !Value {
            return parseBody(al, try std.fmt.allocPrint(al, "{{\"query\":{s}{s},\"variables\":{s}}}", .{ qq, op, vars }));
        }
    };
    const first = (try cache.prepare(a, schema, try body.make(a, q, ",\"operationName\":\"First\"", "{\"id\":1,\"ttl\":30,\"refresh\":false}"))).?;
    try cache.write(first, "first");
    const calls = cache.validations.load(.monotonic);
    try std.testing.expect(calls > 0);
    const again = (try cache.prepare(a, schema, try body.make(a, q, ",\"operationName\":\"First\"", "{\"id\":1,\"ttl\":30,\"refresh\":false}"))).?;
    try std.testing.expectEqualDeep(first, again);
    try std.testing.expectEqual(calls, cache.validations.load(.monotonic));
    const changed = (try cache.prepare(a, schema, try body.make(a, q, ",\"operationName\":\"First\"", "{\"id\":2,\"ttl\":10,\"refresh\":true}"))).?;
    try std.testing.expect(!KeyContext.eql(.{}, changed.key, first.key));
    try std.testing.expectEqual(@as(f64, 10), changed.ttl);
    try std.testing.expect(changed.refresh);
    try std.testing.expect((try cache.read(a, changed)) == null);
    try std.testing.expect((try cache.prepare(a, schema, try body.make(a, q, ",\"operationName\":\"First\"", "{\"id\":\"invalid\",\"ttl\":30,\"refresh\":false}"))) == null);
    try std.testing.expect((try cache.prepare(a, schema, try body.make(a, q, ",\"operationName\":\"First\"", "{\"ttl\":30,\"refresh\":false}"))) == null);
    const unnamed = (try cache.prepare(a, schema, try body.make(a, q, "", "{\"id\":1,\"ttl\":30,\"refresh\":false}"))).?;
    try std.testing.expect(!KeyContext.eql(.{}, unnamed.key, first.key));
    try std.testing.expect((try cache.prepare(a, schema, try body.make(a, q, ",\"operationName\":\"Missing\"", "{\"id\":1,\"ttl\":30,\"refresh\":false}"))) == null);
    const other = try schema_mod.buildSchema(std.testing.allocator, &.{"type Query { other: Int }"});
    defer {
        other.deinit();
        std.testing.allocator.destroy(other);
    }
    try std.testing.expect((try cache.prepare(a, other, try body.make(a, q, ",\"operationName\":\"First\"", "{\"id\":1,\"ttl\":30,\"refresh\":false}"))) == null);
    try std.testing.expectEqualStrings("first", (try cache.read(a, first)).?.body);
}

test "bounds prepared documents with LRU eviction and skips oversized query text" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var cache = ResponseCache.init(std.testing.allocator);
    defer cache.deinit();
    const schema = schema_mod.testing.scraper();
    const prep = struct {
        fn run(c: *ResponseCache, al: Allocator, s: *const Schema, suffix: []const u8) !void {
            const query = try std.fmt.allocPrint(al, "query @cached {{ domain {{ id }} }} #{s}", .{suffix});
            var members = [_]json.Member{.{ .key = "query", .value = .{ .string = query } }};
            try std.testing.expect((try c.prepare(al, s, .{ .object = &members })) != null);
        }
    };
    for (0..256) |i| try prep.run(&cache, a, schema, try std.fmt.allocPrint(a, "{d}", .{i}));
    const calls = cache.validations.load(.monotonic);
    try prep.run(&cache, a, schema, "0");
    try std.testing.expectEqual(calls, cache.validations.load(.monotonic));
    try prep.run(&cache, a, schema, "256");
    const after_insert = cache.validations.load(.monotonic);
    try prep.run(&cache, a, schema, "0");
    try std.testing.expectEqual(after_insert, cache.validations.load(.monotonic));
    try prep.run(&cache, a, schema, "1");
    try std.testing.expect(cache.validations.load(.monotonic) > after_insert);
    const big = try a.alloc(u8, 8192);
    @memset(big, 'x');
    for (0..2) |_| {
        const before = cache.validations.load(.monotonic);
        try prep.run(&cache, a, schema, big);
        try std.testing.expect(cache.validations.load(.monotonic) > before);
    }
}

test "cache directive and header" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    try std.testing.expectEqualStrings("max-age=300, public", try cacheControlHeader(a, 1000));
    try std.testing.expectEqualStrings("max-age=0, public", try cacheControlHeader(a, -5));
    try std.testing.expectEqualStrings("max-age=2.5, public", try cacheControlHeader(a, 2.5));
    try std.testing.expectEqualStrings("max-age=17, public", try cacheControlHeader(a, 17));
    try std.testing.expect(containsCached("query @cached { a }") and containsCached("cached") and containsCached("ccached"));
    try std.testing.expect(!containsCached("query @cache { a }") and !containsCached("") and !containsCached("cachec"));
    var diag: parser.Diagnostic = .{};
    const doc = try parser.parse(a, "query @cached(ttl: 3000, refresh: true) { a }", .{}, &diag);
    const d = (try cacheDirective(a, doc.definitions[0].operation, null)).?;
    try std.testing.expectEqual(@as(f64, 300), d.ttl);
    try std.testing.expect(d.refresh);
}

test "concurrent prepare under eviction keeps documents alive and keys stable" {
    const schema = schema_mod.testing.scraper();
    var cache = ResponseCache.init(std.testing.allocator); // leak-checked
    defer cache.deinit();
    const distinct = 300; // above the 256-document LRU, so eviction races with use
    var expected: [distinct]Key = undefined;
    var expected_arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer expected_arena.deinit();
    {
        var single = ResponseCache.init(std.testing.allocator);
        defer single.deinit();
        for (&expected, 0..) |*key, i| {
            const ea = expected_arena.allocator();
            const query = try std.fmt.allocPrint(ea, "query @cached(ttl: 30) {{ domain(limit: {d}) {{ id }} }}", .{i % 500 + 1});
            var members = [_]json.Member{.{ .key = "query", .value = .{ .string = query } }};
            key.* = (try single.prepare(ea, schema, .{ .object = &members })).?.key;
        }
    }
    const Worker = struct {
        fn run(c: *ResponseCache, s: *const Schema, want: *const [distinct]Key, seed: usize, failures: *std.atomic.Value(u32)) void {
            var arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
            defer arena.deinit();
            for (0..600) |n| {
                _ = arena.reset(.retain_capacity);
                const i = (n * 7 + seed * 13) % distinct;
                const query = std.fmt.allocPrint(arena.allocator(), "query @cached(ttl: 30) {{ domain(limit: {d}) {{ id }} }}", .{i % 500 + 1}) catch return;
                var members = [_]json.Member{.{ .key = "query", .value = .{ .string = query } }};
                const got = c.prepare(arena.allocator(), s, .{ .object = &members }) catch null;
                if (got == null or !KeyContext.eql(.{}, got.?.key, want[i])) _ = failures.fetchAdd(1, .monotonic);
            }
        }
    };
    var failures: std.atomic.Value(u32) = .init(0);
    var threads: [8]std.Thread = undefined;
    for (&threads, 0..) |*t, seed| t.* = try std.Thread.spawn(.{}, Worker.run, .{ &cache, schema, &expected, seed, &failures });
    for (threads) |t| t.join();
    try std.testing.expectEqual(@as(u32, 0), failures.load(.monotonic));
    try std.testing.expect(cache.document_order.len <= max_prepared_documents);
}

test "shared hits keep the body alive across replacement and eviction" {
    var cache = ResponseCache.init(std.testing.allocator);
    defer cache.deinit();
    const key: Key = .{ .hash = 1, .bytes = "k\x00{ k }\x00{}" };
    const request: PreparedCacheRequest = .{ .key = key, .refresh = false, .ttl = 30 };
    try cache.write(request, "first body");
    const hit = cache.readShared(request).?;
    try cache.write(request, "second body"); // replaces the entry while the hit is in flight
    try std.testing.expectEqualStrings("first body", hit.body);
    const hit2 = cache.readShared(.{ .key = key, .refresh = true, .ttl = 30 }); // refresh evicts
    try std.testing.expect(hit2 == null);
    try std.testing.expectEqualStrings("first body", hit.body);
    cache.release(hit);
    try std.testing.expect(cache.readShared(request) == null);
}

test "response-cache key: TS's SHA-256 input bytes, compared in full" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var cache = ResponseCache.init(std.testing.allocator);
    defer cache.deinit();
    const schema = schema_mod.testing.scraper();
    const query = "query Named($id: Int!, $unused: Int) @cached(ttl: 30) { domain(where: {id: {_eq: $id}}) { id } }";
    const q = try json.stringifyAlloc(a, .{ .string = query });
    const req = try parseBody(a, try std.fmt.allocPrint(a, "{{\"query\":{s},\"operationName\":\"Named\",\"variables\":{{\"unused\":5,\"id\":7}}}}", .{q}));
    const prepared = (try cache.prepare(a, schema, req)).?;
    const p = (try cache.acquireDocument(a, schema, .{ .schema = @intFromPtr(schema), .operation_name = "Named", .query = query })).?;
    defer cache.releaseDocument(p);
    // Exactly what TS feeds to SHA-256 (unused variables dropped, keys sorted).
    try std.testing.expectEqualStrings(try std.mem.concat(a, u8, &.{ "Named\x00", p.query, "\x00{\"id\":7}" }), prepared.key.bytes);
    // Different keys never share an entry, even with equal bucket hashes.
    try cache.write(prepared, "seven");
    const forged: PreparedCacheRequest = .{ .key = .{ .hash = prepared.key.hash, .bytes = "Named\x00x\x00{\"id\":7}" }, .refresh = false, .ttl = 30 };
    try std.testing.expect((try cache.read(a, forged)) == null);
    try std.testing.expectEqualStrings("seven", (try cache.read(a, prepared)).?.body);
    // Variable-free documents: a static key, copied per request.
    const static_req = try parseBody(a, "{\"query\":\"query @cached(ttl: 30) { domain(limit: 1) { id } }\"}");
    const s1 = (try cache.prepare(a, schema, static_req)).?;
    const s2 = (try cache.prepare(a, schema, static_req)).?;
    try std.testing.expect(KeyContext.eql(.{}, s1.key, s2.key));
    try std.testing.expect(s1.key.bytes.ptr != s2.key.bytes.ptr);
}

test "uncacheable marks: misses skip single-flight for a second, bounded, cleared by a write" {
    const T = struct {
        var now: i64 = 1_000_000;
        fn clock() i64 {
            return now;
        }
        fn req(buf: *[16]u8, i: usize) PreparedCacheRequest {
            const bytes = std.fmt.bufPrint(buf, "key-{d}", .{i}) catch unreachable;
            return .{ .key = .{ .hash = std.hash.Wyhash.hash(0, bytes), .bytes = bytes }, .refresh = false, .ttl = 30 };
        }
    };
    var cache = ResponseCache.init(std.testing.allocator);
    defer cache.deinit();
    cache.now_ms = T.clock;
    var w: FlightWaiter = .{};
    var buf: [16]u8 = undefined;
    // A leader that stores nothing marks its key: the next miss runs at once.
    try std.testing.expect(cache.lookup(T.req(&buf, 0), &w) == .lead);
    cache.land(T.req(&buf, 0));
    try std.testing.expect(cache.lookup(T.req(&buf, 0), &w) == .miss);
    // ...for `uncacheable_ms`, then it leads again.
    T.now += uncacheable_ms;
    try std.testing.expect(cache.lookup(T.req(&buf, 0), &w) == .lead);
    // A stored response clears the mark.
    try cache.write(T.req(&buf, 0), "{}");
    cache.land(T.req(&buf, 0));
    switch (cache.lookup(T.req(&buf, 0), &w)) {
        .hit => |hit| cache.release(hit),
        else => return error.TestUnexpectedResult,
    }
    // Bounded: marking more keys than `max_uncacheable` drops the oldest.
    var bounded = ResponseCache.init(std.testing.allocator);
    defer bounded.deinit();
    bounded.now_ms = T.clock;
    const n = max_uncacheable + 44;
    for (1..n + 1) |i| {
        try std.testing.expect(bounded.lookup(T.req(&buf, i), &w) == .lead);
        bounded.land(T.req(&buf, i));
    }
    // The newest `max_uncacheable` are still marked...
    for (n - max_uncacheable + 1..n + 1) |i| try std.testing.expect(bounded.lookup(T.req(&buf, i), &w) == .miss);
    // ...the 44 before them were overwritten.
    for (1..n - max_uncacheable + 1) |i| {
        try std.testing.expect(bounded.lookup(T.req(&buf, i), &w) == .lead);
        bounded.land(T.req(&buf, i));
    }
}

test "a woken waiter takes only an entry of its own ttl (another ttl's write in between)" {
    var cache = ResponseCache.init(std.testing.allocator);
    defer cache.deinit();
    const bytes = "op\x00query { domain { id } }\x00{}";
    const key: Key = .{ .hash = std.hash.Wyhash.hash(0, bytes), .bytes = bytes };
    const a: PreparedCacheRequest = .{ .key = key, .refresh = false, .ttl = 30 };
    const b: PreparedCacheRequest = .{ .key = key, .refresh = false, .ttl = 300 };
    var w: FlightWaiter = .{};
    try std.testing.expect(cache.lookup(a, &w) == .lead);
    var w2: FlightWaiter = .{};
    try std.testing.expect(cache.lookup(a, &w2) == .wait);
    // A writes and lands (waking its waiter); B's write lands before the
    // waiter reads: the waiter runs its own query, a plain hit takes B's.
    try cache.write(a, "{\"a\":1}");
    cache.land(a);
    try cache.write(b, "{\"b\":1}");
    try std.testing.expect(cache.readSharedForWaiter(a) == null);
    const hit = cache.readShared(a).?;
    defer cache.release(hit);
    try std.testing.expectEqualStrings("{\"b\":1}", hit.body);
    // Same ttl: the waiter takes it.
    const own = cache.readSharedForWaiter(b).?;
    cache.release(own);
}
