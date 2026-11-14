//! Environment configuration equivalent to `src/config.ts` (zod 4 schema with
//! `z.coerce.number()`), including `dotenv-flow` file loading. Validation
//! failures produce the same zod issues (code/path/message, schema key order)
//! printed as `ZodError: [...]` and a non-zero exit.
const std = @import("std");
const json = @import("json.zig");

pub const Config = struct {
    database_query_timeout_ms: u64 = 20_000,
    database_read_replica_url: ?[]const u8 = null,
    database_slow_query_ms: u64 = 1_000,
    database_statement_timeout_ms: u64 = 15_000,
    database_url: []const u8 = "",
    diagnostics_database_url: ?[]const u8 = null,
    event_stream_batch_size: u64 = 500,
    event_stream_history_max_concurrent: u64 = 2,
    event_stream_history_max_ms: u64 = 1_800_000,
    event_stream_max_agent_clients: u64 = 100,
    event_stream_max_buffered_bytes: u64 = 1_048_576,
    event_stream_max_total_buffered_bytes: u64 = 33_554_432,
    graphql_max_active_requests: u64 = 25,
    graphql_max_active_uploads: u64 = 50,
    port: u64 = 8383,
    /// Not part of the zod schema; read by live (`clientIp`) as in TS.
    node_env: ?[]const u8 = null,
};

var instance: Config = .{};

/// Process-wide config (TS module-level `config`). Set once by `main` (or a test).
pub fn get() *const Config {
    return &instance;
}

pub fn set(config: Config) void {
    instance = config;
}

const IntRule = struct { env: []const u8, field: []const u8, min: ?f64 = null, max: ?f64 = null, positive: bool = false };
const StrRule = struct { env: []const u8, field: []const u8, optional: bool };

const Rule = union(enum) { int: IntRule, str: StrRule };

/// Schema keys in declaration order (zod reports issues in this order).
const rules = [_]Rule{
    .{ .int = .{ .env = "DATABASE_QUERY_TIMEOUT_MS", .field = "database_query_timeout_ms", .min = 1_000 } },
    .{ .str = .{ .env = "DATABASE_READ_REPLICA_URL", .field = "database_read_replica_url", .optional = true } },
    .{ .int = .{ .env = "DATABASE_SLOW_QUERY_MS", .field = "database_slow_query_ms", .min = 1 } },
    .{ .int = .{ .env = "DATABASE_STATEMENT_TIMEOUT_MS", .field = "database_statement_timeout_ms", .min = 1_000 } },
    .{ .str = .{ .env = "DATABASE_URL", .field = "database_url", .optional = false } },
    .{ .str = .{ .env = "DIAGNOSTICS_DATABASE_URL", .field = "diagnostics_database_url", .optional = true } },
    .{ .int = .{ .env = "EVENT_STREAM_BATCH_SIZE", .field = "event_stream_batch_size", .min = 1, .max = 5_000 } },
    .{ .int = .{ .env = "EVENT_STREAM_HISTORY_MAX_CONCURRENT", .field = "event_stream_history_max_concurrent", .min = 1, .max = 10 } },
    .{ .int = .{ .env = "EVENT_STREAM_HISTORY_MAX_MS", .field = "event_stream_history_max_ms", .min = 1_000 } },
    .{ .int = .{ .env = "EVENT_STREAM_MAX_AGENT_CLIENTS", .field = "event_stream_max_agent_clients", .min = 1, .max = 10_000 } },
    .{ .int = .{ .env = "EVENT_STREAM_MAX_BUFFERED_BYTES", .field = "event_stream_max_buffered_bytes", .min = 1_024 } },
    .{ .int = .{ .env = "EVENT_STREAM_MAX_TOTAL_BUFFERED_BYTES", .field = "event_stream_max_total_buffered_bytes", .min = 1_024 } },
    .{ .int = .{ .env = "GRAPHQL_MAX_ACTIVE_REQUESTS", .field = "graphql_max_active_requests", .min = 1 } },
    .{ .int = .{ .env = "GRAPHQL_MAX_ACTIVE_UPLOADS", .field = "graphql_max_active_uploads", .min = 1 } },
    .{ .int = .{ .env = "PORT", .field = "port", .positive = true } },
};

pub const ParseError = error{ InvalidConfig, OutOfMemory };

/// Validates `env` like `ConfigSchema.parse(process.env)`. On failure returns
/// `error.InvalidConfig` and, when `issues_json` is given, writes the zod
/// issue array (JSON, 2-space indented like `ZodError.message`) into it.
/// Strings in the result are duplicated with `a`.
pub fn parse(a: std.mem.Allocator, env: *const std.process.EnvMap, issues_json: ?*std.Io.Writer.Allocating) ParseError!Config {
    var arena_state = std.heap.ArenaAllocator.init(a);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var issues: std.ArrayList(json.Value) = .empty;
    var config: Config = .{};
    inline for (rules) |rule| switch (rule) {
        .int => |r| {
            if (env.get(r.env)) |raw| {
                if (try checkInt(arena, &issues, r, raw)) |value| @field(config, r.field) = value;
            }
        },
        .str => |r| {
            if (env.get(r.env)) |raw| {
                if (raw.len < 1) {
                    try issues.append(arena, try issue(arena, &.{
                        .{ "origin", json.string("string") },
                        .{ "code", json.string("too_small") },
                        .{ "minimum", json.int(1) },
                        .{ "inclusive", .{ .bool = true } },
                    }, r.env, "Too small: expected string to have >=1 characters"));
                } else @field(config, r.field) = try a.dupe(u8, raw);
            } else if (!r.optional) {
                try issues.append(arena, try issue(arena, &.{
                    .{ "expected", json.string("string") },
                    .{ "code", json.string("invalid_type") },
                }, r.env, "Invalid input: expected string, received undefined"));
            }
        },
    };
    if (env.get("NODE_ENV")) |node_env| config.node_env = try a.dupe(u8, node_env);
    if (issues.items.len > 0) {
        if (issues_json) |out| writePretty(&out.writer, .{ .array = issues.items }, 0) catch return error.OutOfMemory;
        freeConfig(a, config);
        return error.InvalidConfig;
    }
    return config;
}

pub fn freeConfig(a: std.mem.Allocator, config: Config) void {
    if (config.database_read_replica_url) |s| a.free(s);
    if (config.database_url.len > 0) a.free(config.database_url);
    if (config.diagnostics_database_url) |s| a.free(s);
    if (config.node_env) |s| a.free(s);
}

fn checkInt(arena: std.mem.Allocator, issues: *std.ArrayList(json.Value), r: IntRule, raw: []const u8) !?u64 {
    const n = jsNumber(raw);
    if (std.math.isNan(n) or std.math.isInf(n)) {
        var buf: [64]u8 = undefined;
        const received = json.formatNumber(&buf, n);
        try issues.append(arena, try issue(arena, &.{
            .{ "expected", json.string("number") },
            .{ "code", json.string("invalid_type") },
            .{ "received", json.string(try arena.dupe(u8, received)) },
        }, r.env, try std.fmt.allocPrint(arena, "Invalid input: expected number, received {s}", .{received})));
        return null;
    }
    if (@trunc(n) != n) {
        try issues.append(arena, try issue(arena, &.{
            .{ "expected", json.string("int") },
            .{ "format", json.string("safeint") },
            .{ "code", json.string("invalid_type") },
        }, r.env, "Invalid input: expected int, received number"));
        return null;
    }
    var ok = true;
    const max_safe: f64 = 9007199254740991;
    if (@abs(n) > max_safe) {
        ok = false;
        const big = n > 0;
        try issues.append(arena, try issue(arena, &.{
            .{ "code", json.string(if (big) "too_big" else "too_small") },
            .{ if (big) "maximum" else "minimum", json.number(if (big) max_safe else -max_safe) },
            .{ "note", json.string("Integers must be within the safe integer range.") },
            .{ "origin", json.string("int") },
            .{ "inclusive", .{ .bool = true } },
        }, r.env, if (big) "Too big: expected int to be <=9007199254740991" else "Too small: expected int to be >=-9007199254740991"));
    }
    if (r.positive and !(n > 0)) {
        ok = false;
        try issues.append(arena, try issue(arena, &.{
            .{ "origin", json.string("number") },
            .{ "code", json.string("too_small") },
            .{ "minimum", json.int(0) },
            .{ "inclusive", .{ .bool = false } },
        }, r.env, "Too small: expected number to be >0"));
    }
    if (r.min) |min| if (n < min) {
        ok = false;
        try issues.append(arena, try issue(arena, &.{
            .{ "origin", json.string("number") },
            .{ "code", json.string("too_small") },
            .{ "minimum", json.number(min) },
            .{ "inclusive", .{ .bool = true } },
        }, r.env, try std.fmt.allocPrint(arena, "Too small: expected number to be >={d}", .{@as(i64, @intFromFloat(min))})));
    };
    if (r.max) |max| if (n > max) {
        ok = false;
        try issues.append(arena, try issue(arena, &.{
            .{ "origin", json.string("number") },
            .{ "code", json.string("too_big") },
            .{ "maximum", json.number(max) },
            .{ "inclusive", .{ .bool = true } },
        }, r.env, try std.fmt.allocPrint(arena, "Too big: expected number to be <={d}", .{@as(i64, @intFromFloat(max))})));
    };
    if (!ok) return null;
    return @intFromFloat(n);
}

const Field = struct { []const u8, json.Value };

fn issue(arena: std.mem.Allocator, fields: []const Field, path: []const u8, message: []const u8) !json.Value {
    var b: json.ObjectBuilder = .{};
    for (fields) |f| try b.putNew(arena, f[0], f[1]);
    const path_items = try arena.alloc(json.Value, 1);
    path_items[0] = json.string(path);
    try b.putNew(arena, "path", .{ .array = path_items });
    try b.putNew(arena, "message", json.string(message));
    return b.finish(arena);
}

/// `JSON.stringify(value, null, 2)`.
pub fn writePretty(w: *std.Io.Writer, value: json.Value, depth: usize) std.Io.Writer.Error!void {
    switch (value) {
        .array => |items| {
            if (items.len == 0) return w.writeAll("[]");
            try w.writeAll("[\n");
            for (items, 0..) |item, i| {
                try w.splatByteAll(' ', (depth + 1) * 2);
                try writePretty(w, item, depth + 1);
                try w.writeAll(if (i + 1 < items.len) ",\n" else "\n");
            }
            try w.splatByteAll(' ', depth * 2);
            try w.writeByte(']');
        },
        .object => |members| {
            if (members.len == 0) return w.writeAll("{}");
            try w.writeAll("{\n");
            for (members, 0..) |m, i| {
                try w.splatByteAll(' ', (depth + 1) * 2);
                try json.writeString(w, m.key);
                try w.writeAll(": ");
                try writePretty(w, m.value, depth + 1);
                try w.writeAll(if (i + 1 < members.len) ",\n" else "\n");
            }
            try w.splatByteAll(' ', depth * 2);
            try w.writeByte('}');
        },
        else => try json.stringify(w, value),
    }
}

/// ECMAScript `Number(string)` (StringToNumber).
pub fn jsNumber(raw: []const u8) f64 {
    const s = trimJsWhitespace(raw);
    if (s.len == 0) return 0;
    if (s.len > 2 and s[0] == '0') {
        const radix: ?u8 = switch (s[1]) {
            'x', 'X' => 16,
            'o', 'O' => 8,
            'b', 'B' => 2,
            else => null,
        };
        if (radix) |r| {
            var value: f64 = 0;
            for (s[2..]) |c| {
                const d = std.fmt.charToDigit(c, r) catch return std.math.nan(f64);
                value = value * @as(f64, @floatFromInt(r)) + @as(f64, @floatFromInt(d));
            }
            return value;
        }
    }
    var body = s;
    var negative = false;
    if (body[0] == '+' or body[0] == '-') {
        negative = body[0] == '-';
        body = body[1..];
    }
    if (std.mem.eql(u8, body, "Infinity")) return if (negative) -std.math.inf(f64) else std.math.inf(f64);
    // StrUnsignedDecimalLiteral: digits [. digits] [e[+-]digits] | . digits [exp]
    var i: usize = 0;
    var int_digits: usize = 0;
    while (i < body.len and std.ascii.isDigit(body[i])) : (i += 1) int_digits += 1;
    var frac_digits: usize = 0;
    if (i < body.len and body[i] == '.') {
        i += 1;
        while (i < body.len and std.ascii.isDigit(body[i])) : (i += 1) frac_digits += 1;
    }
    if (int_digits + frac_digits == 0) return std.math.nan(f64);
    if (i < body.len and (body[i] == 'e' or body[i] == 'E')) {
        i += 1;
        if (i < body.len and (body[i] == '+' or body[i] == '-')) i += 1;
        const start = i;
        while (i < body.len and std.ascii.isDigit(body[i])) i += 1;
        if (i == start) return std.math.nan(f64);
    }
    if (i != body.len) return std.math.nan(f64);
    const value = std.fmt.parseFloat(f64, body) catch return std.math.nan(f64);
    return if (negative) -value else value;
}

fn trimJsWhitespace(s: []const u8) []const u8 {
    var start: usize = 0;
    var end: usize = s.len;
    while (start < end) {
        const len = jsWhitespaceLen(s[start..end]) orelse break;
        start += len;
    }
    while (end > start) {
        var found = false;
        // Whitespace code points are at most 3 bytes in UTF-8.
        var back: usize = 1;
        while (back <= 3 and back <= end - start) : (back += 1) {
            if (jsWhitespaceLen(s[end - back .. end])) |len| if (len == back) {
                end -= back;
                found = true;
                break;
            };
        }
        if (!found) break;
    }
    return s[start..end];
}

/// Byte length of a leading ECMAScript WhiteSpace/LineTerminator code point.
fn jsWhitespaceLen(s: []const u8) ?usize {
    switch (s[0]) {
        ' ', '\t', '\n', '\r', 0x0b, 0x0c => return 1,
        else => {},
    }
    const len = std.unicode.utf8ByteSequenceLength(s[0]) catch return null;
    if (len == 1 or s.len < len) return null;
    const cp = std.unicode.utf8Decode(s[0..len]) catch return null;
    return switch (cp) {
        0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff => len,
        else => null,
    };
}

// ---------------------------------------------------------------------------
// dotenv-flow
// ---------------------------------------------------------------------------

/// `dotenvFlow.config()`: loads `.env`, `.env.local` (skipped when
/// NODE_ENV=test), `.env.<NODE_ENV>`, `.env.<NODE_ENV>.local` from `dir`, with
/// later files overriding earlier ones and real environment variables winning
/// over every file. Missing files are ignored.
pub fn loadDotenvFlow(a: std.mem.Allocator, dir: std.fs.Dir, env: *std.process.EnvMap) !void {
    var file_values = std.process.EnvMap.init(a);
    defer file_values.deinit();
    const node_env = env.get("NODE_ENV");
    var names: [4][]const u8 = undefined;
    var count: usize = 0;
    var buf1: [256]u8 = undefined;
    var buf2: [256]u8 = undefined;
    names[count] = ".env";
    count += 1;
    if (node_env == null or !std.mem.eql(u8, node_env.?, "test")) {
        names[count] = ".env.local";
        count += 1;
    }
    if (node_env) |ne| if (ne.len > 0 and ne.len < 200) {
        names[count] = try std.fmt.bufPrint(&buf1, ".env.{s}", .{ne});
        count += 1;
        names[count] = try std.fmt.bufPrint(&buf2, ".env.{s}.local", .{ne});
        count += 1;
    };
    for (names[0..count]) |name| {
        const contents = dir.readFileAlloc(a, name, 1 << 20) catch |e| switch (e) {
            error.FileNotFound => continue,
            else => return e,
        };
        defer a.free(contents);
        try parseDotenv(a, contents, &file_values);
    }
    var it = file_values.iterator();
    while (it.next()) |entry| {
        if (env.get(entry.key_ptr.*) == null) try env.put(entry.key_ptr.*, entry.value_ptr.*);
    }
}

/// dotenv 16 line format: `[export ]KEY=value`, `#` comments, single/double/
/// backtick quotes, double-quoted `\n`/`\r` expansion, multi-line quoted values.
pub fn parseDotenv(a: std.mem.Allocator, src: []const u8, out: *std.process.EnvMap) !void {
    var i: usize = 0;
    while (i < src.len) {
        // Skip blank space and comment lines.
        while (i < src.len and (src[i] == ' ' or src[i] == '\t' or src[i] == '\n' or src[i] == '\r')) i += 1;
        if (i >= src.len) break;
        if (src[i] == '#') {
            while (i < src.len and src[i] != '\n') i += 1;
            continue;
        }
        var line_start = i;
        if (std.mem.startsWith(u8, src[i..], "export ")) line_start += 7;
        var j = line_start;
        while (j < src.len and src[j] != '=' and src[j] != ':' and src[j] != '\n') j += 1;
        if (j >= src.len or src[j] == '\n') {
            i = j;
            continue;
        }
        const key = std.mem.trim(u8, src[line_start..j], " \t");
        j += 1;
        while (j < src.len and (src[j] == ' ' or src[j] == '\t')) j += 1;
        var value: []const u8 = "";
        var owned: ?[]u8 = null;
        defer if (owned) |o| a.free(o);
        if (j < src.len and (src[j] == '"' or src[j] == '\'' or src[j] == '`')) {
            const quote = src[j];
            const end = std.mem.indexOfScalarPos(u8, src, j + 1, quote);
            if (end) |e| {
                value = src[j + 1 .. e];
                if (quote == '"') {
                    var expanded: std.ArrayList(u8) = .empty;
                    var k: usize = 0;
                    while (k < value.len) : (k += 1) {
                        if (value[k] == '\\' and k + 1 < value.len and (value[k + 1] == 'n' or value[k + 1] == 'r')) {
                            try expanded.append(a, if (value[k + 1] == 'n') '\n' else '\r');
                            k += 1;
                        } else try expanded.append(a, value[k]);
                    }
                    owned = try expanded.toOwnedSlice(a);
                    value = owned.?;
                }
                i = e + 1;
                while (i < src.len and src[i] != '\n') i += 1;
            } else {
                const nl = std.mem.indexOfScalarPos(u8, src, j, '\n') orelse src.len;
                value = std.mem.trim(u8, src[j..nl], " \t\r");
                i = nl;
            }
        } else {
            const nl = std.mem.indexOfScalarPos(u8, src, j, '\n') orelse src.len;
            var raw = src[j..nl];
            if (std.mem.indexOf(u8, raw, " #")) |hash| raw = raw[0..hash];
            value = std.mem.trim(u8, raw, " \t\r");
            i = nl;
        }
        if (key.len > 0) try out.put(key, value);
    }
}

/// `dotenv-flow` + `ConfigSchema.parse(process.env)`: on failure prints the
/// zod error to stderr and returns `error.InvalidConfig`.
pub fn load(a: std.mem.Allocator, env: *std.process.EnvMap) ParseError!Config {
    loadDotenvFlow(a, std.fs.cwd(), env) catch |e| {
        std.debug.print("[dotenv-flow]: failed to load .env files: {s}\n", .{@errorName(e)});
    };
    var issues: std.Io.Writer.Allocating = .init(a);
    defer issues.deinit();
    return parse(a, env, &issues) catch |e| {
        if (e == error.InvalidConfig) std.debug.print("ZodError: {s}\n", .{issues.written()});
        return e;
    };
}

const testing = std.testing;

fn envOf(pairs: []const [2][]const u8) !std.process.EnvMap {
    var env = std.process.EnvMap.init(testing.allocator);
    errdefer env.deinit();
    for (pairs) |p| try env.put(p[0], p[1]);
    return env;
}

test "defaults and coercion" {
    var env = try envOf(&.{
        .{ "DATABASE_URL", "postgresql://x" },
        .{ "EVENT_STREAM_BATCH_SIZE", " 0x10 " },
        .{ "GRAPHQL_MAX_ACTIVE_REQUESTS", "1e3" },
        .{ "DATABASE_SLOW_QUERY_MS", "0b11" },
    });
    defer env.deinit();
    const c = try parse(testing.allocator, &env, null);
    defer freeConfig(testing.allocator, c);
    try testing.expectEqualStrings("postgresql://x", c.database_url);
    try testing.expectEqual(@as(u64, 16), c.event_stream_batch_size);
    try testing.expectEqual(@as(u64, 1000), c.graphql_max_active_requests);
    try testing.expectEqual(@as(u64, 3), c.database_slow_query_ms);
    try testing.expectEqual(@as(u64, 8383), c.port);
    try testing.expectEqual(@as(u64, 20_000), c.database_query_timeout_ms);
    try testing.expect(c.database_read_replica_url == null);
}

test "zod 4 issues match TS output" {
    // Expected JSON captured from Node 26 + zod 4.5.4 for the same environment.
    var env = try envOf(&.{
        .{ "EVENT_STREAM_BATCH_SIZE", "Infinity" },
        .{ "EVENT_STREAM_HISTORY_MAX_CONCURRENT", "1e20" },
        .{ "EVENT_STREAM_HISTORY_MAX_MS", "-0" },
        .{ "EVENT_STREAM_MAX_AGENT_CLIENTS", "" },
        .{ "GRAPHQL_MAX_ACTIVE_UPLOADS", "99999999999999999999" },
        .{ "DATABASE_QUERY_TIMEOUT_MS", "1.5" },
        .{ "DATABASE_READ_REPLICA_URL", "" },
        .{ "PORT", "abc" },
    });
    defer env.deinit();
    var out: std.Io.Writer.Allocating = .init(testing.allocator);
    defer out.deinit();
    try testing.expectError(error.InvalidConfig, parse(testing.allocator, &env, &out));
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const compact = try json.stringifyAlloc(arena.allocator(), try json.parse(arena.allocator(), out.written(), .{}));
    try testing.expectEqualStrings(
        "[{\"expected\":\"int\",\"format\":\"safeint\",\"code\":\"invalid_type\",\"path\":[\"DATABASE_QUERY_TIMEOUT_MS\"],\"message\":\"Invalid input: expected int, received number\"}," ++
            "{\"origin\":\"string\",\"code\":\"too_small\",\"minimum\":1,\"inclusive\":true,\"path\":[\"DATABASE_READ_REPLICA_URL\"],\"message\":\"Too small: expected string to have >=1 characters\"}," ++
            "{\"expected\":\"string\",\"code\":\"invalid_type\",\"path\":[\"DATABASE_URL\"],\"message\":\"Invalid input: expected string, received undefined\"}," ++
            "{\"expected\":\"number\",\"code\":\"invalid_type\",\"received\":\"Infinity\",\"path\":[\"EVENT_STREAM_BATCH_SIZE\"],\"message\":\"Invalid input: expected number, received Infinity\"}," ++
            "{\"code\":\"too_big\",\"maximum\":9007199254740991,\"note\":\"Integers must be within the safe integer range.\",\"origin\":\"int\",\"inclusive\":true,\"path\":[\"EVENT_STREAM_HISTORY_MAX_CONCURRENT\"],\"message\":\"Too big: expected int to be <=9007199254740991\"}," ++
            "{\"origin\":\"number\",\"code\":\"too_big\",\"maximum\":10,\"inclusive\":true,\"path\":[\"EVENT_STREAM_HISTORY_MAX_CONCURRENT\"],\"message\":\"Too big: expected number to be <=10\"}," ++
            "{\"origin\":\"number\",\"code\":\"too_small\",\"minimum\":1000,\"inclusive\":true,\"path\":[\"EVENT_STREAM_HISTORY_MAX_MS\"],\"message\":\"Too small: expected number to be >=1000\"}," ++
            "{\"origin\":\"number\",\"code\":\"too_small\",\"minimum\":1,\"inclusive\":true,\"path\":[\"EVENT_STREAM_MAX_AGENT_CLIENTS\"],\"message\":\"Too small: expected number to be >=1\"}," ++
            "{\"code\":\"too_big\",\"maximum\":9007199254740991,\"note\":\"Integers must be within the safe integer range.\",\"origin\":\"int\",\"inclusive\":true,\"path\":[\"GRAPHQL_MAX_ACTIVE_UPLOADS\"],\"message\":\"Too big: expected int to be <=9007199254740991\"}," ++
            "{\"expected\":\"number\",\"code\":\"invalid_type\",\"received\":\"NaN\",\"path\":[\"PORT\"],\"message\":\"Invalid input: expected number, received NaN\"}]",
        compact,
    );
}

test "PORT must be positive" {
    var env = try envOf(&.{ .{ "DATABASE_URL", "x" }, .{ "PORT", " " } });
    defer env.deinit();
    var out: std.Io.Writer.Allocating = .init(testing.allocator);
    defer out.deinit();
    try testing.expectError(error.InvalidConfig, parse(testing.allocator, &env, &out));
    try testing.expect(std.mem.indexOf(u8, out.written(), "Too small: expected number to be >0") != null);
}

test "jsNumber follows ECMAScript StringToNumber" {
    try testing.expectEqual(@as(f64, 0), jsNumber(""));
    try testing.expectEqual(@as(f64, 0), jsNumber(" \t\n"));
    try testing.expectEqual(@as(f64, 12), jsNumber("\u{a0}12\u{feff}"));
    try testing.expectEqual(@as(f64, 255), jsNumber("0xff"));
    try testing.expect(std.math.isNan(jsNumber("-0x1")));
    try testing.expect(std.math.isNan(jsNumber("1_000")));
    try testing.expect(std.math.isNan(jsNumber(".")));
    try testing.expect(std.math.isNan(jsNumber("1e")));
    try testing.expectEqual(@as(f64, 0.5), jsNumber(".5"));
    try testing.expectEqual(@as(f64, 1), jsNumber("1."));
    try testing.expectEqual(@as(f64, -1500), jsNumber("-1.5e3"));
    try testing.expect(std.math.isInf(jsNumber("+Infinity")));
    try testing.expect(std.math.isNan(jsNumber("inf")));
}

test "dotenv parsing" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try parseDotenv(testing.allocator,
        \\# comment
        \\export A=1
        \\B = "two\nlines"
        \\C='x # y'
        \\D=plain # trailing
        \\E=
    , &env);
    try testing.expectEqualStrings("1", env.get("A").?);
    try testing.expectEqualStrings("two\nlines", env.get("B").?);
    try testing.expectEqualStrings("x # y", env.get("C").?);
    try testing.expectEqualStrings("plain", env.get("D").?);
    try testing.expectEqualStrings("", env.get("E").?);
}
