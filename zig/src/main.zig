const std = @import("std");
const agents = @import("agents");

pub fn main() !void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const args = try std.process.argsAlloc(allocator);
    if (args.len == 1 or std.mem.eql(u8, args[1], "--help")) {
        try std.fs.File.stdout().writeAll(
            \\Hyperlane Zig agents (experimental)
            \\  hyperlane-zig message-id HEX_MESSAGE
            \\  hyperlane-zig simulate SEED STEPS
            \\  hyperlane-zig shadow CONFIG_JSON
            \\  hyperlane-zig --help
            \\
            \\See docs/zig-agent-rewrite/ for capability and benchmark status.
            \\
        );
        return;
    }
    if (args.len == 3 and std.mem.eql(u8, args[1], "shadow")) {
        const config_bytes = try std.fs.cwd().readFileAlloc(allocator, args[2], 64 * 1024);
        const config = try std.json.parseFromSlice(agents.shadow.Config, allocator, config_bytes, .{});
        var report = try agents.shadow.capture(allocator, config.value);
        defer report.deinit();
        const output = try std.json.Stringify.valueAlloc(allocator, report, .{ .whitespace = .indent_2 });
        try std.fs.File.stdout().writeAll(output);
        try std.fs.File.stdout().writeAll("\n");
        return;
    }
    if (args.len == 4 and std.mem.eql(u8, args[1], "simulate")) {
        const seed = try std.fmt.parseInt(u64, args[2], 0);
        const steps = try std.fmt.parseInt(u64, args[3], 0);
        const result = try agents.simulation.run(seed, steps);
        const output = try std.json.Stringify.valueAlloc(allocator, result, .{});
        try std.fs.File.stdout().writeAll(output);
        try std.fs.File.stdout().writeAll("\n");
        if (!result.delivered) return error.SimulationLivenessFailure;
        return;
    }
    if (args.len == 3 and std.mem.eql(u8, args[1], "message-id")) {
        const hex = if (std.mem.startsWith(u8, args[2], "0x")) args[2][2..] else args[2];
        if (hex.len % 2 != 0) return error.InvalidHexLength;
        const bytes = try allocator.alloc(u8, hex.len / 2);
        _ = try std.fmt.hexToBytes(bytes, hex);
        const message = try agents.protocol.Message.decode(bytes);
        const output = try std.fmt.allocPrint(allocator, "0x{s}\n", .{std.fmt.bytesToHex(message.id(), .lower)});
        try std.fs.File.stdout().writeAll(output);
        return;
    }
    return error.InvalidArguments;
}
