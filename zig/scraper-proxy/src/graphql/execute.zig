//! graphql-js `execute` for query operations: field collection with
//! @skip/@include, argument coercion, resolver calls, value completion with
//! non-null propagation, leaf serialization and located errors.
//!
//! Root fields run concurrently (one thread per extra field) when enabled
//! (graphql-js starts them all at once). Results and errors are merged in
//! document order; after a non-null root failure, later fields' data and
//! errors are dropped and `data` is null, like the rejected `Promise.all`
//! (see DEVIATIONS.md).
const std = @import("std");
const json = @import("core").json;
const ast = @import("ast.zig");
const schema_mod = @import("schema.zig");
const values = @import("values.zig");
const js = @import("js.zig");

const Value = json.Value;
const Member = json.Member;
const Schema = schema_mod.Schema;
const NamedType = schema_mod.NamedType;
const TypeRef = schema_mod.TypeRef;
const Allocator = std.mem.Allocator;

pub const PathSegment = union(enum) { key: []const u8, index: usize };

pub const Path = struct {
    prev: ?*const Path,
    segment: PathSegment,

    pub fn toArray(self: ?*const Path, a: Allocator) ![]const PathSegment {
        var n: usize = 0;
        var p = self;
        while (p) |node| : (p = node.prev) n += 1;
        const out = try a.alloc(PathSegment, n);
        p = self;
        while (p) |node| : (p = node.prev) {
            n -= 1;
            out[n] = node.segment;
        }
        return out;
    }
};

/// A GraphQLError as serialized by `toJSON` (plus mercurius status hint).
pub const GqlError = struct {
    message: []const u8,
    /// Omitted from JSON when empty (graphql-js: no nodes -> no locations).
    locations: []const ast.SourceLocation = &.{},
    path: ?[]const PathSegment = null,
    /// `extensions.code`.
    code: ?[]const u8 = null,
    /// `originalError.statusCode` (mercurius uses it for single errors).
    status: ?u16 = null,
};

pub fn locationsFromOffsets(a: Allocator, source: []const u8, offsets: []const u32) ![]const ast.SourceLocation {
    const out = try a.alloc(ast.SourceLocation, offsets.len);
    for (offsets, out) |o, *l| l.* = ast.location(source, o);
    return out;
}

/// Resolver failure: message + optional `extensions.code`.
pub const ResolveFailure = struct { message: []const u8, code: ?[]const u8 = null };

pub const ResolveResult = union(enum) {
    /// Use the default resolver (`source[fieldName]`).
    default,
    value: Value,
    failure: ResolveFailure,
};

pub const Info = struct {
    field_name: []const u8,
    parent_type: *const NamedType,
    field_nodes: []const *const ast.Field,
    fragments: *const std.StringHashMapUnmanaged(*const ast.Fragment),
};

pub const Resolvers = struct {
    ctx: *anyopaque,
    /// Types with custom field resolvers; other fields use the default resolver
    /// without a call (graphql-js `defaultFieldResolver`).
    parent_types: []const []const u8 = &.{"query_root"},
    resolve: *const fn (ctx: *anyopaque, a: Allocator, info: *const Info, parent: Value, args: Value) Allocator.Error!ResolveResult,
};

pub const Result = struct {
    /// Null when a non-null root field failed (or field collection threw).
    data: ?Value,
    errors: []const GqlError,
    /// Per-field arenas of concurrently executed root fields; `data` and
    /// `errors` point into them until `deinit`.
    arenas: []const *std.heap.ArenaAllocator = &.{},
    backing: ?Allocator = null,

    pub fn deinit(self: Result) void {
        const backing = self.backing orelse return;
        for (self.arenas) |arena| {
            arena.deinit();
            backing.destroy(arena);
        }
    }
};

/// Bumped by data-source adapters whenever a resolver performs I/O (database
/// query or diagnostics read) on the current thread; root fields use it to
/// tell graphql-js microtask-settled failures from I/O-settled ones.
pub threadlocal var io_events: u32 = 0;

var completion_seq: std.atomic.Value(u64) = .init(0);

/// Root-field fan-out: one short-lived thread per extra root field (FIFO
/// fairness comes from the database pool's waiter queue; std.Thread.Pool is
/// LIFO and starves old tasks under load), bounded by a shared counter, plus
/// a thread-safe allocator for the per-field arenas.
pub const Parallel = struct {
    active: *std.atomic.Value(u32),
    max_threads: u32,
    backing: Allocator,
};

pub const Executor = struct {
    a: Allocator,
    schema: *const Schema,
    source: []const u8,
    vars: values.Variables,
    resolvers: Resolvers,
    fragments: std.StringHashMapUnmanaged(*const ast.Fragment) = .empty,
    errors: std.ArrayList(GqlError) = .empty,
    /// `collectSubfields` memo keyed by (return type, field nodes), as graphql-js.
    subfields: std.AutoHashMapUnmanaged(SubfieldKey, *const Collected) = .empty,
    /// The error being raised (raw until located).
    pending: GqlError = .{ .message = "" },
    pending_offsets: []const u32 = &.{},

    const Err = error{ OutOfMemory, Raw, Located };

    const SubfieldKey = struct { named: *const NamedType, nodes: [*]const *const ast.Field, len: usize };
    const Collected = struct {
        names: []const []const u8,
        nodes: []const []const *const ast.Field,
        defs: []const ?*const schema_mod.Field,
        /// Row member index where each field was last found (rows share column order).
        hints: []usize,
    };

    fn hasCustomResolvers(self: *const Executor, parent: *const NamedType) bool {
        for (self.resolvers.parent_types) |name| if (std.mem.eql(u8, name, parent.name)) return true;
        return false;
    }

    pub fn init(a: Allocator, schema: *const Schema, doc: *const ast.Document, vars: values.Variables, resolvers: Resolvers) !Executor {
        var self: Executor = .{ .a = a, .schema = schema, .source = doc.source, .vars = vars, .resolvers = resolvers };
        for (doc.definitions) |def| {
            if (def == .fragment) try self.fragments.put(a, def.fragment.name.value, def.fragment);
        }
        return self;
    }

    pub fn executeQuery(self: *Executor, op: *const ast.Operation, parallel: ?Parallel) Allocator.Error!Result {
        const root = self.schema.query_type;
        var fields: FieldMap = .{};
        var visited: std.StringHashMapUnmanaged(void) = .empty;
        self.collectFields(root, op.selection_set, &fields, &visited) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            error.Raw, error.Located => {
                try self.errors.append(self.a, try self.locatedPending(&.{}, null));
                return .{ .data = null, .errors = self.errors.items };
            },
        };
        if (fields.names.items.len > 1) return self.executeRoots(root, &fields, parallel);
        var members: std.ArrayList(Member) = .empty;
        for (fields.names.items) |name| {
            const nodes = fields.entries.get(name).?.items;
            const path: Path = .{ .prev = null, .segment = .{ .key = name } };
            const v = self.executeField(root, .null, nodes, &path) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                error.Raw => unreachable,
                error.Located => {
                    try self.errors.append(self.a, self.pending);
                    return .{ .data = null, .errors = self.errors.items };
                },
            };
            if (v) |value| try members.append(self.a, .{ .key = name, .value = value });
        }
        return .{ .data = .{ .object = members.items }, .errors = self.errors.items };
    }

    const RootTask = struct {
        parent: *const Executor,
        root: *const NamedType,
        name: []const u8,
        nodes: []const *const ast.Field,
        arena: ?*std.heap.ArenaAllocator,
        allocator: Allocator,
        value: ?Value = null,
        propagated: bool = false,
        oom: bool = false,
        errors: []const GqlError = &.{},
        pending: GqlError = .{ .message = "" },
        /// The field reached the database/diagnostics service (settles after
        /// I/O, i.e. after every I/O-free root field in graphql-js).
        io: bool = false,
        /// Global completion order (settle order among I/O fields).
        stamp: u64 = 0,

        fn run(t: *RootTask) void {
            const io_before = io_events;
            defer {
                t.io = io_events != io_before;
                t.stamp = completion_seq.fetchAdd(1, .monotonic);
            }
            var sub: Executor = .{
                .a = t.allocator,
                .schema = t.parent.schema,
                .source = t.parent.source,
                .vars = t.parent.vars,
                .resolvers = t.parent.resolvers,
                .fragments = t.parent.fragments,
            };
            const path: Path = .{ .prev = null, .segment = .{ .key = t.name } };
            t.value = sub.executeField(t.root, .null, t.nodes, &path) catch |err| switch (err) {
                error.OutOfMemory => {
                    t.oom = true;
                    return;
                },
                error.Raw => unreachable,
                error.Located => {
                    t.propagated = true;
                    t.pending = sub.pending;
                    t.errors = sub.errors.items;
                    return;
                },
            };
            t.errors = sub.errors.items;
        }
    };

    /// Runs root fields concurrently (extra fields on their own threads when
    /// `parallel` is set), then merges results the way graphql-js collects
    /// them for a first execution: errors in settle order, where fields that
    /// fail without I/O settle first (document order) and I/O fields settle in
    /// completion order; the first non-null failure in settle order makes
    /// `data` null and ends collection (errors settling later are dropped).
    fn executeRoots(self: *Executor, root: *const NamedType, fields: *const FieldMap, parallel: ?Parallel) Allocator.Error!Result {
        const n = fields.names.items.len;
        const tasks = try self.a.alloc(RootTask, n);
        const arenas = try self.a.alloc(*std.heap.ArenaAllocator, n - 1);
        var created: usize = 0;
        var result: Result = .{ .data = null, .errors = &.{}, .arenas = arenas[0..0], .backing = if (parallel) |p| p.backing else null };
        errdefer {
            result.arenas = arenas[0..created];
            result.deinit();
        }
        for (fields.names.items, tasks, 0..) |name, *t, i| {
            var allocator = self.a;
            var arena: ?*std.heap.ArenaAllocator = null;
            if (i > 0) if (parallel) |p| {
                const fresh = try p.backing.create(std.heap.ArenaAllocator);
                fresh.* = std.heap.ArenaAllocator.init(p.backing);
                arenas[created] = fresh;
                created += 1;
                arena = fresh;
                allocator = fresh.allocator();
            };
            t.* = .{ .parent = self, .root = root, .name = name, .nodes = fields.entries.get(name).?.items, .arena = arena, .allocator = allocator };
        }
        result.arenas = arenas[0..created];
        const threads = try self.a.alloc(?std.Thread, n);
        @memset(threads, null);
        if (parallel) |p| for (tasks[1..], threads[1..]) |*t, *thread| {
            if (p.active.fetchAdd(1, .monotonic) >= p.max_threads) {
                _ = p.active.fetchSub(1, .monotonic);
                continue; // over the cap: runs on this thread below
            }
            thread.* = std.Thread.spawn(.{ .stack_size = 1024 * 1024 }, RootTask.run, .{t}) catch blk: {
                _ = p.active.fetchSub(1, .monotonic);
                break :blk null;
            };
        };
        RootTask.run(&tasks[0]);
        for (tasks[1..], threads[1..]) |*t, thread| if (thread == null) RootTask.run(t);
        if (parallel) |p| for (threads[1..]) |thread| if (thread) |th| {
            th.join();
            _ = p.active.fetchSub(1, .monotonic);
        };
        for (tasks) |*t| if (t.oom) return error.OutOfMemory;

        // Settle order: I/O-free fields in document order, then I/O fields by completion.
        const order = try self.a.alloc(*RootTask, n);
        var k: usize = 0;
        for (tasks) |*t| if (!t.io) {
            order[k] = t;
            k += 1;
        };
        const io_start = k;
        for (tasks) |*t| if (t.io) {
            order[k] = t;
            k += 1;
        };
        std.mem.sort(*RootTask, order[io_start..], {}, struct {
            fn lessThan(_: void, x: *RootTask, y: *RootTask) bool {
                return x.stamp < y.stamp;
            }
        }.lessThan);

        var failed: ?*RootTask = null;
        for (order) |t| if (t.propagated) {
            failed = t;
            break;
        };
        if (failed) |f| {
            // Every I/O-free field has settled before any I/O field; I/O fields
            // that settled before the failure are included in completion order.
            for (order) |t| {
                if (t.io and (!f.io or t.stamp > f.stamp)) continue;
                try self.errors.appendSlice(self.a, t.errors);
            }
            try self.errors.append(self.a, f.pending);
            result.errors = self.errors.items;
            return result;
        }
        for (order) |t| try self.errors.appendSlice(self.a, t.errors);
        var members: std.ArrayList(Member) = .empty;
        for (tasks) |*t| if (t.value) |v| try members.append(self.a, .{ .key = t.name, .value = v });
        result.data = .{ .object = members.items };
        result.errors = self.errors.items;
        return result;
    }

    // ---- errors ----

    fn raise(self: *Executor, message: []const u8, code: ?[]const u8, offsets: []const u32) Err {
        self.pending = .{ .message = message, .code = code };
        self.pending_offsets = offsets;
        return error.Raw;
    }

    fn raisef(self: *Executor, comptime fmt: []const u8, args: anytype) Err {
        return self.raise(try std.fmt.allocPrint(self.a, fmt, args), null, &.{});
    }

    /// `locatedError(raw, fieldNodes, path)`: the error's own nodes win.
    fn locatedPending(self: *Executor, nodes: []const *const ast.Field, path: ?*const Path) !GqlError {
        var err = self.pending;
        if (self.pending_offsets.len > 0) {
            err.locations = try locationsFromOffsets(self.a, self.source, self.pending_offsets);
        } else {
            const locs = try self.a.alloc(ast.SourceLocation, nodes.len);
            for (nodes, locs) |n, *l| l.* = ast.location(self.source, n.loc);
            err.locations = locs;
        }
        if (path != null) err.path = try Path.toArray(path, self.a);
        return err;
    }

    fn locate(self: *Executor, nodes: []const *const ast.Field, path: *const Path) !void {
        self.pending = try self.locatedPending(nodes, path);
        self.pending_offsets = &.{};
    }

    /// `handleFieldError`: propagate through non-null positions, else record.
    fn handleFieldError(self: *Executor, t: *const TypeRef) Err!Value {
        if (t.isNonNull()) return error.Located;
        try self.errors.append(self.a, self.pending);
        return .null;
    }

    // ---- fields ----

    /// Null result = graphql-js `undefined` (field omitted).
    fn executeField(self: *Executor, parent: *const NamedType, source: Value, nodes: []const *const ast.Field, path: *const Path) Err!?Value {
        const def = self.schema.fieldDef(parent, nodes[0].name.value) orelse return null;
        var hint: usize = 0;
        return self.executeFieldDef(parent, def, source, nodes, path, &hint);
    }

    fn executeFieldDef(self: *Executor, parent: *const NamedType, def: *const schema_mod.Field, source: Value, nodes: []const *const ast.Field, path: *const Path, hint: *usize) Err!?Value {
        const value = self.resolveAndComplete(parent, def, source, nodes, path, hint) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            error.Raw => {
                try self.locate(nodes, path);
                return try self.handleFieldError(def.type);
            },
            error.Located => return try self.handleFieldError(def.type),
        };
        return value;
    }

    fn resolveAndComplete(self: *Executor, parent: *const NamedType, def: *const schema_mod.Field, source: Value, nodes: []const *const ast.Field, path: *const Path, hint: *usize) Err!Value {
        const first = nodes[0];
        const info: Info = .{ .field_name = def.name, .parent_type = parent, .field_nodes = nodes, .fragments = &self.fragments };
        if (def.args.len == 0 and !self.hasCustomResolvers(parent)) {
            // Default resolver: `source[fieldName]` (no arguments to coerce).
            const resolved: ?Value = if (std.mem.eql(u8, def.name, "__typename")) .{ .string = parent.name } else lookup(source, def.name, hint);
            return self.completeValue(def.type, &info, path, resolved);
        }
        const args = switch (try values.getArgumentValues(self.a, def.args, first.arguments, first.loc, self.vars)) {
            .ok => |v| v,
            .err => |e| return self.raise(e.message, null, e.locations),
        };
        var resolved: ?Value = null;
        if (std.mem.eql(u8, def.name, "__typename")) {
            resolved = .{ .string = parent.name };
        } else switch (try self.resolvers.resolve(self.resolvers.ctx, self.a, &info, source, args)) {
            .default => resolved = if (source == .object) source.get(def.name) else null,
            .value => |v| resolved = v,
            .failure => |f| return self.raise(f.message, f.code, &.{}),
        }
        return self.completeValue(def.type, &info, path, resolved);
    }

    /// `completeValue`; `result` null = undefined.
    fn completeValue(self: *Executor, t: *const TypeRef, info: *const Info, path: *const Path, result: ?Value) Err!Value {
        switch (t.*) {
            .non_null => |inner| {
                const completed = try self.completeValue(inner, info, path, result);
                if (completed == .null) return self.raisef("Cannot return null for non-nullable field {s}.{s}.", .{ info.parent_type.name, info.field_name });
                return completed;
            },
            .list => |item_type| {
                const r = result orelse return .null;
                if (r == .null) return .null;
                if (r != .array) return self.raisef("Expected Iterable, but did not find one for field \"{s}.{s}\".", .{ info.parent_type.name, info.field_name });
                const out = try self.a.alloc(Value, r.array.len);
                for (r.array, out, 0..) |item, *slot, i| {
                    const item_path: Path = .{ .prev = path, .segment = .{ .index = i } };
                    slot.* = self.completeValue(item_type, info, &item_path, item) catch |err| switch (err) {
                        error.OutOfMemory => return error.OutOfMemory,
                        error.Raw => blk: {
                            try self.locate(info.field_nodes, &item_path);
                            break :blk try self.handleFieldError(item_type);
                        },
                        error.Located => try self.handleFieldError(item_type),
                    };
                }
                return .{ .array = out };
            },
            .named => |named| {
                const r = result orelse return .null;
                if (r == .null) return .null;
                if (named.isLeaf()) return self.completeLeaf(named, r);
                return self.completeObject(named, info, path, r);
            },
        }
    }

    fn completeObject(self: *Executor, named: *const NamedType, info: *const Info, path: *const Path, source: Value) Err!Value {
        const collected = try self.collectSubfields(named, info.field_nodes);
        const members = try self.a.alloc(Member, collected.names.len);
        var n: usize = 0;
        for (collected.names, collected.nodes, collected.defs, collected.hints) |name, nodes, def, *hint| {
            const field_path: Path = .{ .prev = path, .segment = .{ .key = name } };
            if (try self.executeFieldDef(named, def orelse continue, source, nodes, &field_path, hint)) |v| {
                members[n] = .{ .key = name, .value = v };
                n += 1;
            }
        }
        return .{ .object = members[0..n] };
    }

    fn collectSubfields(self: *Executor, named: *const NamedType, field_nodes: []const *const ast.Field) Err!*const Collected {
        const key: SubfieldKey = .{ .named = named, .nodes = field_nodes.ptr, .len = field_nodes.len };
        if (self.subfields.get(key)) |c| return c;
        var fields: FieldMap = .{};
        var visited: std.StringHashMapUnmanaged(void) = .empty;
        for (field_nodes) |node| {
            if (node.selection_set) |set| try self.collectFields(named, set, &fields, &visited);
        }
        const count = fields.names.items.len;
        const nodes = try self.a.alloc([]const *const ast.Field, count);
        const defs = try self.a.alloc(?*const schema_mod.Field, count);
        const hints = try self.a.alloc(usize, count);
        for (fields.names.items, nodes, defs, hints) |name, *slot, *def, *hint| {
            slot.* = fields.entries.get(name).?.items;
            def.* = self.schema.fieldDef(named, slot.*[0].name.value);
            hint.* = 0;
        }
        const c = try self.a.create(Collected);
        c.* = .{ .names = fields.names.items, .nodes = nodes, .defs = defs, .hints = hints };
        try self.subfields.put(self.a, key, c);
        return c;
    }

    fn completeLeaf(self: *Executor, named: *const NamedType, r: Value) Err!Value {
        const a = self.a;
        if (named.kind == .@"enum") {
            if (r == .string and named.hasEnumValue(r.string)) return r;
            return self.raisef("Enum \"{s}\" cannot represent value: {s}", .{ named.name, try js.inspect(a, r) });
        }
        switch (named.scalar) {
            .custom => return r, // scalars.ts serialize: pass-through
            .int => {
                const n = toNumber(r) orelse return self.raisef("Int cannot represent non-integer value: {s}", .{try js.inspect(a, r)});
                if (!std.math.isFinite(n) or @floor(n) != n) return self.raisef("Int cannot represent non-integer value: {s}", .{try js.inspect(a, r)});
                if (n > 2147483647 or n < -2147483648) return self.raisef("Int cannot represent non 32-bit signed integer value: {s}", .{try js.inspect(a, r)});
                return .{ .number = n };
            },
            .float => {
                const n = toNumber(r) orelse return self.raisef("Float cannot represent non numeric value: {s}", .{try js.inspect(a, r)});
                if (!std.math.isFinite(n)) return self.raisef("Float cannot represent non numeric value: {s}", .{try js.inspect(a, r)});
                return .{ .number = n };
            },
            .string => switch (r) {
                .string => return r,
                .bool => |b| return .{ .string = if (b) "true" else "false" },
                .number, .raw => {
                    const n = js.asNumber(r) orelse return self.raisef("String cannot represent value: {s}", .{try js.inspect(a, r)});
                    if (!std.math.isFinite(n)) return self.raisef("String cannot represent value: {s}", .{try js.inspect(a, r)});
                    return .{ .string = try js.numberString(a, n) };
                },
                else => return self.raisef("String cannot represent value: {s}", .{try js.inspect(a, r)}),
            },
            .boolean => switch (r) {
                .bool => return r,
                .number, .raw => {
                    const n = js.asNumber(r) orelse std.math.nan(f64);
                    if (!std.math.isFinite(n)) return self.raisef("Boolean cannot represent a non boolean value: {s}", .{try js.inspect(a, r)});
                    return .{ .bool = n != 0 };
                },
                else => return self.raisef("Boolean cannot represent a non boolean value: {s}", .{try js.inspect(a, r)}),
            },
            .id => {
                if (r == .string) return r;
                if (js.asNumber(r)) |n| if (std.math.isFinite(n) and @floor(n) == n) return .{ .string = try js.numberString(a, n) };
                return self.raisef("ID cannot represent value: {s}", .{try js.inspect(a, r)});
            },
        }
    }

    // ---- field collection ----

    const FieldMap = struct {
        names: std.ArrayList([]const u8) = .empty,
        entries: std.StringHashMapUnmanaged(std.ArrayList(*const ast.Field)) = .empty,
    };

    fn collectFields(self: *Executor, runtime: *const NamedType, set: *const ast.SelectionSet, fields: *FieldMap, visited: *std.StringHashMapUnmanaged(void)) Err!void {
        for (set.selections) |sel| switch (sel) {
            .field => |f| {
                if (!try self.shouldInclude(f.directives)) continue;
                const name = f.responseName();
                const gop = try fields.entries.getOrPut(self.a, name);
                if (!gop.found_existing) {
                    gop.value_ptr.* = .empty;
                    try fields.names.append(self.a, name);
                }
                try gop.value_ptr.append(self.a, f);
            },
            .inline_fragment => |f| {
                if (!try self.shouldInclude(f.directives)) continue;
                if (f.type_condition) |tc| if (self.schema.getType(tc.value) != runtime) continue;
                try self.collectFields(runtime, f.selection_set, fields, visited);
            },
            .fragment_spread => |fs| {
                const name = fs.name.value;
                if (visited.contains(name) or !try self.shouldInclude(fs.directives)) continue;
                try visited.put(self.a, name, {});
                const frag = self.fragments.get(name) orelse continue;
                if (self.schema.getType(frag.type_condition.value) != runtime) continue;
                try self.collectFields(runtime, frag.selection_set, fields, visited);
            },
        };
    }

    /// `shouldIncludeNode`: @skip(if: true) / @include(if: false) exclude.
    fn shouldInclude(self: *Executor, directives: []const ast.Directive) Err!bool {
        if (try self.directiveIf(directives, "skip")) |skip| if (skip) return false;
        if (try self.directiveIf(directives, "include")) |include| if (!include) return false;
        return true;
    }

    fn directiveIf(self: *Executor, directives: []const ast.Directive, name: []const u8) Err!?bool {
        for (directives) |d| {
            if (!std.mem.eql(u8, d.name.value, name)) continue;
            const def = self.schema.directive(name).?;
            const args = switch (try values.getArgumentValues(self.a, def.args, d.arguments, d.loc, self.vars)) {
                .ok => |v| v,
                .err => |e| return self.raise(e.message, null, e.locations),
            };
            const v = args.get("if") orelse return null;
            return v == .bool and v.bool;
        }
        return null;
    }
};

/// `source[name]` with a position hint (rows of one result share key order).
fn lookup(source: Value, name: []const u8, hint: *usize) ?Value {
    if (source != .object) return null;
    const members = source.object;
    if (hint.* < members.len and std.mem.eql(u8, members[hint.*].key, name)) return members[hint.*].value;
    for (members, 0..) |m, i| if (std.mem.eql(u8, m.key, name)) {
        hint.* = i;
        return m.value;
    };
    return null;
}

fn toNumber(r: Value) ?f64 {
    return switch (r) {
        .bool => |b| if (b) 1 else 0,
        .number => |n| n,
        .raw => |s| std.fmt.parseFloat(f64, s) catch null,
        .string => |s| if (s.len == 0) null else js.stringToNumber(s),
        else => null,
    };
}
