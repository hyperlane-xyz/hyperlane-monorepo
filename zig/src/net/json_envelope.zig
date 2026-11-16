//! One-pass JSON-RPC envelope facts without a dynamic Value tree. `scan`
//! tokenizes the whole document (syntax, optional depth bound, duplicate keys
//! at every depth after unescaping, exactly as std.json's `.error` policy) and
//! records only the byte spans of the top-level members the RPC layer reads.
//! Callers map those facts to their own dialect's errors; values that really
//! need a tree are built from their span alone by `parseValue`, which matches
//! `std.json.Value` parsing token for token but borrows unescaped strings and
//! numbers from the input instead of copying every one of them.
const std = @import("std");
const A = std.mem.Allocator;
const Scanner = std.json.Scanner;
const fast = @import("json_fast.zig");
pub const Value = std.json.Value;

pub const Span = struct {
    start: usize,
    end: usize,
    pub fn of(self: Span, bytes: []const u8) []const u8 {
        return bytes[self.start..self.end];
    }
};
/// A winner the pool already validated against this request's id: its exact
/// `result` span, and whether the Ethereum header-result check already ran.
pub const Validated = struct { result: Span, header_checked: bool = false, header: ?HeaderFacts = null };
/// The Ethereum header fields the pool's header check already decoded from
/// the result span, present only when number and hash are both known.
pub const HeaderFacts = struct { number: u64, hash: [32]u8, parent_hash: [32]u8, timestamp: u64 };
pub const Kind = enum { string, number, other };
pub const Member = struct { span: Span, kind: Kind };
pub const Name = enum { jsonrpc, id, method, params, result, @"error" };
pub const Top = struct {
    object: bool = false,
    members: [6]?Member = @splat(null),
    /// Deepest container nesting seen (std.json Scanner stack height).
    max_depth: usize = 0,
    pub fn get(self: *const Top, name: Name) ?Member {
        return self.members[@intFromEnum(name)];
    }
};
pub const Options = struct {
    /// json_bounds semantics: fail at the first token deeper than this.
    depth_limit: ?usize = null,
    /// json_bounds-then-parse semantics: a syntax/depth error anywhere wins
    /// over a duplicate key. Otherwise a duplicate fails in document order,
    /// when its value completes, exactly like a single std.json parse.
    defer_duplicates: bool = false,
};
/// serde_json's default container depth, enforced before any DOM work.
pub const max_depth = 128;
pub const pool_options: Options = .{ .depth_limit = max_depth, .defer_duplicates = true };

/// Linear duplicate checks up to this many keys per object (block and receipt
/// objects have ~20-30); larger objects switch to a hash set.
const linear_keys = 32;
const KeySet = std.StringHashMapUnmanaged(void);
const Frame = struct { object: bool, start: usize, keys_start: usize, map: ?*KeySet = null, pending_dup: bool = false };

pub fn scan(gpa: A, input: []const u8, options: Options) !Top {
    var fallback = std.heap.stackFallback(2048, gpa);
    var arena = std.heap.ArenaAllocator.init(fallback.get());
    defer arena.deinit();
    // Valid documents take the fast walker; anything it is unsure of (every
    // error case included) is decided by the std.json walker below.
    if (try fast.scan(arena.allocator(), input, options.depth_limit)) |top| return top;
    return scanStd(arena.allocator(), input, options);
}
/// The std.json-token walker alone (the reference for json_fast).
pub fn scanStd(scratch: A, input: []const u8, options: Options) !Top {
    var arena = std.heap.ArenaAllocator.init(scratch);
    defer arena.deinit();
    var walker: Walker = .{ .input = input, .scratch = arena.allocator(), .scanner = Scanner.initCompleteInput(arena.allocator(), input), .options = options };
    try walker.run();
    return walker.top;
}

const Walker = struct {
    input: []const u8,
    scratch: A,
    scanner: Scanner,
    options: Options,
    top: Top = .{},
    frames: std.ArrayList(Frame) = .empty,
    keys: std.ArrayList([]const u8) = .empty,
    member: ?Name = null,
    member_start: usize = 0,
    duplicate: bool = false,

    fn run(self: *Walker) !void {
        var expect_key = false;
        while (true) {
            if (expect_key) {
                switch (try self.scanner.nextAllocMax(self.scratch, .alloc_if_needed, self.input.len)) {
                    .object_end => {
                        const frame = self.frames.pop().?;
                        self.closed(frame);
                        expect_key = try self.completed(.{ .start = frame.start, .end = self.scanner.cursor }, .other);
                    },
                    .string, .allocated_string => |name| {
                        try self.addKey(name);
                        expect_key = false;
                    },
                    else => unreachable,
                }
                continue;
            }
            const before = self.scanner.cursor;
            const token = try self.scanner.next();
            try self.checkDepth();
            switch (token) {
                .object_begin, .array_begin => {
                    const start = self.valueStart(before);
                    if (self.frames.items.len == 0) self.top.object = token == .object_begin;
                    try self.frames.append(self.scratch, .{ .object = token == .object_begin, .start = start, .keys_start = self.keys.items.len });
                    expect_key = token == .object_begin;
                },
                .array_end => {
                    const frame = self.frames.pop().?;
                    self.closed(frame);
                    expect_key = try self.completed(.{ .start = frame.start, .end = self.scanner.cursor }, .other);
                },
                .number => |text| {
                    const start = self.valueStart(before);
                    const end = @intFromPtr(text.ptr) - @intFromPtr(self.input.ptr) + text.len;
                    expect_key = try self.completed(.{ .start = start, .end = end }, .number);
                },
                .string, .partial_string, .partial_string_escaped_1, .partial_string_escaped_2, .partial_string_escaped_3, .partial_string_escaped_4 => {
                    const start = self.valueStart(before);
                    var part = token;
                    while (part != .string) part = try self.scanner.next();
                    expect_key = try self.completed(.{ .start = start, .end = self.scanner.cursor }, .string);
                },
                .true, .false, .null => {
                    const start = self.valueStart(before);
                    expect_key = try self.completed(.{ .start = start, .end = self.scanner.cursor }, .other);
                },
                .end_of_document => break,
                else => unreachable,
            }
        }
        if (self.duplicate) return error.DuplicateField;
    }

    fn checkDepth(self: *Walker) !void {
        const height = self.scanner.stackHeight();
        if (height > self.top.max_depth) self.top.max_depth = height;
        if (self.options.depth_limit) |limit| if (height > limit) return error.JsonDepthExceeded;
    }

    /// First byte of a value whose token was read starting at `before`.
    fn valueStart(self: *Walker, before: usize) usize {
        var index = before;
        while (index < self.input.len) : (index += 1) switch (self.input[index]) {
            ' ', '\t', '\r', '\n', ':', ',' => {},
            else => break,
        };
        if (self.frames.items.len == 1) self.member_start = index;
        return index;
    }

    /// A complete value in the current container. Returns whether a key follows.
    fn completed(self: *Walker, span: Span, kind: Kind) !bool {
        const parent = if (self.frames.items.len == 0) return false else &self.frames.items[self.frames.items.len - 1];
        if (!parent.object) return false;
        if (parent.pending_dup) return error.DuplicateField;
        if (self.frames.items.len == 1) if (self.member) |name| {
            self.top.members[@intFromEnum(name)] = .{ .span = .{ .start = self.member_start, .end = span.end }, .kind = kind };
            self.member = null;
        };
        return true;
    }

    /// Keys of a finished container never collide with a sibling's keys.
    fn closed(self: *Walker, frame: Frame) void {
        self.keys.shrinkRetainingCapacity(frame.keys_start);
    }

    fn addKey(self: *Walker, name: []const u8) !void {
        const frame = &self.frames.items[self.frames.items.len - 1];
        var duplicate = false;
        if (frame.map) |map| {
            duplicate = (try map.getOrPut(self.scratch, name)).found_existing;
        } else {
            for (self.keys.items[frame.keys_start..]) |existing| if (std.mem.eql(u8, existing, name)) {
                duplicate = true;
                break;
            };
            if (!duplicate) {
                try self.keys.append(self.scratch, name);
                if (self.keys.items.len - frame.keys_start > linear_keys) {
                    const map = try self.scratch.create(KeySet);
                    map.* = .empty;
                    for (self.keys.items[frame.keys_start..]) |existing| try map.put(self.scratch, existing, {});
                    frame.map = map;
                }
            }
        }
        if (duplicate) {
            if (self.options.defer_duplicates) self.duplicate = true else frame.pending_dup = true;
        }
        if (self.frames.items.len == 1) self.member = std.meta.stringToEnum(Name, name);
    }
};

/// `std.json.parseFromSlice(Value, gpa, input, .{ .duplicate_field_behavior =
/// .@"error", .parse_numbers = ... })`, token for token and error for error,
/// except that unescaped strings and numbers borrow `input`: the returned tree
/// must not outlive those bytes.
pub fn parseValue(gpa: A, input: []const u8, parse_numbers: bool) !std.json.Parsed(Value) {
    const arena = try gpa.create(std.heap.ArenaAllocator);
    errdefer gpa.destroy(arena);
    arena.* = .init(gpa);
    errdefer arena.deinit();
    {
        var fallback = std.heap.stackFallback(1024, gpa);
        if (try fast.parse(arena.allocator(), fallback.get(), input, parse_numbers)) |value| return .{ .arena = arena, .value = value };
    }
    _ = arena.reset(.free_all);
    return .{ .arena = arena, .value = try parseStdLeaky(arena.allocator(), gpa, input, parse_numbers) };
}
/// The std.json-token tree builder alone (the reference for json_fast).
pub fn parseStdLeaky(arena: A, gpa: A, input: []const u8, parse_numbers: bool) !Value {
    var scanner = Scanner.initCompleteInput(gpa, input);
    defer scanner.deinit();
    const value = try parseTokens(arena, &scanner, parse_numbers);
    if (try scanner.next() != .end_of_document) unreachable;
    return value;
}

fn parseTokens(allocator: A, source: *Scanner, parse_numbers: bool) !Value {
    // Same grammar as std.json.Value.jsonParse: (.array | .object .string)*
    var stack = std.json.Array.init(allocator);
    defer stack.deinit();
    const max = source.input.len;
    while (true) {
        switch (try source.nextAllocMax(allocator, .alloc_if_needed, max)) {
            .string, .allocated_string => |s| return try complete(&stack, allocator, source, .{ .string = s }) orelse continue,
            .number, .allocated_number => |slice| return try complete(&stack, allocator, source, if (parse_numbers) Value.parseFromNumberSlice(slice) else .{ .number_string = slice }) orelse continue,
            .null => return try complete(&stack, allocator, source, .null) orelse continue,
            .true => return try complete(&stack, allocator, source, .{ .bool = true }) orelse continue,
            .false => return try complete(&stack, allocator, source, .{ .bool = false }) orelse continue,
            .object_begin => switch (try source.nextAllocMax(allocator, .alloc_if_needed, max)) {
                .object_end => return try complete(&stack, allocator, source, .{ .object = std.json.ObjectMap.init(allocator) }) orelse continue,
                .string, .allocated_string => |key| try stack.appendSlice(&.{ .{ .object = std.json.ObjectMap.init(allocator) }, .{ .string = key } }),
                else => unreachable,
            },
            .array_begin => try stack.append(.{ .array = std.json.Array.init(allocator) }),
            .array_end => return try complete(&stack, allocator, source, stack.pop().?) orelse continue,
            else => unreachable,
        }
    }
}

fn complete(stack: *std.json.Array, allocator: A, source: *Scanner, finished: Value) !?Value {
    if (stack.items.len == 0) return finished;
    var value = finished;
    while (true) switch (stack.items[stack.items.len - 1]) {
        .string => |key| {
            _ = stack.pop();
            const object = &stack.items[stack.items.len - 1].object;
            const entry = try object.getOrPut(key);
            if (entry.found_existing) return error.DuplicateField;
            entry.value_ptr.* = value;
            switch (try source.nextAllocMax(allocator, .alloc_if_needed, source.input.len)) {
                .object_end => {
                    value = stack.pop().?;
                    if (stack.items.len == 0) return value;
                },
                .string, .allocated_string => |next_key| {
                    try stack.append(.{ .string = next_key });
                    return null;
                },
                else => unreachable,
            }
        },
        .array => |*array| {
            try array.append(value);
            return null;
        },
        else => unreachable,
    };
}

/// Decoded JSON string `raw` (with quotes) in `buffer`, or null if it does not
/// fit or is not a string.
/// `raw` must be a string token the scanner already validated.
pub fn stringIn(buffer: []u8, raw: []const u8) ?[]const u8 {
    if (raw.len < 2 or raw[0] != '"' or raw[raw.len - 1] != '"') return null;
    const body = raw[1 .. raw.len - 1];
    if (std.mem.indexOfScalar(u8, body, '\\') == null) return body;
    var out: usize = 0;
    var index: usize = 0;
    while (index < body.len) {
        var encoded: [4]u8 = undefined;
        var piece: []const u8 = undefined;
        if (body[index] != '\\') {
            piece = body[index .. index + 1];
            index += 1;
        } else {
            if (index + 1 >= body.len) return null;
            const escape = body[index + 1];
            index += 2;
            piece = switch (escape) {
                '"' => "\"",
                '\\' => "\\",
                '/' => "/",
                'b' => "\x08",
                'f' => "\x0c",
                'n' => "\n",
                'r' => "\r",
                't' => "\t",
                'u' => blk: {
                    var code: u21 = hex4(body, index) orelse return null;
                    index += 4;
                    if (code >= 0xD800 and code <= 0xDBFF) {
                        if (index + 6 > body.len or body[index] != '\\' or body[index + 1] != 'u') return null;
                        const low = hex4(body, index + 2) orelse return null;
                        if (low < 0xDC00 or low > 0xDFFF) return null;
                        index += 6;
                        code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                    } else if (code >= 0xDC00 and code <= 0xDFFF) return null;
                    const len = std.unicode.utf8Encode(code, &encoded) catch return null;
                    break :blk encoded[0..len];
                },
                else => return null,
            };
        }
        if (piece.len > buffer.len - out) return null;
        @memcpy(buffer[out..][0..piece.len], piece);
        out += piece.len;
    }
    return buffer[0..out];
}
fn hex4(text: []const u8, at: usize) ?u21 {
    if (at + 4 > text.len) return null;
    return std.fmt.parseInt(u16, text[at .. at + 4], 16) catch null;
}
pub fn isString(bytes: []const u8, member: Member, expected: []const u8) bool {
    if (member.kind != .string) return false;
    var buffer: [64]u8 = undefined;
    const text = stringIn(&buffer, member.span.of(bytes)) orelse return false;
    return std.mem.eql(u8, text, expected);
}
/// Decoded string member; borrows `bytes` unless it contains escapes (then
/// allocated with `gpa`, and `owned` is set).
pub const Text = struct { text: []const u8, owned: bool };
pub fn stringAlloc(gpa: A, bytes: []const u8, member: Member) !Text {
    std.debug.assert(member.kind == .string);
    const raw = member.span.of(bytes);
    if (std.mem.indexOfScalar(u8, raw, '\\') == null) return .{ .text = raw[1 .. raw.len - 1], .owned = false };
    return .{ .text = try std.json.parseFromSliceLeaky([]const u8, gpa, raw, .{ .allocate = .alloc_always }), .owned = true };
}

/// Response dialects: the pool reports a non-number id as a mismatch; the
/// cooperative replay validators report it as a malformed envelope.
pub const IdDialect = enum { pool, replay };
pub const Response = struct {
    result: ?Span,
    /// Error object tree (parse_numbers=false), present iff `result` is null.
    rpc_error: ?std.json.Parsed(Value),
    pub fn deinit(self: *Response) void {
        if (self.rpc_error) |tree| tree.deinit();
        self.* = undefined;
    }
};
/// Depth bound, syntax and duplicate keys anywhere, then root object,
/// jsonrpc "2.0", exact id, exclusive result/error and error code/message.
/// No result tree is built.
pub fn validateResponse(gpa: A, bytes: []const u8, expected_id: i64, dialect: IdDialect) !Response {
    const top = try scan(gpa, bytes, pool_options);
    if (!top.object) return error.InvalidRpcEnvelope;
    const version = top.get(.jsonrpc) orelse return error.InvalidRpcEnvelope;
    if (!isString(bytes, version, "2.0")) return error.InvalidRpcEnvelope;
    const id = top.get(.id) orelse return error.InvalidRpcEnvelope;
    if (id.kind != .number) return if (dialect == .pool) error.RpcIdMismatch else error.InvalidRpcEnvelope;
    const actual = std.fmt.parseInt(i64, id.span.of(bytes), 10) catch return error.RpcIdMismatch;
    if (actual != expected_id) return error.RpcIdMismatch;
    const result = top.get(.result);
    const rpc_error = top.get(.@"error");
    if ((result == null) == (rpc_error == null)) return error.InvalidRpcEnvelope;
    if (result) |member| return .{ .result = member.span, .rpc_error = null };
    const tree = try parseValue(gpa, rpc_error.?.span.of(bytes), false);
    errdefer tree.deinit();
    if (tree.value != .object) return error.InvalidRpcEnvelope;
    const code = tree.value.object.get("code") orelse return error.InvalidRpcEnvelope;
    const message = tree.value.object.get("message") orelse return error.InvalidRpcEnvelope;
    if (code != .number_string or message != .string) return error.InvalidRpcEnvelope;
    _ = std.fmt.parseInt(i64, code.number_string, 10) catch return error.InvalidRpcEnvelope;
    return .{ .result = null, .rpc_error = tree };
}

/// Structural request checks shared by the pool and the read-only policy.
pub const RequestFacts = struct { method: Member, id: Span, params: ?Span };
pub fn requestFacts(top: *const Top, bytes: []const u8) !RequestFacts {
    if (!top.object) return error.InvalidRpcRequest;
    const version = top.get(.jsonrpc) orelse return error.InvalidRpcRequest;
    const id = top.get(.id) orelse return error.InvalidRpcRequest;
    const method = top.get(.method) orelse return error.InvalidRpcRequest;
    if (!isString(bytes, version, "2.0") or id.kind != .number or method.kind != .string) return error.InvalidRpcRequest;
    return .{ .method = method, .id = id.span, .params = if (top.get(.params)) |params| params.span else null };
}

test {
    _ = @import("json_envelope_differential_test.zig");
}
