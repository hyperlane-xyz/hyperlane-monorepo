//! graphql-js `didYouMean`, `suggestionList` (LexicalDistance) and `naturalCompare`.
const std = @import("std");

const max_suggestions = 5;

/// Appends graphql-js `didYouMean([sub,] suggestions)` text to `out`.
pub fn didYouMean(arena: std.mem.Allocator, out: *std.ArrayList(u8), sub: ?[]const u8, suggestions: []const []const u8) !void {
    if (suggestions.len == 0) return;
    try out.appendSlice(arena, " Did you mean ");
    if (sub) |s| {
        try out.appendSlice(arena, s);
        try out.append(arena, ' ');
    }
    switch (suggestions.len) {
        1 => try out.print(arena, "\"{s}\"?", .{suggestions[0]}),
        2 => try out.print(arena, "\"{s}\" or \"{s}\"?", .{ suggestions[0], suggestions[1] }),
        else => {
            const selected = suggestions[0..@min(suggestions.len, max_suggestions)];
            for (selected[0 .. selected.len - 1]) |s| try out.print(arena, "\"{s}\", ", .{s});
            try out.print(arena, "or \"{s}\"?", .{selected[selected.len - 1]});
        },
    }
}

/// Options within the lexical-distance threshold, sorted by distance then naturalCompare.
/// Like graphql-js, lengths and edit distances are in UTF-16 code units of the
/// `toLowerCase()`d strings, and the threshold comes from the input's UTF-16 length.
pub fn suggestionList(arena: std.mem.Allocator, input: []const u8, options: []const []const u8) ![]const []const u8 {
    const Scored = struct { name: []const u8, distance: usize };
    var scored: std.ArrayList(Scored) = .empty;
    var lexical = try LexicalDistance.init(arena, input);
    const threshold = (lexical.input_len * 4) / 10 + 1;
    outer: for (options) |option| {
        for (scored.items) |s| if (std.mem.eql(u8, s.name, option)) continue :outer; // object-key dedupe
        if (try lexical.measure(arena, option, threshold)) |distance| {
            try scored.append(arena, .{ .name = option, .distance = distance });
        }
    }
    std.mem.sort(Scored, scored.items, {}, struct {
        fn lessThan(_: void, a: Scored, b: Scored) bool {
            if (a.distance != b.distance) return a.distance < b.distance;
            return naturalCompare(a.name, b.name) < 0;
        }
    }.lessThan);
    const out = try arena.alloc([]const u8, scored.items.len);
    for (scored.items, out) |s, *o| o.* = s.name;
    return out;
}

/// The UTF-16 code units of JS `s.toLowerCase()` for UTF-8 (or WTF-8) `s`, and
/// the UTF-16 length of `s` itself. ASCII is lowered; of the rest only U+0130
/// (to "i\u0307") and U+212A KELVIN SIGN (to "k") lower to ASCII or change
/// length (checked over every code point in Node 26), and schema names are
/// ASCII, so other characters keep their own units: they can never equal an
/// option's.
fn lowerUnits(arena: std.mem.Allocator, s: []const u8) !struct { units: []u16, len: usize } {
    var out: std.ArrayList(u16) = .empty;
    var len: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        const b0 = s[i];
        const n = std.unicode.utf8ByteSequenceLength(b0) catch 1;
        if (n == 1 or i + n > s.len) {
            try out.append(arena, if (b0 < 0x80) std.ascii.toLower(b0) else 0xFFFD);
            len += 1;
            i += 1;
            continue;
        }
        var cp: u21 = switch (n) {
            2 => b0 & 0x1F,
            3 => b0 & 0x0F,
            else => b0 & 0x07,
        };
        for (s[i + 1 .. i + n]) |b| cp = (cp << 6) | (b & 0x3F);
        i += n;
        if (cp >= 0x10000) {
            const v = cp - 0x10000;
            try out.appendSlice(arena, &.{ @intCast(0xD800 + (v >> 10)), @intCast(0xDC00 + (v & 0x3FF)) });
            len += 2;
            continue;
        }
        len += 1;
        switch (cp) {
            0x130 => try out.appendSlice(arena, &.{ 'i', 0x307 }),
            0x212A => try out.append(arena, 'k'),
            else => try out.append(arena, @intCast(cp)),
        }
    }
    return .{ .units = out.items, .len = len };
}

const LexicalDistance = struct {
    input: []const u8,
    /// UTF-16 length of the input (graphql-js `input.length`).
    input_len: usize,
    lower: []const u16,
    rows: [3][]usize,

    fn init(arena: std.mem.Allocator, input: []const u8) !LexicalDistance {
        const lowered = try lowerUnits(arena, input);
        var rows: [3][]usize = undefined;
        for (&rows) |*r| r.* = try arena.alloc(usize, lowered.units.len + 1);
        return .{ .input = input, .input_len = lowered.len, .lower = lowered.units, .rows = rows };
    }

    fn measure(self: *LexicalDistance, arena: std.mem.Allocator, option: []const u8, threshold: usize) !?usize {
        if (std.mem.eql(u8, self.input, option)) return 0;
        const option_lower = (try lowerUnits(arena, option)).units;
        if (std.mem.eql(u16, self.lower, option_lower)) return 1;
        var a: []const u16 = option_lower;
        var b: []const u16 = self.lower;
        if (a.len < b.len) std.mem.swap([]const u16, &a, &b);
        if (a.len - b.len > threshold) return null;
        // Rows are sized for the input; grow when the option is the shorter string.
        if (b.len + 1 > self.rows[0].len) {
            for (&self.rows) |*r| r.* = try arena.alloc(usize, b.len + 1);
        }
        const rows = self.rows;
        for (0..b.len + 1) |j| rows[0][j] = j;
        for (1..a.len + 1) |i| {
            const up = rows[(i - 1) % 3];
            const current = rows[i % 3];
            current[0] = i;
            var smallest = i;
            for (1..b.len + 1) |j| {
                const cost: usize = if (a[i - 1] == b[j - 1]) 0 else 1;
                var cell = @min(up[j] + 1, current[j - 1] + 1, up[j - 1] + cost);
                if (i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]) {
                    cell = @min(cell, rows[(i - 2) % 3][j - 2] + 1);
                }
                if (cell < smallest) smallest = cell;
                current[j] = cell;
            }
            if (smallest > threshold) return null;
        }
        const distance = rows[a.len % 3][b.len];
        return if (distance <= threshold) distance else null;
    }
};

/// graphql-js `naturalCompare` (digit runs compare numerically).
pub fn naturalCompare(a: []const u8, b: []const u8) i64 {
    var ai: usize = 0;
    var bi: usize = 0;
    while (ai < a.len and bi < b.len) {
        var ac = a[ai];
        var bc = b[bi];
        if (std.ascii.isDigit(ac) and std.ascii.isDigit(bc)) {
            var an: u64 = 0;
            while (true) {
                ai += 1;
                an = an *| 10 +| (ac - '0');
                if (ai >= a.len) break;
                ac = a[ai];
                if (!(std.ascii.isDigit(ac) and an > 0)) break;
            }
            var bn: u64 = 0;
            while (true) {
                bi += 1;
                bn = bn *| 10 +| (bc - '0');
                if (bi >= b.len) break;
                bc = b[bi];
                if (!(std.ascii.isDigit(bc) and bn > 0)) break;
            }
            if (an < bn) return -1;
            if (an > bn) return 1;
        } else {
            if (ac < bc) return -1;
            if (ac > bc) return 1;
            ai += 1;
            bi += 1;
        }
    }
    return @as(i64, @intCast(a.len)) - @as(i64, @intCast(b.len));
}

test "suggestion list and didYouMean" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const list = try suggestionList(arena, "domainx", &.{ "domain", "domain_by_pk", "message_view" });
    try std.testing.expectEqual(@as(usize, 1), list.len);
    try std.testing.expectEqualStrings("domain", list[0]);
    var out: std.ArrayList(u8) = .empty;
    try didYouMean(arena, &out, null, &.{ "a", "b", "c", "d", "e", "f" });
    try std.testing.expectEqualStrings(" Did you mean \"a\", \"b\", \"c\", \"d\", or \"e\"?", out.items);
    out.clearRetainingCapacity();
    try didYouMean(arena, &out, "the enum value", &.{ "asc", "desc" });
    try std.testing.expectEqualStrings(" Did you mean the enum value \"asc\" or \"desc\"?", out.items);
    try std.testing.expect(naturalCompare("f2", "f10") < 0);
    try std.testing.expect(naturalCompare("abc", "abe") < 0);
}

test "suggestionList counts UTF-16 units of JS toLowerCase (graphql-js LexicalDistance)" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const enums: []const []const u8 = &.{ "asc", "asc_nulls_first", "asc_nulls_last", "desc", "desc_nulls_first", "desc_nulls_last" };
    const fields: []const []const u8 = &.{ "_and", "_not", "_or", "chain_id", "id", "is_deprecated", "is_test_net", "name", "native_token", "time_created", "time_updated" };
    // Expected lists from graphql-js 16 suggestionList (Node 26).
    const cases = [_]struct { input: []const u8, options: []const []const u8, want: []const []const u8 }{
        // é is one unit (two UTF-8 bytes): one substitution, within the threshold of 2.
        .{ .input = "as\u{E9}", .options = enums, .want = &.{"asc"} },
        .{ .input = "a\u{DF}c", .options = enums, .want = &.{"asc"} },
        // U+0130 lowers to "i\u{307}": one insertion away from "is_test_net".
        .{ .input = "\u{130}S_TEST_NET", .options = fields, .want = &.{"is_test_net"} },
        // KELVIN SIGN lowers to "k": equal once lowered, distance 1.
        .{ .input = "native_to\u{212A}en", .options = fields, .want = &.{"native_token"} },
        // An astral character is two units.
        .{ .input = "i\u{1F600}", .options = fields, .want = &.{"id"} },
        .{ .input = "i\u{1F600}\u{1F600}", .options = fields, .want = &.{} },
        .{ .input = "i\u{E9}\u{E9}", .options = fields, .want = &.{"id"} },
    };
    for (cases) |c| {
        const got = try suggestionList(arena, c.input, c.options);
        std.testing.expectEqual(c.want.len, got.len) catch |err| {
            std.debug.print("input {s}: got {d} suggestions\n", .{ c.input, got.len });
            return err;
        };
        for (c.want, got) |w, g| try std.testing.expectEqualStrings(w, g);
    }
}
