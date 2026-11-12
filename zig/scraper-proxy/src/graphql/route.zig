//! The `/graphql` route: `scraperdb/graphql.ts` hooks (upload + request
//! admission, response cache, stats, metrics, error logging) around a port of
//! mercurius' request flow (CSRF, route schemas, document LRU + error LRU,
//! JSON-AST fallback, GET operation check, variable pre-check, execution,
//! `defaultErrorFormatter` status rule) and its response serialization
//! (fast-json-stringify for 2xx, JSON.stringify otherwise).
const std = @import("std");
const core = @import("core");
const http = @import("http");
const json = core.json;
const ast = @import("ast.zig");
const parser = @import("parser.zig");
const schema_mod = @import("schema.zig");
const validate_mod = @import("validate.zig");
const validation_rule = @import("validation_rule.zig");
const compat = @import("compat.zig");
const values = @import("values.zig");
const execute = @import("execute.zig");
const resolvers_mod = @import("resolvers.zig");
const cache_mod = @import("cache.zig");
const request_schema = @import("request_schema.zig");
const v8json = @import("v8json.zig");
const js = @import("js.zig");
const root_pool = @import("root_pool.zig");

const Value = json.Value;
const Member = json.Member;
const Schema = schema_mod.Schema;
const GqlError = execute.GqlError;
const Allocator = std.mem.Allocator;
const metrics = core.metrics;
const logger = core.log.child("GraphQL");

pub const max_request_bytes = 100 * 1024;
pub const capacity_message = "GraphQL request capacity exceeded";
const document_cache_size = 1024;
const csrf_message = "This operation has been blocked as a potential Cross-Site Request Forgery (CSRF).";
const csrf_required_headers = [_][]const u8{ "x-apollo-operation-name", "apollo-require-preflight", "x-mercurius-operation-name", "mercurius-require-preflight" };
const csrf_allowed_content_types = [_][]const u8{ "application/json", "application/graphql" };

pub const Options = struct {
    max_active_requests: u32 = 25,
    max_active_uploads: u32 = 50,
    /// Cap on pooled threads executing extra root fields concurrently;
    /// 0 runs root fields sequentially.
    root_field_threads: u32 = 64,
};

/// `graphql stats` window counters. Atomics (no lock on the request path);
/// `logStats` swaps each to zero, so a request finishing during the swap may
/// split its fields across two windows (log text only).
const Stats = struct {
    errors: std.atomic.Value(u64) = .init(0),
    max_ms: std.atomic.Value(i64) = .init(0),
    rejected: std.atomic.Value(u64) = .init(0),
    requests: std.atomic.Value(u64) = .init(0),
    status4xx: std.atomic.Value(u64) = .init(0),
    status5xx: std.atomic.Value(u64) = .init(0),
    total_ms: std.atomic.Value(i64) = .init(0),
};

/// Takes a slot when `counter < max` (graphql.ts admission checks).
fn tryAcquire(counter: *std.atomic.Value(u32), max: u32) bool {
    var current = counter.load(.monotonic);
    while (current < max) {
        current = counter.cmpxchgWeak(current, current + 1, .monotonic, .monotonic) orelse return true;
    }
    return false;
}

/// Execution slot of an admitted request (see "Execution admission" below).
const Slot = enum(u8) { none, deciding, held, rejected };

/// Per-request hook state (`requestStates` / `uploadReleases` WeakMaps).
const RequestState = struct {
    route: *GraphqlRoute,
    /// TS `uploadReleases` has an entry (every admitted non-GET request).
    upload_tracked: bool = false,
    /// ...and it counts in `active_uploads` (its body was still arriving).
    upload_held: bool = false,
    /// Passed the preHandler capacity check (recorded on completion).
    admitted: bool = false,
    slot: std.atomic.Value(Slot) = .init(.none),
    started_ms: i64 = 0,
    failed: bool = false,
    prepared: ?cache_mod.PreparedCacheRequest = null,
    /// Shared cached body being written (released in on_done).
    hit: ?cache_mod.SharedHit = null,
};

pub const GraphqlRoute = struct {
    gpa: Allocator,
    schema: *const Schema,
    resolver_map: resolvers_mod.ResolverMap,
    options: Options,
    active_requests: std.atomic.Value(u32) = .init(0),
    active_uploads: std.atomic.Value(u32) = .init(0),
    stats: Stats = .{},
    response_cache: cache_mod.ResponseCache,
    documents: DocumentCache,
    error_documents: ErrorCache,
    now_ms: *const fn () i64 = defaultNow,
    /// `core.scheduler` timer of the 60 s stats log (0 = not started).
    stats_timer: u64 = 0,
    root_fields: root_pool.RootPool,
    /// Test seam: runs after execution, before the response is serialized.
    after_execute_hook: ?*const fn (*GraphqlRoute) void = null,

    fn defaultNow() i64 {
        return std.time.milliTimestamp();
    }

    pub fn init(gpa: Allocator, schema: *const Schema, resolver_map: resolvers_mod.ResolverMap, options: Options) GraphqlRoute {
        metrics.graphql_active_request_limit.set(.{}, @floatFromInt(options.max_active_requests));
        return .{
            .gpa = gpa,
            .schema = schema,
            .resolver_map = resolver_map,
            .options = options,
            .response_cache = cache_mod.ResponseCache.init(gpa),
            .documents = .{ .gpa = gpa },
            .error_documents = .{ .gpa = gpa },
            .root_fields = root_pool.RootPool.init(options.root_field_threads),
        };
    }

    pub fn deinit(self: *GraphqlRoute) void {
        self.stopStatsTimer();
        self.root_fields.deinit();
        self.response_cache.deinit();
        self.documents.deinit();
        self.error_documents.deinit();
    }

    /// The 60s `graphql stats ...` interval (unref'd timer in TS).
    /// The 60s `graphql stats ...` interval (unref'd timer in TS), on the
    /// process timer thread (`core.scheduler.global()`).
    pub fn startStatsTimer(self: *GraphqlRoute) !void {
        self.stats_timer = try core.scheduler.global().every(60_000, self, statsTick);
    }

    pub fn stopStatsTimer(self: *GraphqlRoute) void {
        if (self.stats_timer == 0) return;
        _ = core.scheduler.global().cancel(self.stats_timer);
        self.stats_timer = 0;
    }

    fn statsTick(ctx: *anyopaque, _: u64) void {
        const self: *GraphqlRoute = @ptrCast(@alignCast(ctx));
        self.logStats();
    }

    pub fn logStats(self: *GraphqlRoute) void {
        const st = &self.stats;
        const requests = st.requests.swap(0, .monotonic);
        const total_ms = st.total_ms.swap(0, .monotonic);
        const max_ms = st.max_ms.swap(0, .monotonic);
        const rejected = st.rejected.swap(0, .monotonic);
        const errors = st.errors.swap(0, .monotonic);
        const status4xx = st.status4xx.swap(0, .monotonic);
        const status5xx = st.status5xx.swap(0, .monotonic);
        const avg: i64 = if (requests > 0) @intFromFloat(@round(@as(f64, @floatFromInt(total_ms)) / @as(f64, @floatFromInt(requests)))) else 0;
        logger.info("graphql stats requests={d} rejected={d} errors={d} status4xx={d} status5xx={d} avgMs={d} maxMs={d}", .{ requests, rejected, errors, status4xx, status5xx, avg, max_ms });
    }

    pub fn route(self: *GraphqlRoute) http.Route {
        return .{
            .methods = &.{ "GET", "POST" },
            .path = "/graphql",
            .ctx = self,
            .hooks = .{
                .on_request = onRequest,
                .handler = handler,
                .error_handler = errorHandler,
                .on_send = onSend,
                .on_write_blocked = onWriteBlocked,
                .on_done = onDone,
            },
            .text_content_types = &.{"application/graphql"},
            .body_limit = max_request_bytes,
        };
    }

    fn state(self: *GraphqlRoute, req: *http.Request) *RequestState {
        if (req.state) |s| return @ptrCast(@alignCast(s));
        const s = req.arena.create(RequestState) catch @panic("out of memory");
        s.* = .{ .route = self };
        req.state = s;
        return s;
    }

    // ---- execution admission ----
    //
    // graphql.ts counts a request in `activeRequests` from preHandler until
    // the reply finishes. Node runs one request at a time between awaits, so
    // a request that completes without yielding (cache hit, validation error,
    // any I/O-free result whose response is written at once) is admitted and
    // finished before any other request's check runs: the counter other
    // requests observe is the number of requests parked on I/O. Here handlers
    // run on many threads, so a request takes its slot when it first yields
    // (`execute.beforeIo`, right before its first database or diagnostics
    // read) and returns it when the response is done; the preHandler check
    // compares against that count. Two requests that both passed the check
    // below the limit and then race for the last slot are ordered like Node
    // would order them: the loser gets the preHandler 503 (nothing has been
    // sent yet).

    fn enterSlot(ctx: *anyopaque) bool {
        const st: *RequestState = @ptrCast(@alignCast(ctx));
        while (true) {
            switch (st.slot.load(.acquire)) {
                .held => return true,
                .rejected => return false,
                .deciding => std.atomic.spinLoopHint(), // another root field of this request
                .none => {
                    if (st.slot.cmpxchgWeak(.none, .deciding, .acquire, .monotonic) != null) continue;
                    const self = st.route;
                    const ok = tryAcquire(&self.active_requests, self.options.max_active_requests);
                    if (ok) metrics.graphql_active_requests.inc(.{}, 1);
                    st.slot.store(if (ok) .held else .rejected, .release);
                    return ok;
                },
            }
        }
    }

    fn releaseSlot(self: *GraphqlRoute, st: *RequestState) void {
        if (st.slot.load(.acquire) != .held) return;
        st.slot.store(.none, .release);
        _ = self.active_requests.fetchSub(1, .monotonic);
        metrics.graphql_active_requests.dec(.{}, 1);
    }

    /// The preHandler capacity rejection (`reply.code(503)...`).
    fn sendCapacityRejection(self: *GraphqlRoute, reply: *http.Reply, started: i64) void {
        reply.code(503);
        reply.header("retry-after", "1");
        self.recordRequest(started, 503, true, null);
        reply.sendText(capacity_message);
    }

    // ---- hooks ----

    fn onRequest(ctx: *anyopaque, req: *http.Request, reply: *http.Reply) void {
        const self: *GraphqlRoute = @ptrCast(@alignCast(ctx));
        const st = self.state(req);
        // graphql.ts onRequest: bound buffered uploads independently of execution
        // slots. Like `activeRequests`, TS's counter only holds uploads still
        // waiting for body bytes: a body already buffered is consumed within
        // the same event-loop turn, so it is checked but never held.
        if (!std.mem.eql(u8, req.method, "GET")) {
            const full = if (req.body_pending)
                !tryAcquire(&self.active_uploads, self.options.max_active_uploads)
            else
                self.active_uploads.load(.monotonic) >= self.options.max_active_uploads;
            if (full) {
                reply.code(503);
                reply.header("retry-after", "1");
                reply.header("connection", "close");
                reply.destroy_after = true;
                reply.sendText("GraphQL upload capacity exceeded");
                return;
            }
            st.upload_tracked = true;
            st.upload_held = req.body_pending;
        }
        // mercurius route onRequest: CSRF prevention.
        if (!csrfSafe(req)) {
            self.sendThrown(req, reply, &.{.{ .message = csrf_message, .status = 400 }});
        }
    }

    fn handler(ctx: *anyopaque, req: *http.Request, reply: *http.Reply) void {
        const self: *GraphqlRoute = @ptrCast(@alignCast(ctx));
        self.handle(req, reply) catch {
            // Out of memory: Fastify would answer with a 500 through the error handler.
            reply.code(500);
            reply.sendSerializedJson("{\"data\":null,\"errors\":[{\"message\":\"Out of memory\"}]}");
        };
    }

    fn errorHandler(ctx: *anyopaque, req: *http.Request, reply: *http.Reply, err: http.FastifyError) void {
        const self: *GraphqlRoute = @ptrCast(@alignCast(ctx));
        self.sendThrown(req, reply, &.{.{ .message = err.message, .status = err.status }});
    }

    fn onSend(ctx: *anyopaque, req: *http.Request, reply: *http.Reply) void {
        const self: *GraphqlRoute = @ptrCast(@alignCast(ctx));
        const st = self.state(req);
        if (st.upload_tracked) {
            if (req.complete) {
                self.releaseUpload(st);
            } else {
                // Rejected/oversized uploads stop buffering before returning capacity.
                reply.header("connection", "close");
                reply.destroy_after = true;
            }
        }
        const prepared = st.prepared orelse return;
        if (st.failed) {
            reply.header("cache-control", "no-store");
            return;
        }
        if (prepared.ttl == 0) {
            reply.header("cache-control", "no-store");
        } else {
            reply.header("cache-control", cache_mod.cacheControlHeader(req.arena, prepared.ttl) catch return);
        }
        if (prepared.ttl > 0) {
            if (reply.body()) |body| self.response_cache.write(prepared, body) catch {};
        }
    }

    /// The response did not fit the socket: TS keeps the slot it took at
    /// preHandler until 'finish', so an admitted request that has not yielded
    /// yet joins now (no bound: it can no longer be rejected; exceeding the
    /// limit needs a race at the last slot).
    fn onWriteBlocked(ctx: *anyopaque, req: *http.Request, reply: *http.Reply) void {
        _ = reply;
        const self: *GraphqlRoute = @ptrCast(@alignCast(ctx));
        const st = self.state(req);
        if (!st.admitted or st.slot.load(.acquire) != .none) return;
        st.slot.store(.held, .release);
        _ = self.active_requests.fetchAdd(1, .monotonic);
        metrics.graphql_active_requests.inc(.{}, 1);
    }

    fn onDone(ctx: *anyopaque, req: *http.Request, reply: *http.Reply, reason: http.DoneReason) void {
        _ = reason;
        const self: *GraphqlRoute = @ptrCast(@alignCast(ctx));
        const st = self.state(req);
        self.releaseUpload(st);
        if (st.hit) |hit| {
            st.hit = null;
            self.response_cache.release(hit);
        }
        self.releaseSlot(st);
        if (!st.admitted) return;
        st.admitted = false;
        self.recordRequest(st.started_ms, reply.status, false, req);
    }

    fn releaseUpload(self: *GraphqlRoute, st: *RequestState) void {
        st.upload_tracked = false;
        if (!st.upload_held) return;
        st.upload_held = false;
        _ = self.active_uploads.fetchSub(1, .monotonic);
    }

    /// `req` null = the capacity rejection (`REQUEST /graphql` label).
    fn recordRequest(self: *GraphqlRoute, started: i64, status: u16, rejected: bool, req: ?*http.Request) void {
        const duration = self.now_ms() - started;
        const outcome: []const u8 = if (rejected) "capacity_rejected" else if (status >= 500) "server_error" else if (status >= 400) "client_error" else "success";
        metrics.graphql_requests.inc(.{outcome}, 1);
        metrics.graphql_request_duration.observe(.{}, @as(f64, @floatFromInt(duration)) / 1000);
        const st = &self.stats;
        _ = st.requests.fetchAdd(1, .monotonic);
        _ = st.total_ms.fetchAdd(duration, .monotonic);
        _ = st.max_ms.fetchMax(duration, .monotonic);
        if (rejected) _ = st.rejected.fetchAdd(1, .monotonic);
        if (status >= 400 and status < 500) _ = st.status4xx.fetchAdd(1, .monotonic);
        if (status >= 500) _ = st.status5xx.fetchAdd(1, .monotonic);
        if (req) |r| {
            logger.debug("{s} {s} {d} {d}ms", .{ r.method, r.url, status, duration });
        } else {
            logger.debug("REQUEST /graphql {d} {d}ms", .{ status, duration });
        }
    }

    // ---- request flow ----

    fn handle(self: *GraphqlRoute, req: *http.Request, reply: *http.Reply) !void {
        const a = req.arena;
        const st = self.state(req);
        // preValidation: the body is buffered; return the upload slot.
        self.releaseUpload(st);
        const is_get = std.mem.eql(u8, req.method, "GET") or std.mem.eql(u8, req.method, "HEAD");
        // Fastify route schema (attachValidation).
        const raw: Value = if (is_get) try request_schema.parseQuerystring(a, req.query) else switch (req.body) {
            .json => |v| v,
            .text => |t| if (contentTypeIs(req, "application/graphql")) try singleField(a, "query", .{ .string = t }) else Value{ .string = t },
            .none => Value.null,
        };
        const validated = if (is_get) try request_schema.validateQuerystring(a, raw) else try request_schema.validateBody(a, raw);

        // preHandler: execution admission (slot taken at the first yield).
        const started = self.now_ms();
        if (self.active_requests.load(.monotonic) >= self.options.max_active_requests) {
            return self.sendCapacityRejection(reply, started);
        }
        st.admitted = true;
        st.started_ms = started;

        // preHandler: response cache.
        if (validated == .ok) {
            const prepared_or_overflow = self.response_cache.prepare(a, self.schema, validated.ok) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                // graphql.ts preHandler throws (V8 RangeError in the cache key).
                error.StackOverflow => return self.sendThrown(req, reply, &.{.{ .message = values.stack_overflow_message }}),
            };
            if (prepared_or_overflow) |prepared| {
                if (self.response_cache.readShared(prepared)) |hit| {
                    // Zero-copy: the stored body is written directly and released in on_done.
                    st.hit = hit;
                    reply.header("cache-control", try cache_mod.cacheControlHeader(a, hit.ttl));
                    reply.@"type"("application/json; charset=utf-8");
                    reply.sendText(hit.body);
                    return;
                }
                st.prepared = prepared;
            }
        }

        // mercurius handler.
        const body = switch (validated) {
            .invalid => |message| return self.sendThrown(req, reply, &.{.{ .message = message, .status = 400 }}),
            .ok => |v| v,
        };
        const query_value = body.get("query");
        const op_value = body.get("operationName");
        var variables: VariablesInput = .absent;
        if (body.get("variables")) |v| variables = .{ .value = v };
        if (is_get) {
            // `variables && tryJSONParse(variables)`, then extensions likewise.
            if (variables == .value and variables.value == .string and variables.value.string.len > 0) {
                variables = .{ .value = switch (try parseJsonParam(a, variables.value.string)) {
                    .ok => |v| v,
                    .err => |m| return self.sendThrown(req, reply, &.{.{ .message = m, .status = 400 }}),
                } };
            }
            if (body.get("extensions")) |ext| if (ext == .string and ext.string.len > 0) {
                switch (try parseJsonParam(a, ext.string)) {
                    .ok => {},
                    .err => |m| return self.sendThrown(req, reply, &.{.{ .message = m, .status = 400 }}),
                }
            };
        }
        const query = if (query_value) |q| (if (q == .string) q.string else "") else "";
        if (query.len == 0) {
            return self.sendThrown(req, reply, &.{.{ .message = "Unknown query", .status = 400 }});
        }
        const operation_name: ?[]const u8 = if (op_value) |o| (if (o == .string) o.string else null) else null;
        // The executed Result points into the cached document (response keys,
        // aliases): keep the reference until the response is serialized.
        var doc_ref: ?*CachedDocument = null;
        defer if (doc_ref) |d| self.documents.release(d);
        const admission: execute.Admission = .{ .ctx = st, .enter = enterSlot };
        execute.admission = admission;
        const run = self.runGraphql(a, std.mem.eql(u8, req.method, "GET"), query, variables, operation_name, &doc_ref, admission);
        execute.admission = null;
        const outcome = try run;
        if (self.after_execute_hook) |hook| hook(self);
        if (st.slot.load(.acquire) == .rejected) {
            // Lost the last slot at the first yield: the preHandler 503.
            if (outcome == .executed) outcome.executed.deinit();
            st.admitted = false;
            st.prepared = null;
            return self.sendCapacityRejection(reply, started);
        }
        switch (outcome) {
            .thrown => |errors| self.sendThrown(req, reply, errors),
            .executed => |result| {
                defer result.deinit();
                self.sendExecuted(req, reply, result);
            },
        }
    }

    const VariablesInput = union(enum) { absent, value: Value };

    const Outcome = union(enum) {
        /// Errors thrown out of `reply.graphql` (formatted by the error handler).
        thrown: []const GqlError,
        executed: execute.Result,
    };

    /// `fastifyGraphQl(source, context, variables, operationName)`.
    /// On return `doc_ref` holds the document reference the caller must
    /// release after serializing the outcome.
    fn runGraphql(self: *GraphqlRoute, a: Allocator, is_get_exact: bool, query: []const u8, variables: VariablesInput, operation_name: ?[]const u8, doc_ref: *?*CachedDocument, admission: execute.Admission) !Outcome {
        const doc = switch (try self.obtainDocument(a, query)) {
            .errors => |errors| return .{ .thrown = errors },
            .document => |d| d,
        };
        doc_ref.* = doc;
        const document = doc.doc;
        if (is_get_exact) {
            if (cache_mod.getOperation(document, operation_name) == null) {
                return .{ .thrown = try a.dupe(GqlError, &.{.{ .message = "Cannot read properties of null (reading 'operation')" }}) };
            }
        }
        // buildExecutionContext: operation selection and variable coercion.
        const op = switch (try selectOperation(a, document, operation_name)) {
            .op => |o| o,
            .err => |message| {
                const errors = try a.dupe(GqlError, &.{.{ .message = message }});
                if (variables != .absent) return .{ .thrown = try withStatus(a, errors, 400) };
                return .{ .executed = .{ .data = null, .errors = errors } };
            },
        };
        const inputs: ?Value = switch (variables) {
            .absent => null,
            .value => |v| if (v == .object) v else null,
        };
        const coerced = switch (try values.getVariableValues(a, self.schema, op.variable_definitions, inputs)) {
            .coerced => |c| c,
            .errors => |errs| {
                const errors = try a.alloc(GqlError, errs.len);
                for (errs, errors) |e, *out| out.* = .{ .message = e.message, .locations = try execute.locationsFromOffsets(a, document.source, e.locations) };
                if (variables != .absent) return .{ .thrown = try withStatus(a, errors, 400) };
                return .{ .executed = .{ .data = null, .errors = errors } };
            },
        };
        var executor = try execute.Executor.init(a, self.schema, document, coerced, self.resolver_map.resolvers());
        executor.admission = admission;
        const parallel: ?execute.Parallel = if (self.options.root_field_threads > 0) .{ .pool = &self.root_fields, .backing = std.heap.c_allocator } else null;
        return .{ .executed = try executor.executeQuery(op, parallel) };
    }

    const DocumentOrErrors = union(enum) {
        document: *CachedDocument,
        errors: []const GqlError,
    };

    /// Parse (with the JSON-AST fallback), strip unused variables, validate,
    /// and cache by source text like mercurius' two LRUs.
    fn obtainDocument(self: *GraphqlRoute, a: Allocator, query: []const u8) !DocumentOrErrors {
        if (self.documents.acquire(query)) |d| return .{ .document = d };
        if (try self.error_documents.get(a, query)) |errors| return .{ .errors = try withStatus(a, errors, 400) };
        const entry = try self.documents.create(query);
        var keep = false;
        defer if (!keep) self.documents.destroy(entry);
        const ea = entry.arena.allocator();
        var diag: parser.Diagnostic = .{};
        const doc = parser.parse(ea, entry.source, .{ .max_tokens = validation_rule.max_graphql_tokens }, &diag) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            error.SyntaxError => {
                // A (emulated) V8 stack overflow is a RangeError: no location.
                const locations: []const ast.SourceLocation = if (diag.stack_overflow) &.{} else try a.dupe(ast.SourceLocation, &.{ast.location(query, diag.offset)});
                const syntax: GqlError = .{ .message = try a.dupe(u8, diag.message), .locations = locations, .status = 400 };
                const token_limit = std.fmt.comptimePrint("Syntax Error: Document contains more that {d} tokens. Parsing aborted.", .{validation_rule.max_graphql_tokens});
                if (!std.mem.eql(u8, diag.message, token_limit)) {
                    // mercurius retries the source as a JSON AST; graphql-js
                    // then rejects anything that is not an AST node.
                    if (json.parse(a, query, .{})) |parsed| {
                        return .{ .errors = try a.dupe(GqlError, &.{.{ .message = try invalidAstMessage(a, parsed) }}) };
                    } else |_| {}
                }
                return .{ .errors = try a.dupe(GqlError, &.{syntax}) };
            },
        };
        try compat.stripUnusedVariables(ea, doc);
        // Validation scratch stays in the request arena; the entry keeps the AST only.
        const validation = try validate_mod.validate(a, self.schema, doc);
        if (validation.len > 0) {
            const errors = try a.alloc(GqlError, validation.len);
            for (validation, errors) |v, *e| e.* = .{
                .message = try a.dupe(u8, v.message),
                .locations = try execute.locationsFromOffsets(a, query, v.locations),
                .status = 400,
            };
            try self.error_documents.put(query, errors);
            return .{ .errors = errors };
        }
        entry.doc = doc;
        keep = true;
        return .{ .document = self.documents.insert(entry) };
    }

    // ---- responses ----

    /// mercurius error handler: `errorFormatter({ errors: [toGraphQLError(err)] })`.
    fn sendThrown(self: *GraphqlRoute, req: *http.Request, reply: *http.Reply, errors: []const GqlError) void {
        // Single (flattened) error with a statusCode -> that status, else 200.
        var status: u16 = 200;
        if (errors.len == 1) if (errors[0].status) |s| {
            status = s;
        };
        self.formatterSideEffects(req, errors);
        reply.code(status);
        reply.sendSerializedJson(serializeResponse(req.arena, status, null, errors) catch "");
    }

    /// `maybeFormatErrors` after execution.
    fn sendExecuted(self: *GraphqlRoute, req: *http.Request, reply: *http.Reply, result: execute.Result) void {
        if (result.errors.len > 0) self.formatterSideEffects(req, result.errors);
        // Execution errors never carry a statusCode: always 200.
        reply.code(200);
        if (result.body) |prefixed| {
            // `{"data":` + data already written: append errors and close.
            var body = prefixed;
            finishResponse(&body.writer, result.errors, true) catch return reply.sendSerializedJson("");
            return reply.sendSerializedJson(body.written());
        }
        reply.sendSerializedJson(serializeResponse(req.arena, 200, result.data, result.errors) catch "");
    }

    /// graphql.ts errorFormatter wrapper: failed flag, stats, metrics, logs.
    fn formatterSideEffects(self: *GraphqlRoute, req: *http.Request, errors: []const GqlError) void {
        const st = self.state(req);
        if (!st.admitted or errors.len == 0) return;
        st.failed = true;
        _ = self.stats.errors.fetchAdd(errors.len, .monotonic);
        metrics.graphql_errors.inc(.{}, @floatFromInt(errors.len));
        for (errors) |e| {
            const fields = logFields(req.arena, e) catch continue;
            logger.withFields(.warn, fields, "GraphQL request error", .{});
        }
    }
};

fn logFields(a: Allocator, e: GqlError) !Value {
    var inner: std.ArrayList(Member) = .empty;
    if (e.code) |c| try inner.append(a, .{ .key = "code", .value = .{ .string = c } });
    try inner.append(a, .{ .key = "message", .value = .{ .string = e.message } });
    if (e.path) |p| try inner.append(a, .{ .key = "path", .value = try pathValue(a, p, false) });
    return singleField(a, "graphqlError", .{ .object = inner.items });
}

fn singleField(a: Allocator, key: []const u8, value: Value) !Value {
    return .{ .object = try a.dupe(Member, &.{.{ .key = key, .value = value }}) };
}

fn withStatus(a: Allocator, errors: []const GqlError, status: u16) ![]const GqlError {
    const out = try a.dupe(GqlError, errors);
    for (out) |*e| e.status = status;
    return out;
}

fn contentTypeIs(req: *http.Request, wanted: []const u8) bool {
    const ct = req.header("content-type") orelse return false;
    const semi = std.mem.indexOfScalar(u8, ct, ';') orelse ct.len;
    return std.ascii.eqlIgnoreCase(std.mem.trim(u8, ct[0..semi], " \t"), wanted);
}

/// mercurius `checkCSRFPrevention` with the graphql.ts required headers.
fn csrfSafe(req: *http.Request) bool {
    if (req.header("content-type")) |ct| {
        if (std.mem.indexOfScalar(u8, ct, ';')) |semi| {
            const main = std.mem.trim(u8, ct[0..semi], " \t");
            for (csrf_allowed_content_types) |allowed| if (std.ascii.eqlIgnoreCase(main, allowed)) return true;
        } else {
            // Without parameters the comparison is exact (case-sensitive).
            for (csrf_allowed_content_types) |allowed| if (std.mem.eql(u8, ct, allowed)) return true;
        }
    }
    for (req.headers) |h| {
        for (csrf_required_headers) |name| if (std.ascii.eqlIgnoreCase(h.name, name)) return true;
    }
    return false;
}

const ParamParse = union(enum) { ok: Value, err: []const u8 };

/// secure-json-parse over a GET parameter (V8 messages on syntax errors).
fn parseJsonParam(a: Allocator, text: []const u8) !ParamParse {
    const plain = json.parse(a, text, .{}) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.SyntaxError => return .{ .err = try v8json.errorMessage(a, text) },
    };
    const secure = json.parse(a, text, .{ .secure = true }) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.SyntaxError => return .{ .err = "Object contains forbidden prototype property" },
    };
    _ = plain;
    return .{ .ok = secure };
}

/// graphql-js validate/visit on a non-AST JSON value.
fn invalidAstMessage(a: Allocator, parsed: Value) ![]const u8 {
    return std.fmt.allocPrint(a, "Invalid AST Node: {s}.", .{try js.inspect(a, parsed)});
}

const OperationChoice = union(enum) { op: *const ast.Operation, err: []const u8 };

/// buildExecutionContext's operation lookup.
fn selectOperation(a: Allocator, doc: *const ast.Document, operation_name: ?[]const u8) !OperationChoice {
    var found: ?*const ast.Operation = null;
    for (doc.definitions) |def| {
        if (def != .operation) continue;
        const op = def.operation;
        if (operation_name) |name| {
            if (op.name != null and std.mem.eql(u8, op.name.?.value, name)) found = op;
        } else {
            if (found != null) return .{ .err = "Must provide operation name if query contains multiple operations." };
            found = op;
        }
    }
    if (found) |op| return .{ .op = op };
    if (operation_name) |name| return .{ .err = try std.fmt.allocPrint(a, "Unknown operation named \"{s}\".", .{name}) };
    return .{ .err = "Must provide an operation." };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/// 2xx: fast-json-stringify with mercurius' response schema (data, errors,
/// path items as strings); otherwise plain JSON.stringify of `{data, errors}`.
pub fn serializeResponse(a: Allocator, status: u16, data: ?Value, errors: []const GqlError) ![]const u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    const w = &out.writer;
    const schema_serialized = status >= 200 and status < 300;
    w.writeAll(execute.Executor.body_prefix) catch return error.OutOfMemory;
    if (data) |d| json.stringify(w, d) catch return error.OutOfMemory else w.writeAll("null") catch return error.OutOfMemory;
    finishResponse(w, errors, schema_serialized) catch return error.OutOfMemory;
    return out.written();
}

/// `,"errors":[...]` (when any) and the closing brace.
fn finishResponse(w: *std.Io.Writer, errors: []const GqlError, schema_serialized: bool) std.Io.Writer.Error!void {
    if (errors.len > 0) {
        try w.writeAll(",\"errors\":[");
        for (errors, 0..) |e, i| {
            if (i > 0) try w.writeByte(',');
            try writeError(w, e, schema_serialized);
        }
        try w.writeByte(']');
    }
    try w.writeByte('}');
}

fn writeError(w: *std.Io.Writer, e: GqlError, path_as_strings: bool) !void {
    try w.writeAll("{\"message\":");
    try json.writeString(w, e.message);
    if (e.locations.len > 0) {
        try w.writeAll(",\"locations\":[");
        for (e.locations, 0..) |l, i| {
            if (i > 0) try w.writeByte(',');
            try w.print("{{\"line\":{d},\"column\":{d}}}", .{ l.line, l.column });
        }
        try w.writeByte(']');
    }
    if (e.path) |path| {
        try w.writeAll(",\"path\":[");
        for (path, 0..) |seg, i| {
            if (i > 0) try w.writeByte(',');
            switch (seg) {
                .key => |k| try json.writeString(w, k),
                .index => |n| if (path_as_strings) try w.print("\"{d}\"", .{n}) else try w.print("{d}", .{n}),
            }
        }
        try w.writeByte(']');
    }
    if (e.code) |code| {
        try w.writeAll(",\"extensions\":{\"code\":");
        try json.writeString(w, code);
        try w.writeByte('}');
    }
    try w.writeByte('}');
}

fn pathValue(a: Allocator, path: []const execute.PathSegment, as_strings: bool) !Value {
    const out = try a.alloc(Value, path.len);
    for (path, out) |seg, *v| v.* = switch (seg) {
        .key => |k| .{ .string = k },
        .index => |n| if (as_strings) .{ .string = try std.fmt.allocPrint(a, "{d}", .{n}) } else .{ .number = @floatFromInt(n) },
    };
    return .{ .array = out };
}

// ---------------------------------------------------------------------------
// Document caches (mercurius `cache: 1024` LRU + error LRU), thread-safe.
// Cached documents are shared read-only and reference counted so eviction
// never frees an AST another request is executing.
// ---------------------------------------------------------------------------

pub const CachedDocument = struct {
    arena: std.heap.ArenaAllocator,
    source: []const u8,
    doc: *ast.Document = undefined,
    /// Taken under the cache mutex (a mapped document always holds the
    /// cache's reference); dropped lock-free, last one frees.
    refs: std.atomic.Value(u32) = .init(1),
    cached: bool = false,
    prev: ?*CachedDocument = null,
    next: ?*CachedDocument = null,
};

pub const DocumentCache = struct {
    gpa: Allocator,
    mutex: std.Thread.Mutex = .{},
    map: std.StringHashMapUnmanaged(*CachedDocument) = .empty,
    head: ?*CachedDocument = null,
    tail: ?*CachedDocument = null,
    len: usize = 0,

    fn deinit(self: *DocumentCache) void {
        while (self.head) |d| {
            self.unlink(d);
            self.free(d);
        }
        self.map.deinit(self.gpa);
    }

    fn unlink(self: *DocumentCache, d: *CachedDocument) void {
        if (d.prev) |p| p.next = d.next else self.head = d.next;
        if (d.next) |n| n.prev = d.prev else self.tail = d.prev;
        d.prev = null;
        d.next = null;
        self.len -= 1;
    }

    fn push(self: *DocumentCache, d: *CachedDocument) void {
        d.prev = self.tail;
        if (self.tail) |t| t.next = d else self.head = d;
        self.tail = d;
        self.len += 1;
    }

    fn free(self: *DocumentCache, d: *CachedDocument) void {
        d.arena.deinit();
        self.gpa.destroy(d);
    }

    fn acquire(self: *DocumentCache, source: []const u8) ?*CachedDocument {
        self.mutex.lock();
        defer self.mutex.unlock();
        const d = self.map.get(source) orelse return null;
        if (self.tail != d) {
            self.unlink(d);
            self.push(d);
        }
        _ = d.refs.fetchAdd(1, .monotonic);
        return d;
    }

    fn create(self: *DocumentCache, source: []const u8) !*CachedDocument {
        const d = try self.gpa.create(CachedDocument);
        d.* = .{ .arena = std.heap.ArenaAllocator.init(self.gpa), .source = undefined };
        errdefer self.free(d);
        d.source = try d.arena.allocator().dupe(u8, source);
        return d;
    }

    fn destroy(self: *DocumentCache, d: *CachedDocument) void {
        self.free(d);
    }

    /// Caches `d` (caller keeps its reference) unless another request raced it in.
    fn insert(self: *DocumentCache, d: *CachedDocument) *CachedDocument {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.map.get(d.source) != null) return d; // uncached private copy
        self.map.put(self.gpa, d.source, d) catch return d;
        d.cached = true;
        _ = d.refs.fetchAdd(1, .monotonic);
        self.push(d);
        if (self.len > document_cache_size) {
            const oldest = self.head.?;
            self.unlink(oldest);
            _ = self.map.remove(oldest.source);
            oldest.cached = false;
            self.release(oldest);
        }
        return d;
    }

    /// Drops every cached document (the cache's references only).
    pub fn evictAll(self: *DocumentCache) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        while (self.head) |d| {
            self.unlink(d);
            _ = self.map.remove(d.source);
            d.cached = false;
            self.release(d);
        }
    }

    fn release(self: *DocumentCache, d: *CachedDocument) void {
        if (d.refs.fetchSub(1, .acq_rel) == 1) self.free(d);
    }
};

const ErrorEntry = struct {
    arena: std.heap.ArenaAllocator,
    source: []const u8,
    errors: []const GqlError,
    prev: ?*ErrorEntry = null,
    next: ?*ErrorEntry = null,
};

const ErrorCache = struct {
    gpa: Allocator,
    mutex: std.Thread.Mutex = .{},
    map: std.StringHashMapUnmanaged(*ErrorEntry) = .empty,
    head: ?*ErrorEntry = null,
    tail: ?*ErrorEntry = null,
    len: usize = 0,

    fn deinit(self: *ErrorCache) void {
        while (self.head) |e| {
            self.unlink(e);
            e.arena.deinit();
            self.gpa.destroy(e);
        }
        self.map.deinit(self.gpa);
    }

    fn unlink(self: *ErrorCache, e: *ErrorEntry) void {
        if (e.prev) |p| p.next = e.next else self.head = e.next;
        if (e.next) |n| n.prev = e.prev else self.tail = e.prev;
        e.prev = null;
        e.next = null;
        self.len -= 1;
    }

    fn push(self: *ErrorCache, e: *ErrorEntry) void {
        e.prev = self.tail;
        if (self.tail) |t| t.next = e else self.head = e;
        self.tail = e;
        self.len += 1;
    }

    /// Copies cached errors into `a`.
    fn get(self: *ErrorCache, a: Allocator, source: []const u8) !?[]const GqlError {
        self.mutex.lock();
        defer self.mutex.unlock();
        const e = self.map.get(source) orelse return null;
        self.unlink(e);
        self.push(e);
        return try copyErrors(a, e.errors);
    }

    fn put(self: *ErrorCache, source: []const u8, errors: []const GqlError) !void {
        const e = try self.gpa.create(ErrorEntry);
        e.* = .{ .arena = std.heap.ArenaAllocator.init(self.gpa), .source = undefined, .errors = undefined };
        errdefer {
            e.arena.deinit();
            self.gpa.destroy(e);
        }
        const ea = e.arena.allocator();
        e.source = try ea.dupe(u8, source);
        e.errors = try copyErrors(ea, errors);
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.map.get(e.source) != null) {
            e.arena.deinit();
            self.gpa.destroy(e);
            return;
        }
        try self.map.put(self.gpa, e.source, e);
        self.push(e);
        if (self.len > document_cache_size) {
            const oldest = self.head.?;
            self.unlink(oldest);
            _ = self.map.remove(oldest.source);
            oldest.arena.deinit();
            self.gpa.destroy(oldest);
        }
    }
};

fn copyErrors(a: Allocator, errors: []const GqlError) ![]const GqlError {
    const out = try a.alloc(GqlError, errors.len);
    for (errors, out) |e, *o| o.* = .{
        .message = try a.dupe(u8, e.message),
        .locations = try a.dupe(ast.SourceLocation, e.locations),
        .status = e.status,
        .code = e.code,
    };
    return out;
}
