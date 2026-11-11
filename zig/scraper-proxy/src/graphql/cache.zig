//! `response-cache.ts` + `cache-config.ts`: `@cached(ttl, refresh)` response
//! cache. Thread-safe (one mutex); prepared documents (parse + validate +
//! cache-key text) are memoized in a bounded LRU like the TS WeakMap/Map.
const std = @import("std");
const json = @import("core").json;
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
    return std.fmt.allocPrint(a, "max-age={s}, public", .{try js.numberString(a, clampCacheTtl(ttl))});
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

pub const PreparedCacheRequest = struct {
    key: [64]u8,
    refresh: bool,
    ttl: f64,
};

pub const CachedResponse = struct { body: []const u8, ttl: f64 };

/// A cache hit sharing the stored body (no copy); `release` when written.
pub const SharedHit = struct { entry: *anyopaque, body: []const u8, ttl: f64 };

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
    /// Response-cache key when the document uses no data variables (constant).
    static_key: ?[64]u8 = null,
    operation: *const ast.Operation,
    query: []const u8,
    used_variables: compat.UsedVariables,
    /// References: the cache (while `cached`) plus in-flight `prepare` calls.
    refs: u32 = 1,
    cached: bool = false,
    prev: ?*PreparedDocument = null,
    next: ?*PreparedDocument = null,
};

const Entry = struct {
    key: [64]u8,
    body: []const u8,
    expires: i64,
    /// The cache's reference (while stored) plus in-flight shared reads.
    refs: u32 = 1,
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
    };
}

pub const ResponseCache = struct {
    gpa: Allocator,
    mutex: std.Thread.Mutex = .{},
    documents: std.HashMapUnmanaged(DocKey, *PreparedDocument, DocKeyContext, std.hash_map.default_max_load_percentage) = .empty,
    document_order: Lru(PreparedDocument) = .{},
    entries: std.AutoHashMapUnmanaged([64]u8, *Entry) = .empty,
    entry_order: Lru(Entry) = .{},
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
    }

    /// `prepare(schema, body)`: `body` is the request body / querystring object.
    pub fn prepare(self: *ResponseCache, a: Allocator, schema: *const Schema, body: Value) !?PreparedCacheRequest {
        if (body != .object) return null;
        const query = body.get("query") orelse return null;
        if (query != .string or std.mem.indexOf(u8, query.string, "cached") == null) return null;
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
        return .{
            .key = p.static_key orelse try cacheKey(a, operation_name, p, variables),
            .refresh = directive.refresh,
            .ttl = directive.ttl,
        };
    }

    /// Returns a referenced prepared document (cached, freshly inserted, or a
    /// private copy for oversized keys / lost insert races).
    fn acquireDocument(self: *ResponseCache, a: Allocator, schema: *const Schema, doc_key: DocKey) !?*PreparedDocument {
        self.mutex.lock();
        if (self.documents.get(doc_key)) |p| {
            self.document_order.unlink(p);
            self.document_order.push(p);
            p.refs += 1;
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
        fresh.refs += 1;
        self.document_order.push(fresh);
        if (self.document_order.len > max_prepared_documents) {
            const oldest = self.document_order.head.?;
            self.document_order.unlink(oldest);
            _ = self.documents.remove(oldest.key);
            oldest.cached = false;
            oldest.refs -= 1;
            if (oldest.refs == 0) self.freeDocument(oldest);
        }
        return fresh;
    }

    fn releaseDocument(self: *ResponseCache, p: *PreparedDocument) void {
        self.mutex.lock();
        p.refs -= 1;
        const last = p.refs == 0;
        self.mutex.unlock();
        if (last) self.freeDocument(p);
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
        if (used.count() == 0) p.static_key = try cacheKey(a, operation_name, p, .{ .object = &.{} });
        keep = true;
        return p;
    }

    fn cacheKey(a: Allocator, operation_name: ?[]const u8, p: *const PreparedDocument, variables: Value) ![64]u8 {
        var data: std.ArrayList(json.Member) = .empty;
        for (try js.keyOrder(a, variables.object)) |idx| {
            const m = variables.object[idx];
            if (p.used_variables.contains(m.key)) try data.append(a, m);
        }
        const sorted = try sortObjectKeys(a, .{ .object = data.items });
        const serialized = try json.stringifyAlloc(a, sorted);
        var h = std.crypto.hash.sha2.Sha256.init(.{});
        h.update(operation_name orelse "");
        h.update("\x00");
        h.update(p.query);
        h.update("\x00");
        h.update(serialized);
        var digest: [32]u8 = undefined;
        h.final(&digest);
        return std.fmt.bytesToHex(digest, .lower);
    }

    /// `read(request)` sharing the stored body: the caller must `release` the
    /// hit after the response is written. The lock is held only for lookup.
    pub fn readShared(self: *ResponseCache, request: PreparedCacheRequest) ?SharedHit {
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
        self.entry_order.unlink(entry);
        self.entry_order.push(entry);
        entry.refs += 1;
        const remaining: f64 = @floatFromInt(entry.expires - now);
        return .{ .entry = entry, .body = entry.body, .ttl = @max(0, @ceil(remaining / 1000)) };
    }

    pub fn release(self: *ResponseCache, hit: SharedHit) void {
        const entry: *Entry = @ptrCast(@alignCast(hit.entry));
        self.mutex.lock();
        entry.refs -= 1;
        const last = entry.refs == 0;
        self.mutex.unlock();
        if (last) self.freeEntry(entry);
    }

    fn freeEntry(self: *ResponseCache, entry: *Entry) void {
        self.gpa.free(entry.body);
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
        self.entry_order.unlink(entry);
        self.entry_order.push(entry);
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
        const entry = try self.gpa.create(Entry);
        errdefer self.gpa.destroy(entry);
        const owned = try self.gpa.dupe(u8, body);
        errdefer self.gpa.free(owned);
        entry.* = .{ .key = request.key, .body = owned, .expires = self.now_ms() + @as(i64, @intFromFloat(request.ttl * 1000)) };
        try self.entries.put(self.gpa, request.key, entry);
        self.entry_order.push(entry);
        self.bytes += owned.len;
        while (self.entry_order.len > max_entries or self.bytes > max_total_bytes) {
            const oldest = self.entry_order.head orelse break;
            self.remove(oldest.key);
        }
    }

    fn remove(self: *ResponseCache, key: [64]u8) void {
        const kv = self.entries.fetchRemove(key) orelse return;
        const entry = kv.value;
        self.entry_order.unlink(entry);
        self.bytes -= entry.body.len;
        entry.refs -= 1;
        if (entry.refs == 0) self.freeEntry(entry);
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
    try std.testing.expect(!std.mem.eql(u8, &changed.key, &first.key));
    try std.testing.expectEqual(@as(f64, 10), changed.ttl);
    try std.testing.expect(changed.refresh);
    try std.testing.expect((try cache.read(a, changed)) == null);
    try std.testing.expect((try cache.prepare(a, schema, try body.make(a, q, ",\"operationName\":\"First\"", "{\"id\":\"invalid\",\"ttl\":30,\"refresh\":false}"))) == null);
    try std.testing.expect((try cache.prepare(a, schema, try body.make(a, q, ",\"operationName\":\"First\"", "{\"ttl\":30,\"refresh\":false}"))) == null);
    const unnamed = (try cache.prepare(a, schema, try body.make(a, q, "", "{\"id\":1,\"ttl\":30,\"refresh\":false}"))).?;
    try std.testing.expect(!std.mem.eql(u8, &unnamed.key, &first.key));
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
    var expected: [distinct][64]u8 = undefined;
    {
        var single = ResponseCache.init(std.testing.allocator);
        defer single.deinit();
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena.deinit();
        for (&expected, 0..) |*key, i| {
            const query = try std.fmt.allocPrint(arena.allocator(), "query @cached(ttl: 30) {{ domain(limit: {d}) {{ id }} }}", .{i % 500 + 1});
            var members = [_]json.Member{.{ .key = "query", .value = .{ .string = query } }};
            key.* = (try single.prepare(arena.allocator(), schema, .{ .object = &members })).?.key;
        }
    }
    const Worker = struct {
        fn run(c: *ResponseCache, s: *const Schema, want: *const [distinct][64]u8, seed: usize, failures: *std.atomic.Value(u32)) void {
            var arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
            defer arena.deinit();
            for (0..600) |n| {
                _ = arena.reset(.retain_capacity);
                const i = (n * 7 + seed * 13) % distinct;
                const query = std.fmt.allocPrint(arena.allocator(), "query @cached(ttl: 30) {{ domain(limit: {d}) {{ id }} }}", .{i % 500 + 1}) catch return;
                var members = [_]json.Member{.{ .key = "query", .value = .{ .string = query } }};
                const got = c.prepare(arena.allocator(), s, .{ .object = &members }) catch null;
                if (got == null or !std.mem.eql(u8, &got.?.key, &want[i])) _ = failures.fetchAdd(1, .monotonic);
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
    var key: [64]u8 = undefined;
    @memset(&key, 'k');
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
