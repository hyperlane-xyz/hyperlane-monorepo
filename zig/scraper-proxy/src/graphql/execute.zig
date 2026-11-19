//! graphql-js `execute` for query operations: field collection with
//! @skip/@include, argument coercion, resolver calls, value completion with
//! non-null propagation, leaf serialization and located errors.
//!
//! Root fields run concurrently when enabled (extra fields on sibling fibers
//! when the request runs on a fiber, else on `RootPool` threads)
//! (graphql-js starts them all at once). Results and errors are merged in
//! document order; after a non-null root failure, later fields' data and
//! errors are dropped and `data` is null, like the rejected `Promise.all`
//! (see DEVIATIONS.md).
const std = @import("std");
const core = @import("core");
const json = core.json;
const ast = @import("ast.zig");
const schema_mod = @import("schema.zig");
const values = @import("values.zig");
const js = @import("js.zig");
const root_pool = @import("root_pool.zig");

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

/// Resolver failure: message + optional `extensions.code`. `sync`: the
/// resolver throws before returning a promise; on a root field graphql-js
/// records that error during executeFields, before any promise settles.
pub const ResolveFailure = struct {
    message: []const u8,
    code: ?[]const u8 = null,
    sync: bool = false,
    /// For a failure without I/O: the microtask tick, counted from the TS
    /// resolver's call, at which its promise rejects (graphql-js settles
    /// I/O-free root fields in that order; see `RootTask.settle`). 0: at
    /// once, as graphql-js's own errors (argument coercion) are.
    depth: u8 = 0,
};

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
    /// Optional: the same field resolved to a database result read in place
    /// (`RawResult`), asked only when the selection can be written straight
    /// from it (see `rawPlan`). `.none`: use `resolve`.
    resolve_raw: ?*const fn (ctx: *anyopaque, a: Allocator, info: *const Info, parent: Value, args: Value) Allocator.Error!RawResult = null,
    /// Optional: whether TS's resolver for this root field, given its coerced
    /// arguments, throws before returning a promise (graphql-js then starts no
    /// later root field when the field is non-null; see `executeRoots`).
    fails_synchronously: ?*const fn (ctx: *anyopaque, field_name: []const u8, args: Value) bool = null,
};

/// What a fast column's JSON is (the database adapter decides per column
/// type; `RawRows.write_text_fn` writes it byte-equal to today's path).
pub const FastKind = enum {
    /// A JSON number from an int2/int4 column: always a 32-bit integer, so an
    /// Int field takes it without a range check.
    number_text,
    /// A JSON string (int8, numeric, text-like).
    string_text,
    /// `true`/`false` (bool).
    bool_tf,
};

pub const RawColumn = struct {
    name: []const u8,
    /// Null: not a fast column type (the rows must be materialized).
    kind: ?FastKind,
    /// Values can be JSON documents of any depth (json/jsonb): custom-scalar
    /// fields over the column take the Value path, where `writeCustom`
    /// flags deep values for the route's depth check.
    nested: bool = false,
};

/// A database result read in place (IMPLEMENTATION.md "rows straight to
/// JSON"). Owned by the executor once returned: `deinit` exactly once.
pub const RawRows = struct {
    ctx: *anyopaque,
    n_rows: usize,
    columns: []const RawColumn,
    /// Cell text (null: SQL NULL), valid until `deinit`.
    cell_fn: *const fn (ctx: *anyopaque, row: usize, col: usize) ?[]const u8,
    /// Today's row values (`[]Value` objects), allocated in `a`.
    materialize_fn: *const fn (ctx: *anyopaque, a: Allocator) Allocator.Error![]Value,
    /// Writes a non-NULL cell's `text` (from `cell_fn`) of column `col` as
    /// today's JSON for its value.
    write_text_fn: *const fn (ctx: *anyopaque, w: *std.Io.Writer, a: Allocator, col: usize, text: []const u8) (std.Io.Writer.Error || Allocator.Error)!void,
    deinit_fn: *const fn (ctx: *anyopaque) void,

    fn cell(self: RawRows, row: usize, col: usize) ?[]const u8 {
        return self.cell_fn(self.ctx, row, col);
    }
};

pub const RawResult = union(enum) {
    /// Not available for this field: use `Resolvers.resolve`.
    none,
    /// A list field's rows.
    rows: RawRows,
    /// A single-object field (`*_by_pk`): its first row, or null when none.
    row: RawRows,
    failure: ResolveFailure,
};

pub const Result = struct {
    /// Null when a non-null root field failed (or field collection threw);
    /// otherwise `.raw` (the serialized `data` object, written while completing).
    data: ?Value,
    errors: []const GqlError,
    /// Per-field arenas of concurrently executed root fields; `data` and
    /// `errors` point into them until `deinit`.
    arenas: []const *std.heap.ArenaAllocator = &.{},
    backing: ?Allocator = null,
    /// When `data` is set: the response body so far (`{"data":` + data), so
    /// the route finishes it in place instead of copying `data`.
    body: ?std.Io.Writer.Allocating = null,
    /// A custom-scalar value nested at least `deep_scalar_depth` levels was
    /// written: the route checks the response's depth (`values.response_depth_limit`).
    deep_scalar: bool = false,

    pub fn deinit(self: Result) void {
        const backing = self.backing orelse return;
        for (self.arenas) |arena| {
            arena.deinit();
            backing.destroy(arena);
        }
    }
};

/// Bumped by data-source adapters whenever a resolver performs I/O (database
/// query or diagnostics read) on the current thread or fiber (a fiber-local,
/// registered by route.zig); root fields use it to tell graphql-js
/// microtask-settled failures from I/O-settled ones.
pub threadlocal var io_events: u32 = 0;

/// The request's execution-admission hook (`graphql.ts` counts a request
/// toward GRAPHQL_MAX_ACTIVE_REQUESTS only while it is yielded, see route.zig).
/// `enter` runs before the request's I/O; false = over capacity, do no I/O.
pub const Admission = struct {
    ctx: *anyopaque,
    enter: *const fn (ctx: *anyopaque) bool,
    /// Optional: true once the request lost its execution slot (every later
    /// `enter` is false), without taking one.
    rejected: ?*const fn (ctx: *anyopaque) bool = null,
};

/// Set by the route on the request's fiber (thread off fibers) and by
/// `RootTask.run` for each root field (sibling fibers inherit it; pool
/// threads set it) while a request executes. A fiber-local (route.zig).
pub threadlocal var admission: ?Admission = null;

/// Called by data-source adapters right before a resolver performs I/O
/// (database query, diagnostics read). Returns false when the request lost
/// its execution slot; the adapter must then fail without I/O.
pub fn beforeIo() bool {
    const adm = admission orelse return true;
    return adm.enter(adm.ctx);
}

/// True when the request already lost its execution slot (`beforeIo` would
/// refuse): adapters skip work TS's preHandler 503 never reached.
pub fn admissionRejected() bool {
    const adm = admission orelse return false;
    const f = adm.rejected orelse return false;
    return f(adm.ctx);
}

/// Counterpart of `beforeIo` once the I/O happened (settle-order bookkeeping).
pub fn afterIo() void {
    io_events +%= 1;
}

var completion_seq: std.atomic.Value(u64) = .init(0);

/// Root-field fan-out: on a fiber, extra root fields run as sibling fibers;
/// off fibers they go to a FIFO `RootPool` (std.Thread.Pool is LIFO and
/// starves old tasks under load). Plus a thread-safe allocator for the
/// per-field arenas. Null (`root_field_threads = 0`): fields run one after
/// another; under fibers that option is only an on/off switch.
pub const Parallel = struct {
    pool: *root_pool.RootPool,
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
    /// Propagated to each root field's fiber or pool thread (`admission`).
    admission: ?Admission = null,
    /// Completed values are serialized here as they are produced (no result
    /// tree); an error nulls the nearest nullable position by rewinding to
    /// where that position's value started.
    out: std.Io.Writer.Allocating = undefined,
    /// See `Result.deep_scalar`.
    deep_scalar: bool = false,
    /// A root field's resolver failed synchronously (`ResolveFailure.sync`).
    sync_failure: bool = false,
    /// `ResolveFailure.depth` of the root field's own failure, and the
    /// latest tick at which a nested field's failure reached a nullable
    /// parent (see `RootTask.settle`).
    root_depth: u8 = 0,
    nested_settle: u8 = 0,

    const Err = error{ OutOfMemory, Raw, Located };

    /// Custom-scalar values at least this deep flag the response for the
    /// route's depth check (no GraphQL selection in this schema nests deep
    /// enough to make up the rest of `values.response_depth_limit`).
    const deep_scalar_depth = 4096;

    /// A custom scalar's value (`scalars.ts` serialize: pass-through). The
    /// depth comes from the serialization itself (`json.deepest_written`,
    /// only set past its recursion limit): no extra walk of the value.
    fn writeCustom(self: *Executor, r: Value) Allocator.Error!void {
        json.deepest_written = 0;
        json.stringify(&self.out.writer, r) catch return error.OutOfMemory;
        if (json.deepest_written >= deep_scalar_depth) self.deep_scalar = true;
    }

    const SubfieldKey = struct { named: *const NamedType, nodes: [*]const *const ast.Field, len: usize };
    const Collected = struct {
        names: []const []const u8,
        /// `"name":` (JSON-escaped response name plus colon) per field.
        keys: []const []const u8,
        nodes: []const []const *const ast.Field,
        defs: []const ?*const schema_mod.Field,
        /// Row member index where each field was last found (rows share column order).
        hints: []Hint,
        /// Default resolver without arguments (`source[name]`): no coercion or call.
        plain: []const bool,
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
        self.out = try .initCapacity(self.a, 1024);
        const w = &self.out.writer;
        w.writeAll(body_prefix ++ "{") catch return error.OutOfMemory;
        for (fields.names.items) |name| {
            const nodes = fields.entries.get(name).?.items;
            const path: Path = .{ .prev = null, .segment = .{ .key = name } };
            const def = self.schema.fieldDef(root, nodes[0].name.value) orelse continue;
            try self.writeKey(name);
            var hint: Hint = .{};
            self.writeFieldDef(root, def, .null, nodes, &path, &hint) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                error.Raw => unreachable,
                error.Located => {
                    try self.errors.append(self.a, self.pending);
                    return .{ .data = null, .errors = self.errors.items };
                },
            };
        }
        w.writeByte('}') catch return error.OutOfMemory;
        return .{ .data = .{ .raw = self.out.written()[body_prefix.len..] }, .errors = self.errors.items, .body = self.out, .deep_scalar = self.deep_scalar };
    }

    /// Start of every 2xx response body (mercurius field order `data, errors`).
    pub const body_prefix = "{\"data\":";

    fn writeKey(self: *Executor, name: []const u8) Allocator.Error!void {
        const w = &self.out.writer;
        if (w.end > 0 and w.buffer[w.end - 1] != '{') w.writeByte(',') catch return error.OutOfMemory;
        json.writeString(w, name) catch return error.OutOfMemory;
        w.writeByte(':') catch return error.OutOfMemory;
    }

    const RootTask = struct {
        parent: *const Executor,
        root: *const NamedType,
        name: []const u8,
        nodes: []const *const ast.Field,
        arena: ?*std.heap.ArenaAllocator,
        allocator: Allocator,
        /// Serialized value; null = undefined (no such field).
        value: ?[]const u8 = null,
        propagated: bool = false,
        oom: bool = false,
        deep_scalar: bool = false,
        errors: []const GqlError = &.{},
        pending: GqlError = .{ .message = "" },
        /// The field reached the database/diagnostics service (settles after
        /// I/O, i.e. after every I/O-free root field in graphql-js).
        io: bool = false,
        /// Its resolver threw synchronously: the error is recorded before
        /// any other root field's settles.
        sync: bool = false,
        /// Global completion order (settle order among I/O fields).
        stamp: u64 = 0,
        /// I/O-free fields: the tick at which graphql-js records the
        /// field's errors (TS, measured on Node 26.12.1). A nullable root
        /// field's error is recorded when its resolver's promise rejects
        /// (`ResolveFailure.depth`); a non-null one's 3 ticks later, when
        /// the operation's `Promise.all` rejection reaches executeOperation,
        /// which ends collection: errors recorded later are dropped. Ties
        /// settle in document order.
        settle: u8 = 0,
        job: root_pool.Job = .{ .run = runJob },

        fn runJob(job: *root_pool.Job) void {
            run(@fieldParentPtr("job", job));
        }

        /// A sibling fiber's entry (`core.fiber.spawn`): runs, then wakes
        /// the request's fiber parked on `job.done`.
        fn runFiber(arg: *anyopaque) void {
            const t: *RootTask = @ptrCast(@alignCast(arg));
            run(t);
            t.job.done.wake();
        }

        fn run(t: *RootTask) void {
            const saved_admission = admission;
            admission = t.parent.admission;
            defer admission = saved_admission;
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
                .admission = t.parent.admission,
            };
            const path: Path = .{ .prev = null, .segment = .{ .key = t.name } };
            const def = t.parent.schema.fieldDef(t.root, t.nodes[0].name.value) orelse return;
            sub.out = std.Io.Writer.Allocating.initCapacity(t.allocator, 1024) catch {
                t.oom = true;
                return;
            };
            var hint: Hint = .{};
            sub.writeFieldDef(t.root, def, .null, t.nodes, &path, &hint) catch |err| switch (err) {
                error.OutOfMemory => {
                    t.oom = true;
                    return;
                },
                error.Raw => unreachable,
                error.Located => {
                    t.propagated = true;
                    t.pending = sub.pending;
                    t.errors = sub.errors.items;
                    t.sync = sub.sync_failure;
                    t.settle = @max(sub.root_depth, sub.nested_settle) +| 3;
                    return;
                },
            };
            t.value = sub.out.written();
            t.errors = sub.errors.items;
            t.sync = sub.sync_failure;
            t.settle = @max(sub.root_depth, sub.nested_settle);
            t.deep_scalar = sub.deep_scalar;
        }
    };

    /// Runs root fields concurrently when `parallel` is set (extra fields on
    /// sibling fibers, or pool threads off fibers), then merges results the way graphql-js collects
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
        // graphql-js executeFields: a non-null root field whose resolver throws
        // synchronously ends the loop, so later root fields never start (the
        // ones before it keep running) and the response has that error alone.
        var sync_stop: ?usize = null;
        for (tasks, 0..) |*t, i| {
            const first = t.nodes[0];
            const def = self.schema.fieldDef(root, first.name.value) orelse continue;
            if (!def.type.isNonNull()) continue;
            // executeField throws an argument error inside executeFields, as
            // a resolver's synchronous throw (the field's own run reports it).
            const args = switch (try values.getArgumentValues(self.a, def.args, first.arguments, first.loc, self.vars)) {
                .ok => |v| v,
                .err => {
                    sync_stop = i;
                    break;
                },
            };
            const fails = self.resolvers.fails_synchronously orelse continue;
            if (fails(self.resolvers.ctx, first.name.value, args)) {
                sync_stop = i;
                break;
            }
        }
        const started = tasks[0..if (sync_stop) |i| i + 1 else n];
        const pooled = try self.a.alloc(bool, n);
        @memset(pooled, false);
        // On a fiber the extra fields are sibling fibers on the same loop
        // (they interleave at I/O like graphql-js's promises; no threads),
        // started eagerly: once the first field parks (or finishes), each
        // runs to its first park in document order before this loop resumes
        // any other fiber, as graphql-js calls every root resolver in one
        // turn (so the request's pending-query checks run back to back;
        // requests on other loops can still check in between). Otherwise
        // they go to the RootPool.
        const on_fiber = parallel != null and core.fiber.inFiber();
        if (parallel) |p| for (started[1..], pooled[1..started.len]) |*t, *in_pool| {
            if (on_fiber) {
                // No fiber for it (out of memory): run it right away on this
                // fiber rather than after the joins of the fields before it
                // (`runFiber` wakes its `job.done`, so the join returns at
                // once). It then starts before the fields ahead of it, root 0
                // included: document order holds only while fibers can be made.
                core.fiber.spawnEager(RootTask.runFiber, t) catch RootTask.runFiber(t);
                in_pool.* = true;
            } else in_pool.* = p.pool.submit(&t.job); // false (pool full): runs here below
        };
        RootTask.run(&tasks[0]);
        for (started[1..], pooled[1..started.len]) |*t, in_pool| {
            if (!in_pool) {
                RootTask.run(t);
            } else if (on_fiber) {
                t.job.done.wait(); // parks until the sibling fiber finishes
            } else if (parallel.?.pool.reclaim(&t.job)) {
                RootTask.run(t); // no thread started it yet
            } else {
                core.blocking.begin();
                defer core.blocking.end();
                t.job.done.wait();
            }
        }
        for (started) |*t| if (t.oom) return error.OutOfMemory;
        if (sync_stop) |i| if (tasks[i].propagated) {
            // `promiseForObject(results).finally(() => { throw error; })`:
            // the fields before it settle first (their errors as below,
            // up to a non-null failure, whose own error is replaced).
            const order = try self.settleOrder(tasks[0..i]);
            const failed = firstFailure(order);
            try self.appendSettled(order, failed, true);
            try self.errors.append(self.a, tasks[i].pending);
            result.errors = self.errors.items;
            return result;
        };

        const order = try self.settleOrder(started);
        if (firstFailure(order)) |f| {
            try self.appendSettled(order, f, false);
            try self.errors.append(self.a, f.pending);
            result.errors = self.errors.items;
            return result;
        }
        try self.appendSettled(order, null, false);
        var size: usize = 2;
        for (started) |*t| if (t.value) |v| {
            size += t.name.len + v.len + 8;
        };
        self.out = try .initCapacity(self.a, size + body_prefix.len);
        const w = &self.out.writer;
        w.writeAll(body_prefix ++ "{") catch return error.OutOfMemory;
        for (started) |*t| if (t.value) |v| {
            try self.writeKey(t.name);
            w.writeAll(v) catch return error.OutOfMemory;
        };
        w.writeByte('}') catch return error.OutOfMemory;
        result.data = .{ .raw = self.out.written()[body_prefix.len..] };
        result.errors = self.errors.items;
        result.body = self.out;
        for (started) |*t| result.deep_scalar = result.deep_scalar or t.deep_scalar;
        return result;
    }

    /// graphql-js settle order of root fields: synchronous throws (recorded
    /// during executeFields, document order), then the other I/O-free
    /// fields by settle tick (`RootTask.settle`; document order on ties),
    /// then I/O fields by completion.
    fn settleOrder(self: *Executor, tasks: []RootTask) Allocator.Error![]*RootTask {
        const order = try self.a.alloc(*RootTask, tasks.len);
        var k: usize = 0;
        for ([_]bool{ true, false }) |sync| for (tasks) |*t| if (!t.io and t.sync == sync) {
            order[k] = t;
            k += 1;
        };
        // The other I/O-free fields by settle tick (stable: document order).
        const sync_end = blk: {
            var n: usize = 0;
            for (tasks) |*t| if (!t.io and t.sync) {
                n += 1;
            };
            break :blk n;
        };
        std.mem.sort(*RootTask, order[sync_end..k], {}, struct {
            fn lessThan(_: void, x: *RootTask, y: *RootTask) bool {
                return x.settle < y.settle;
            }
        }.lessThan);
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
        return order;
    }

    /// The first non-null failure in settle order.
    fn firstFailure(order: []const *RootTask) ?*RootTask {
        for (order) |t| if (t.propagated) return t;
        return null;
    }

    /// The fields' errors in settle order; with a non-null failure, only
    /// those settled before it (every I/O-free field settles before any I/O
    /// field; I/O fields by completion), excluding its own pending error.
    /// `late`: collection ends a tick after the failure (graphql-js's
    /// `.finally` after `promiseForObject`'s `.then`, on a synchronous
    /// non-null failure), so I/O-free fields recorded at the failure's own
    /// tick still count.
    fn appendSettled(self: *Executor, order: []const *RootTask, failed: ?*RootTask, late: bool) Allocator.Error!void {
        const failed_at = if (failed) |f| std.mem.indexOfScalar(*RootTask, order, f) else null;
        for (order, 0..) |t, i| {
            if (failed) |f| {
                if (t.io and (!f.io or t.stamp > f.stamp)) continue;
                // I/O-free fields recorded after collection ended (sync
                // throws are recorded first).
                if (!t.io and !t.sync and !f.io) {
                    const after = if (late) t.settle > f.settle else i > failed_at.?;
                    if (after) continue;
                }
            }
            try self.errors.appendSlice(self.a, t.errors);
        }
    }

    // ---- errors ----

    fn raise(self: *Executor, message: []const u8, code: ?[]const u8, offsets: []const u32) Err {
        self.pending = .{ .message = message, .code = code };
        self.pending_offsets = offsets;
        return error.Raw;
    }

    fn raiseFailure(self: *Executor, f: ResolveFailure, path: *const Path) Err {
        if (f.sync and path.prev == null) self.sync_failure = true;
        // A nested resolver (an aggregate's `count`) is called once its
        // parent's promise resolved (1 tick for an I/O-free parent); its
        // rejection then takes 3 more to reach a nullable parent, as a root
        // field's does to reach the response.
        if (path.prev == null) self.root_depth = f.depth else self.nested_settle = @max(self.nested_settle, f.depth + 4);
        return self.raise(f.message, f.code, &.{});
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

    /// `handleFieldError`: propagate through non-null positions, else record
    /// the error and write `null` where the value started at `mark`.
    fn handleFieldError(self: *Executor, t: *const TypeRef, mark: usize) Err!void {
        if (t.isNonNull()) return error.Located;
        try self.errors.append(self.a, self.pending);
        self.out.writer.end = mark;
        try self.writeRaw("null");
    }

    fn writeRaw(self: *Executor, bytes: []const u8) Allocator.Error!void {
        json.writeShort(&self.out.writer, bytes) catch return error.OutOfMemory;
    }

    // ---- fields ----

    /// Writes the field's completed value; a field error writes `null` (or
    /// propagates through a non-null type).
    fn writeFieldDef(self: *Executor, parent: *const NamedType, def: *const schema_mod.Field, source: Value, nodes: []const *const ast.Field, path: *const Path, hint: *Hint) Err!void {
        const mark = self.out.writer.end;
        self.resolveAndWrite(parent, def, source, nodes, path, hint) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            error.Raw => {
                try self.locate(nodes, path);
                return self.handleFieldError(def.type, mark);
            },
            error.Located => return self.handleFieldError(def.type, mark),
        };
    }

    /// Field at `path` with the default resolver and no arguments (see
    /// `Collected.plain`). Scalars that serialize without error are written
    /// directly; everything else (objects, lists, enums, failures) takes the
    /// general path.
    fn writePlainField(self: *Executor, parent: *const NamedType, def: *const schema_mod.Field, source: Value, nodes: []const *const ast.Field, path: *const Path, hint: *Hint) Err!void {
        const resolved = lookup(source, def.name, hint);
        const non_null = def.type.* == .non_null;
        const t = if (non_null) def.type.non_null else def.type;
        if (t.* == .named and t.named.kind == .scalar) {
            const r = resolved orelse Value.null;
            if (r == .null) {
                if (!non_null) return self.writeRaw("null");
            } else if (try self.writeScalarFast(t.named.scalar, r)) return;
        }
        return self.writeFieldDef(parent, def, source, nodes, path, hint);
    }

    /// Writes a non-null scalar value when its serialization cannot fail and
    /// equals the value itself (graphql-js `serialize` identity cases).
    fn writeScalarFast(self: *Executor, scalar: schema_mod.ScalarKind, r: Value) Allocator.Error!bool {
        const w = &self.out.writer;
        switch (scalar) {
            .custom => try self.writeCustom(r),
            .string, .id => {
                if (r != .string) return false;
                json.writeString(w, r.string) catch return error.OutOfMemory;
            },
            .int => {
                if (r != .number) return false;
                const n = r.number;
                if (!std.math.isFinite(n) or @floor(n) != n or n > 2147483647 or n < -2147483648) return false;
                json.writeNumber(w, n) catch return error.OutOfMemory;
            },
            .float => {
                if (r != .number or !std.math.isFinite(r.number)) return false;
                json.writeNumber(w, r.number) catch return error.OutOfMemory;
            },
            .boolean => {
                if (r != .bool) return false;
                json.writeShort(w, if (r.bool) "true" else "false") catch return error.OutOfMemory;
            },
        }
        return true;
    }

    fn resolveAndWrite(self: *Executor, parent: *const NamedType, def: *const schema_mod.Field, source: Value, nodes: []const *const ast.Field, path: *const Path, hint: *Hint) Err!void {
        const first = nodes[0];
        const info: Info = .{ .field_name = def.name, .parent_type = parent, .field_nodes = nodes, .fragments = &self.fragments };
        if (def.args.len == 0 and !self.hasCustomResolvers(parent)) {
            // Default resolver: `source[fieldName]` (no arguments to coerce).
            const resolved: ?Value = if (std.mem.eql(u8, def.name, "__typename")) .{ .string = parent.name } else lookup(source, def.name, hint);
            _ = try self.writeValue(def.type, &info, path, resolved);
            return;
        }
        const args = switch (try values.getArgumentValues(self.a, def.args, first.arguments, first.loc, self.vars)) {
            .ok => |v| v,
            .err => |e| {
                // Recorded during executeFields, as a synchronous throw.
                if (path.prev == null) self.sync_failure = true;
                return self.raise(e.message, null, e.locations);
            },
        };
        if (self.resolvers.resolve_raw) |resolve_raw| if (try self.rawPlan(def, nodes)) |plan| {
            switch (try resolve_raw(self.resolvers.ctx, self.a, &info, source, args)) {
                .none => {},
                .failure => |f| return self.raiseFailure(f, path),
                inline .rows, .row => |raw, tag| {
                    defer raw.deinit_fn(raw.ctx);
                    if (try self.writeRawRows(plan, raw, tag == .row)) return;
                    // Not writable in place: today's values from the same result.
                    const rows = try raw.materialize_fn(raw.ctx, self.a);
                    const value: Value = if (tag == .rows) .{ .array = rows } else if (rows.len > 0) rows[0] else .null;
                    _ = try self.writeValue(def.type, &info, path, value);
                    return;
                },
            }
        };
        var resolved: ?Value = null;
        if (std.mem.eql(u8, def.name, "__typename")) {
            resolved = .{ .string = parent.name };
        } else switch (try self.resolvers.resolve(self.resolvers.ctx, self.a, &info, source, args)) {
            .default => resolved = if (source == .object) source.get(def.name) else null,
            .value => |v| resolved = v,
            .failure => |f| return self.raiseFailure(f, path),
        }
        _ = try self.writeValue(def.type, &info, path, resolved);
    }

    /// The selection a field can write straight from a database result: a
    /// list of objects, or one object, whose collected fields are all plain
    /// leaves (default resolver, no arguments) of a scalar whose output is
    /// the column value itself (String, ID, Int, Boolean, or the
    /// pass-through bigint/numeric scalars). Null: today's path.
    const RawPlan = struct {
        collected: *const Collected,
        /// Field types (for nullability and the Int range check).
        scalars: []const RawScalar,
        list_non_null: bool,
        object_non_null: bool,
    };
    const RawScalar = struct { kind: schema_mod.ScalarKind, non_null: bool };

    fn rawPlan(self: *Executor, def: *const schema_mod.Field, nodes: []const *const ast.Field) Err!?RawPlan {
        var t = def.type;
        var list_non_null = false;
        var object_non_null = false;
        if (t.* == .non_null) {
            list_non_null = true;
            t = t.non_null;
        }
        if (t.* == .list) {
            t = t.list;
            if (t.* == .non_null) {
                object_non_null = true;
                t = t.non_null;
            }
        } else {
            object_non_null = list_non_null;
            list_non_null = false;
        }
        if (t.* != .named or t.named.kind != .object) return null;
        const named = t.named;
        const collected = try self.collectSubfields(named, nodes);
        const scalars = try self.a.alloc(RawScalar, collected.names.len);
        for (collected.defs, collected.plain, scalars) |maybe_def, plain, *slot| {
            const d = maybe_def orelse return null;
            if (!plain) return null;
            var ft = d.type;
            const non_null = ft.* == .non_null;
            if (non_null) ft = ft.non_null;
            if (ft.* != .named or ft.named.kind != .scalar) return null;
            const leaf = ft.named;
            switch (leaf.scalar) {
                // Custom scalars are all pass-through (scalars.ts `serialize(v) = v`).
                .string, .id, .int, .boolean, .custom => {},
                .float => return null,
            }
            slot.* = .{ .kind = leaf.scalar, .non_null = non_null };
        }
        const is_list = def.type.* == .list or (def.type.* == .non_null and def.type.non_null.* == .list);
        return .{ .collected = collected, .scalars = scalars, .list_non_null = if (is_list) list_non_null else false, .object_non_null = object_non_null };
    }

    /// Writes the field from `raw` when every selected field's column writes
    /// today's output (an identity pair, or any column under a pass-through
    /// custom scalar) and no cell needs today's error or coercion path; on a
    /// miss the partial output is dropped and false returned: materialize.
    fn writeRawRows(self: *Executor, plan: RawPlan, raw: RawRows, single: bool) Err!bool {
        const fields = plan.collected.names.len;
        // No fields (all skipped): rows are `{}`, which the lead-ins below
        // cannot express; today's path writes them.
        if (fields == 0) return false;
        const cols = try self.a.alloc(usize, fields);
        // The column the row object holds for each field (the default
        // resolver's `source[def.name]`): like convertRows, a duplicated name
        // keeps its last column's value. Wide results: a name index.
        var by_name: std.StringHashMapUnmanaged(usize) = .empty;
        if (raw.columns.len > 8) {
            try by_name.ensureTotalCapacity(self.a, @intCast(raw.columns.len));
            for (raw.columns, 0..) |c, i| by_name.putAssumeCapacity(c.name, i);
        }
        for (plan.collected.defs, plan.scalars, cols) |maybe_def, scalar, *col| {
            const column_name = (maybe_def orelse return false).name;
            var found: ?usize = null;
            if (raw.columns.len > 8) {
                found = by_name.get(column_name);
            } else for (raw.columns, 0..) |c, i| if (std.mem.eql(u8, c.name, column_name)) {
                found = i;
            };
            const i = found orelse return false;
            const k = raw.columns[i].kind;
            const identity = switch (scalar.kind) {
                .string, .id => k == .string_text,
                .int => k == .number_text,
                .boolean => k == .bool_tf,
                // Pass-through: today's output is the converted cell as JSON,
                // which `write_text_fn` writes for any column type.
                .custom => !raw.columns[i].nested,
                .float => false,
            };
            if (!identity) return false;
            col.* = i;
        }
        const rows = if (single) @min(raw.n_rows, 1) else raw.n_rows;
        if (single and rows == 0 and plan.object_non_null) return false;
        const w = &self.out.writer;
        if (single and rows == 0) {
            try self.writeRaw("null");
            return true;
        }
        // Each field's lead-in, `{"key":` or `,"key":`, written once per row.
        const leads = try self.a.alloc([]const u8, fields);
        for (leads, plan.collected.keys, 0..) |*lead, key, i| lead.* = try std.mem.concat(self.a, u8, &.{ if (i == 0) "{" else ",", key });
        const mark = w.end;
        if (!single) try self.writeRaw("[");
        for (0..rows) |r| {
            if (r > 0) try self.writeRaw(",");
            for (leads, plan.scalars, cols) |lead, scalar, c| {
                try self.writeRaw(lead);
                // A NULL (or a converted json `null`) in a non-null field:
                // today's error path. (Int fields read int2/int4 columns
                // only, so no cell needs Int's range coercion.)
                const text = raw.cell(r, c) orelse {
                    if (scalar.non_null) return self.dropRaw(mark);
                    try self.writeRaw("null");
                    continue;
                };
                if (scalar.non_null and raw.columns[c].kind == null and std.mem.eql(u8, text, "null")) return self.dropRaw(mark);
                raw.write_text_fn(raw.ctx, w, self.a, c, text) catch return error.OutOfMemory;
            }
            try self.writeRaw("}");
        }
        if (!single) try self.writeRaw("]");
        return true;
    }

    /// `writeRawRows` miss: drop what it wrote.
    fn dropRaw(self: *Executor, mark: usize) bool {
        self.out.writer.end = mark;
        return false;
    }

    /// `completeValue`, serialized; `result` null = undefined. Returns
    /// whether it wrote `null`.
    fn writeValue(self: *Executor, t: *const TypeRef, info: *const Info, path: *const Path, result: ?Value) Err!bool {
        switch (t.*) {
            .non_null => |inner| {
                if (try self.writeValue(inner, info, path, result)) return self.raisef("Cannot return null for non-nullable field {s}.{s}.", .{ info.parent_type.name, info.field_name });
                return false;
            },
            .list => |item_type| {
                const r = result orelse return self.writeNull();
                if (r == .null) return self.writeNull();
                if (r != .array) return self.raisef("Expected Iterable, but did not find one for field \"{s}.{s}\".", .{ info.parent_type.name, info.field_name });
                try self.writeRaw("[");
                for (r.array, 0..) |item, i| {
                    if (i > 0) try self.writeRaw(",");
                    const item_path: Path = .{ .prev = path, .segment = .{ .index = i } };
                    const mark = self.out.writer.end;
                    _ = self.writeValue(item_type, info, &item_path, item) catch |err| switch (err) {
                        error.OutOfMemory => return error.OutOfMemory,
                        error.Raw => {
                            try self.locate(info.field_nodes, &item_path);
                            try self.handleFieldError(item_type, mark);
                        },
                        error.Located => try self.handleFieldError(item_type, mark),
                    };
                }
                try self.writeRaw("]");
                return false;
            },
            .named => |named| {
                const r = result orelse return self.writeNull();
                if (r == .null) return self.writeNull();
                if (named.isLeaf()) {
                    const leaf = try self.completeLeaf(named, r);
                    if (named.kind == .scalar and named.scalar == .custom) {
                        try self.writeCustom(leaf);
                    } else json.stringify(&self.out.writer, leaf) catch return error.OutOfMemory;
                    return leaf == .null;
                }
                try self.writeObject(named, info, path, r);
                return false;
            },
        }
    }

    fn writeNull(self: *Executor) Err!bool {
        try self.writeRaw("null");
        return true;
    }

    fn writeObject(self: *Executor, named: *const NamedType, info: *const Info, path: *const Path, source: Value) Err!void {
        const collected = try self.collectSubfields(named, info.field_nodes);
        try self.writeRaw("{");
        var first = true;
        for (collected.names, collected.keys, collected.nodes, collected.defs, collected.hints, collected.plain) |name, key, nodes, def, *hint, plain| {
            const d = def orelse continue;
            if (!first) try self.writeRaw(",");
            first = false;
            try self.writeRaw(key);
            const field_path: Path = .{ .prev = path, .segment = .{ .key = name } };
            if (plain) {
                try self.writePlainField(named, d, source, nodes, &field_path, hint);
            } else {
                try self.writeFieldDef(named, d, source, nodes, &field_path, hint);
            }
        }
        try self.writeRaw("}");
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
        const keys = try self.a.alloc([]const u8, count);
        const nodes = try self.a.alloc([]const *const ast.Field, count);
        const defs = try self.a.alloc(?*const schema_mod.Field, count);
        const hints = try self.a.alloc(Hint, count);
        const plain = try self.a.alloc(bool, count);
        const custom = self.hasCustomResolvers(named);
        for (fields.names.items, keys, nodes, defs, hints, plain) |name, *key_text, *slot, *def, *hint, *is_plain| {
            var text: std.Io.Writer.Allocating = try .initCapacity(self.a, name.len + 3);
            json.writeString(&text.writer, name) catch return error.OutOfMemory;
            text.writer.writeByte(':') catch return error.OutOfMemory;
            key_text.* = text.written();
            slot.* = fields.entries.get(name).?.items;
            def.* = self.schema.fieldDef(named, slot.*[0].name.value);
            hint.* = .{};
            is_plain.* = if (def.*) |d| d.args.len == 0 and !custom and !std.mem.eql(u8, d.name, "__typename") else false;
        }
        const c = try self.a.create(Collected);
        c.* = .{ .names = fields.names.items, .keys = keys, .nodes = nodes, .defs = defs, .hints = hints, .plain = plain };
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
        try fields.entries.ensureUnusedCapacity(self.a, @intCast(set.selections.len));
        try fields.names.ensureUnusedCapacity(self.a, set.selections.len);
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

/// Where a field was last found in its rows. Rows of one database result
/// share key order and the key slices themselves (`pq.convertRows`
/// allocates each column name once), so a later row whose key at `index` is
/// the very slice that matched before needs no string comparison.
const Hint = struct {
    index: usize = 0,
    /// The matching key's bytes (same pointer and length = same text).
    key: ?[*]const u8 = null,
};

/// `source[name]` with a position hint (rows of one result share key order).
fn lookup(source: Value, name: []const u8, hint: *Hint) ?Value {
    if (source != .object) return null;
    const members = source.object;
    if (hint.index < members.len) {
        const m = members[hint.index];
        if (m.key.len == name.len and (m.key.ptr == hint.key or std.mem.eql(u8, m.key, name))) {
            hint.key = m.key.ptr;
            return m.value;
        }
    }
    for (members, 0..) |m, i| if (std.mem.eql(u8, m.key, name)) {
        hint.* = .{ .index = i, .key = m.key.ptr };
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

test "lookup hint: shared keys skip the compare; other shapes and orders still resolve" {
    const id = "id";
    const name = "name";
    // Rows 0-1 share key slices (as pq.convertRows builds them).
    var r0 = [_]Member{ .{ .key = id, .value = .{ .number = 1 } }, .{ .key = name, .value = .{ .string = "a" } } };
    var r1 = [_]Member{ .{ .key = id, .value = .{ .number = 2 } }, .{ .key = name, .value = .{ .string = "b" } } };
    // Row 2: equal text in other slices, reversed order.
    const id2 = try std.testing.allocator.dupe(u8, "id");
    defer std.testing.allocator.free(id2);
    const name2 = try std.testing.allocator.dupe(u8, "name");
    defer std.testing.allocator.free(name2);
    var r2 = [_]Member{ .{ .key = name2, .value = .{ .string = "c" } }, .{ .key = id2, .value = .{ .number = 3 } } };
    // Row 3: a different shape (missing `name`, an extra key of the same length at its index).
    var r3 = [_]Member{ .{ .key = id, .value = .{ .number = 4 } }, .{ .key = "nome", .value = .{ .string = "x" } } };
    var id_hint: Hint = .{};
    var name_hint: Hint = .{};
    const rows = [_]Value{ .{ .object = &r0 }, .{ .object = &r1 }, .{ .object = &r2 }, .{ .object = &r3 }, .{ .object = &r1 } };
    const want_ids = [_]f64{ 1, 2, 3, 4, 2 };
    for (rows, want_ids) |row, want| try std.testing.expectEqual(want, lookup(row, "id", &id_hint).?.number);
    try std.testing.expectEqualStrings("a", lookup(rows[0], "name", &name_hint).?.string);
    try std.testing.expectEqualStrings("b", lookup(rows[1], "name", &name_hint).?.string);
    try std.testing.expectEqualStrings("c", lookup(rows[2], "name", &name_hint).?.string);
    try std.testing.expect(lookup(rows[3], "name", &name_hint) == null);
    try std.testing.expectEqualStrings("b", lookup(rows[4], "name", &name_hint).?.string);
    try std.testing.expect(lookup(.null, "id", &id_hint) == null);
}
