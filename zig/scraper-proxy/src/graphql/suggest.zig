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
pub fn suggestionList(arena: std.mem.Allocator, input: []const u8, options: []const []const u8) ![]const []const u8 {
    const Scored = struct { name: []const u8, distance: usize };
    var scored: std.ArrayList(Scored) = .empty;
    var lexical = try LexicalDistance.init(arena, input);
    const threshold = (input.len * 4) / 10 + 1;
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

const LexicalDistance = struct {
    input: []const u8,
    lower: []const u8,
    rows: [3][]usize,

    fn init(arena: std.mem.Allocator, input: []const u8) !LexicalDistance {
        var rows: [3][]usize = undefined;
        for (&rows) |*r| r.* = try arena.alloc(usize, input.len + 1);
        return .{ .input = input, .lower = try std.ascii.allocLowerString(arena, input), .rows = rows };
    }

    fn measure(self: *LexicalDistance, arena: std.mem.Allocator, option: []const u8, threshold: usize) !?usize {
        if (std.mem.eql(u8, self.input, option)) return 0;
        const option_lower = try std.ascii.allocLowerString(arena, option);
        if (std.mem.eql(u8, self.lower, option_lower)) return 1;
        var a: []const u8 = option_lower;
        var b: []const u8 = self.lower;
        if (a.len < b.len) std.mem.swap([]const u8, &a, &b);
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
