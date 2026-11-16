//! Validating JSON walker for complete input, built for RPC payloads (long
//! ASCII hex strings, short numbers): strings are skipped 16 bytes at a time.
//! It decides only what it is certain std.json would accept. Anything else
//! (malformed input, control bytes, surrogate escapes, escaped object keys,
//! duplicate keys, depth past the bound) returns null, and the caller reruns
//! the std.json path, which owns every error and its precedence. So a valid
//! document gets identical facts/trees, and an invalid one gets identical
//! errors, at the cost of a second pass only on the rare bail.
const std = @import("std");
const A = std.mem.Allocator;
const Value = std.json.Value;
const env = @import("json_envelope.zig");

const linear_keys = 32;
const KeySet = std.StringHashMapUnmanaged(void);
/// Without a caller bound, deeper documents simply take the std path.
const default_depth = 1024;

const Mode = enum { facts, tree };

/// Facts of `input` exactly as `env.scan` would report them, or null.
pub fn scan(scratch: A, input: []const u8, depth_limit: ?usize) !?env.Top {
    var walker: Walker(.facts) = .{ .input = input, .scratch = scratch, .limit = depth_limit orelse default_depth };
    defer walker.deinit();
    if (!try walker.run()) return null;
    return walker.top;
}

/// The tree `env.parseValue` builds (strings/numbers borrowed from `input`,
/// escaped strings decoded into `arena`), or null.
pub fn parse(arena: A, scratch: A, input: []const u8, parse_numbers: bool) !?Value {
    var walker: Walker(.tree) = .{ .input = input, .scratch = scratch, .arena = arena, .parse_numbers = parse_numbers, .limit = default_depth };
    defer walker.deinit();
    if (!try walker.run()) return null;
    return walker.root;
}

fn Walker(comptime mode: Mode) type {
    return struct {
        const Self = @This();
        const Frame = if (mode == .facts) struct { object: bool, start: usize, keys_start: usize, map: ?*KeySet = null } else struct { value: Value, key: ?[]const u8 = null };

        input: []const u8,
        scratch: A,
        arena: A = undefined,
        parse_numbers: bool = false,
        limit: usize,
        i: usize = 0,
        frames: std.ArrayList(Frame) = .empty,
        keys: std.ArrayList([]const u8) = .empty,
        top: env.Top = .{},
        root: Value = .null,
        member: ?env.Name = null,
        member_start: usize = 0,

        fn deinit(self: *Self) void {
            if (mode == .facts) for (self.frames.items) |frame| if (frame.map) |map| {
                map.deinit(self.scratch);
                self.scratch.destroy(map);
            };
            self.frames.deinit(self.scratch);
            self.keys.deinit(self.scratch);
        }

        inline fn ws(self: *Self) void {
            while (self.i < self.input.len) : (self.i += 1) switch (self.input[self.i]) {
                ' ', '\t', '\n', '\r' => {},
                else => return,
            };
        }

        /// Returns false to bail. On success the document had exactly one
        /// value. Iterative: nesting depth never grows the native stack.
        fn run(self: *Self) !bool {
            self.ws();
            var fresh = try self.value() orelse return false;
            while (self.frames.items.len != 0) {
                self.ws();
                if (self.i >= self.input.len) return false;
                const c = self.input[self.i];
                const frame = &self.frames.items[self.frames.items.len - 1];
                const object = if (mode == .facts) frame.object else frame.value == .object;
                const end: u8 = if (object) '}' else ']';
                if (c == end) {
                    self.i += 1;
                    if (!try self.close()) return false;
                    fresh = false;
                    continue;
                }
                if (!fresh) {
                    if (c != ',') return false;
                    self.i += 1;
                    self.ws();
                }
                if (object and !try self.key()) return false;
                fresh = try self.value() orelse return false;
            }
            self.ws();
            return self.i == self.input.len;
        }

        /// One value at `i` (after whitespace). Returns whether it opened a
        /// container (which then expects its first member or its close),
        /// or null to bail. Scalars complete immediately.
        fn value(self: *Self) !?bool {
            if (self.i >= self.input.len) return null;
            const start = self.i;
            if (self.frames.items.len == 1) self.member_start = start;
            switch (self.input[self.i]) {
                '{', '[' => |c| {
                    self.i += 1;
                    if (self.frames.items.len + 1 > self.limit) return null;
                    if (self.frames.items.len == 0 and mode == .facts) self.top.object = c == '{';
                    try self.open(c == '{', start);
                    return true;
                },
                '"' => {
                    const escaped = self.string() orelse return null;
                    const raw = self.input[start..self.i];
                    if (mode == .tree) {
                        const text = if (escaped) try decode(self.arena, raw) else raw[1 .. raw.len - 1];
                        return self.scalar(.{ .string = text }, .{ .start = start, .end = self.i }, .string);
                    }
                    return self.scalar(.null, .{ .start = start, .end = self.i }, .string);
                },
                '-', '0'...'9' => {
                    if (!self.number()) return null;
                    const text = self.input[start..self.i];
                    const parsed: Value = if (mode == .tree) (if (self.parse_numbers) Value.parseFromNumberSlice(text) else .{ .number_string = text }) else .null;
                    return self.scalar(parsed, .{ .start = start, .end = self.i }, .number);
                },
                't' => return self.literal("true", .{ .bool = true }, start),
                'f' => return self.literal("false", .{ .bool = false }, start),
                'n' => return self.literal("null", .null, start),
                else => return null,
            }
        }

        fn literal(self: *Self, comptime word: []const u8, parsed: Value, start: usize) !?bool {
            if (self.input.len - self.i < word.len or !std.mem.eql(u8, self.input[self.i..][0..word.len], word)) return null;
            self.i += word.len;
            return self.scalar(parsed, .{ .start = start, .end = self.i }, .other);
        }

        fn open(self: *Self, object: bool, start: usize) !void {
            if (mode == .facts) {
                try self.frames.append(self.scratch, .{ .object = object, .start = start, .keys_start = self.keys.items.len });
                if (self.frames.items.len > self.top.max_depth) self.top.max_depth = self.frames.items.len;
            } else try self.frames.append(self.scratch, .{ .value = if (object) .{ .object = std.json.ObjectMap.init(self.arena) } else .{ .array = std.json.Array.init(self.arena) } });
        }

        fn close(self: *Self) !bool {
            const frame = self.frames.pop().?;
            if (mode == .facts) {
                if (frame.map) |map| {
                    map.deinit(self.scratch);
                    self.scratch.destroy(map);
                }
                self.keys.shrinkRetainingCapacity(frame.keys_start);
                return self.finished(.null, .{ .start = frame.start, .end = self.i }, .other);
            }
            return self.finished(frame.value, undefined, .other);
        }

        /// A completed scalar: false (not a container), or null to bail.
        fn scalar(self: *Self, parsed: Value, span: env.Span, kind: env.Kind) !?bool {
            return if (try self.finished(parsed, span, kind)) false else null;
        }

        /// A complete value belongs to the innermost open container (or is the root).
        fn finished(self: *Self, parsed: Value, span: env.Span, kind: env.Kind) !bool {
            if (self.frames.items.len == 0) {
                if (mode == .tree) self.root = parsed;
                return true;
            }
            const frame = &self.frames.items[self.frames.items.len - 1];
            if (mode == .facts) {
                if (frame.object and self.frames.items.len == 1) if (self.member) |name| {
                    self.top.members[@intFromEnum(name)] = .{ .span = .{ .start = self.member_start, .end = span.end }, .kind = kind };
                    self.member = null;
                };
                return true;
            }
            switch (frame.value) {
                .object => |*object| {
                    const entry = try object.getOrPut(frame.key.?);
                    if (entry.found_existing) return false;
                    entry.value_ptr.* = parsed;
                    frame.key = null;
                },
                .array => |*array| try array.append(parsed),
                else => unreachable,
            }
            return true;
        }

        /// An object key and its colon. Escaped keys bail (rare; std decodes).
        fn key(self: *Self) !bool {
            if (self.i >= self.input.len or self.input[self.i] != '"') return false;
            const start = self.i;
            if (self.string() orelse return false) return false;
            const name = self.input[start + 1 .. self.i - 1];
            self.ws();
            if (self.i >= self.input.len or self.input[self.i] != ':') return false;
            self.i += 1;
            self.ws();
            const frame = &self.frames.items[self.frames.items.len - 1];
            if (mode == .tree) {
                frame.key = name;
                return true;
            }
            if (frame.map) |map| {
                if ((try map.getOrPut(self.scratch, name)).found_existing) return false;
            } else {
                for (self.keys.items[frame.keys_start..]) |existing| if (std.mem.eql(u8, existing, name)) return false;
                try self.keys.append(self.scratch, name);
                if (self.keys.items.len - frame.keys_start > linear_keys) {
                    const map = try self.scratch.create(KeySet);
                    map.* = .empty;
                    frame.map = map;
                    for (self.keys.items[frame.keys_start..]) |existing| try map.put(self.scratch, existing, {});
                }
            }
            if (self.frames.items.len == 1) self.member = std.meta.stringToEnum(env.Name, name);
            return true;
        }

        /// Skips a string at `i` (the opening quote). Returns whether it had
        /// escapes, or null to bail.
        fn string(self: *Self) ?bool {
            const input = self.input;
            var i = self.i + 1;
            var escaped = false;
            while (true) {
                while (i + 16 <= input.len) {
                    const chunk: @Vector(16, u8) = input[i..][0..16].*;
                    const quote: u16 = @bitCast(chunk == @as(@Vector(16, u8), @splat('"')));
                    const slash: u16 = @bitCast(chunk == @as(@Vector(16, u8), @splat('\\')));
                    const control: u16 = @bitCast(chunk < @as(@Vector(16, u8), @splat(0x20)));
                    const high: u16 = @bitCast(chunk >= @as(@Vector(16, u8), @splat(0x80)));
                    const special = quote | slash | control | high;
                    if (special == 0) {
                        i += 16;
                        continue;
                    }
                    i += @ctz(special);
                    break;
                }
                if (i >= input.len) return null;
                const c = input[i];
                switch (c) {
                    '"' => {
                        self.i = i + 1;
                        return escaped;
                    },
                    '\\' => {
                        if (i + 1 >= input.len) return null;
                        escaped = true;
                        switch (input[i + 1]) {
                            '"', '\\', '/', 'b', 'f', 'n', 'r', 't' => i += 2,
                            'u' => {
                                if (i + 6 > input.len) return null;
                                const code = std.fmt.parseInt(u16, input[i + 2 .. i + 6], 16) catch return null;
                                // Surrogate pairing rules belong to the std path.
                                if (code >= 0xD800 and code <= 0xDFFF) return null;
                                for (input[i + 2 .. i + 6]) |digit| if (!std.ascii.isHex(digit)) return null;
                                i += 6;
                            },
                            else => return null,
                        }
                    },
                    0...0x1F => return null,
                    0x80...0xFF => {
                        const len = std.unicode.utf8ByteSequenceLength(c) catch return null;
                        if (i + len > input.len) return null;
                        _ = std.unicode.utf8Decode(input[i .. i + len]) catch return null;
                        i += len;
                    },
                    else => i += 1,
                }
            }
        }

        /// JSON number grammar at `i`; the caller's structure check rejects a
        /// number not followed by a delimiter.
        fn number(self: *Self) bool {
            const input = self.input;
            var i = self.i;
            if (input[i] == '-') {
                i += 1;
                if (i >= input.len) return false;
            }
            switch (input[i]) {
                '0' => i += 1,
                '1'...'9' => {
                    i += 1;
                    while (i < input.len and std.ascii.isDigit(input[i])) i += 1;
                },
                else => return false,
            }
            if (i < input.len and input[i] == '.') {
                i += 1;
                if (i >= input.len or !std.ascii.isDigit(input[i])) return false;
                while (i < input.len and std.ascii.isDigit(input[i])) i += 1;
            }
            if (i < input.len and (input[i] == 'e' or input[i] == 'E')) {
                i += 1;
                if (i < input.len and (input[i] == '+' or input[i] == '-')) i += 1;
                if (i >= input.len or !std.ascii.isDigit(input[i])) return false;
                while (i < input.len and std.ascii.isDigit(input[i])) i += 1;
            }
            self.i = i;
            return true;
        }
    };
}

/// A validated string token with escapes (no surrogate escapes: those bail).
fn decode(arena: A, raw: []const u8) ![]const u8 {
    const buffer = try arena.alloc(u8, raw.len);
    return env.stringIn(buffer, raw) orelse unreachable;
}
