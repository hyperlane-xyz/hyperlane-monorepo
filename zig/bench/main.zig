//! Kernel benchmarks and differential adapter; no network or production mutations.
const std = @import("std");
const protocol = @import("protocol");
const allocator = std.heap.smp_allocator;

fn emit(comptime format: []const u8, args: anytype) !void {
    const output = try std.fmt.allocPrint(allocator, format, args);
    defer allocator.free(output);
    try std.fs.File.stdout().writeAll(output);
}

fn benchmark(kernel: []const u8, iterations: u32, body_len: usize) !void {
    if (iterations == 0) return error.InvalidIterations;
    const body = try allocator.alloc(u8, body_len);
    defer allocator.free(body);
    for (body, 0..) |*byte, i| byte.* = @truncate(i);
    var message: protocol.Message = .{
        .version = 3,
        .nonce = 0,
        .origin = 1000,
        .sender = .{0x11} ** 32,
        .destination = 2000,
        .recipient = .{0x22} ** 32,
        .body = body,
    };
    var checksum: u64 = 0;
    var tree = protocol.IncrementalMerkle.init();
    var timer = try std.time.Timer.start();
    if (std.mem.eql(u8, kernel, "message_id")) {
        for (0..iterations) |i| {
            message.nonce = @intCast(i);
            std.mem.doNotOptimizeAway(&message);
            const id = message.id();
            std.mem.doNotOptimizeAway(id);
            checksum +%= std.mem.readInt(u64, id[0..8], .big);
        }
    } else if (std.mem.eql(u8, kernel, "message_roundtrip_owned")) {
        for (0..iterations) |i| {
            message.nonce = @intCast(i);
            std.mem.doNotOptimizeAway(&message);
            const encoded = try message.encodeAlloc(allocator);
            defer allocator.free(encoded);
            var decoded = try protocol.Message.decode(encoded);
            // Match Rust's independently owned decoded body, not the borrowed fast path.
            const owned_body = try allocator.dupe(u8, decoded.body);
            defer allocator.free(owned_body);
            decoded.body = owned_body;
            std.mem.doNotOptimizeAway(&decoded);
            const id = decoded.id();
            std.mem.doNotOptimizeAway(id);
            checksum +%= std.mem.readInt(u64, id[0..8], .big);
        }
    } else if (std.mem.eql(u8, kernel, "merkle_ingest") or std.mem.eql(u8, kernel, "merkle_ingest_root")) {
        const each_root = std.mem.eql(u8, kernel, "merkle_ingest_root");
        for (0..iterations) |i| {
            var leaf = [_]u8{0} ** 32;
            std.mem.writeInt(u64, leaf[24..32], @intCast(i), .big);
            std.mem.doNotOptimizeAway(&leaf);
            try tree.ingest(leaf);
            if (each_root) {
                const root = tree.root();
                std.mem.doNotOptimizeAway(root);
                checksum +%= std.mem.readInt(u64, root[0..8], .big);
            }
        }
        if (!each_root) {
            const root = tree.root();
            std.mem.doNotOptimizeAway(root);
            checksum = std.mem.readInt(u64, root[0..8], .big);
        }
    } else return error.UnknownKernel;
    const elapsed_ns = timer.read();
    try emit("{{\"kernel\":\"{s}\",\"iterations\":{d},\"body_len\":{d},\"elapsed_ns\":{d},\"checksum\":\"{x:0>16}\"}}\n", .{ kernel, iterations, body_len, elapsed_ns, checksum });
}

fn vectors() !void {
    const input = try std.fs.File.stdin().readToEndAlloc(allocator, 64 * 1024 * 1024);
    defer allocator.free(input);
    var lines = std.mem.splitScalar(u8, input, '\n');
    var tree = protocol.IncrementalMerkle.init();
    while (lines.next()) |raw_line| {
        // splitScalar produces a trailing empty segment; an empty message is encoded as a blank line.
        if (raw_line.len == 0 and lines.index == null) break;
        const line = std.mem.trim(u8, raw_line, "\r \t");
        const bytes = try allocator.alloc(u8, line.len / 2);
        defer allocator.free(bytes);
        _ = try std.fmt.hexToBytes(bytes, line);
        const message = protocol.Message.decode(bytes) catch {
            try emit("{{\"error\":\"invalid_message\"}}\n", .{});
            continue;
        };
        const id = message.id();
        try tree.ingest(id);
        const root = tree.root();
        const checkpoint: protocol.Checkpoint = .{
            .merkle_tree_hook_address = message.sender,
            .mailbox_domain = message.origin,
            .root = root,
            .index = tree.count - 1,
            .message_id = id,
        };
        const encoded = try message.encodeAlloc(allocator);
        defer allocator.free(encoded);
        const encoded_hex = try allocator.alloc(u8, encoded.len * 2);
        defer allocator.free(encoded_hex);
        const hex_chars = "0123456789abcdef";
        for (encoded, 0..) |byte, i| {
            encoded_hex[2 * i] = hex_chars[byte >> 4];
            encoded_hex[2 * i + 1] = hex_chars[byte & 15];
        }
        try emit("{{\"encoded\":\"{s}\",\"id\":\"{s}\",\"root\":\"{s}\",\"count\":{d},\"signing_hash\":\"{s}\",\"digest\":\"{s}\"}}\n", .{
            encoded_hex, std.fmt.bytesToHex(id, .lower), std.fmt.bytesToHex(root, .lower), tree.count, std.fmt.bytesToHex(checkpoint.signingHash(), .lower), std.fmt.bytesToHex(checkpoint.digest(), .lower),
        });
    }
}

fn cryptoVectors() !void {
    const input = try std.fs.File.stdin().readToEndAlloc(allocator, 1024 * 1024);
    defer allocator.free(input);
    var lines = std.mem.tokenizeAny(u8, input, "\r\n");
    while (lines.next()) |line| {
        var bytes: [129]u8 = undefined;
        const parsed = try std.fmt.hexToBytes(&bytes, line);
        if (parsed.len != 64 and parsed.len != 129) return error.InvalidCryptoVector;
        const key = bytes[0..32].*;
        const digest = bytes[32..64].*;
        const address = try protocol.signature.secretKeyAddress(key);
        const signature = try protocol.signature.signDigest(key, digest, null);
        const external = if (parsed.len == 129) bytes[64..129].* else signature;
        const recovered = protocol.signature.recover(digest, external) catch {
            try emit("{{\"address\":\"{s}\",\"signature\":\"{s}\",\"recovered\":null}}\n", .{ std.fmt.bytesToHex(address, .lower), std.fmt.bytesToHex(signature, .lower) });
            continue;
        };
        try emit("{{\"address\":\"{s}\",\"signature\":\"{s}\",\"recovered\":\"{s}\"}}\n", .{ std.fmt.bytesToHex(address, .lower), std.fmt.bytesToHex(signature, .lower), std.fmt.bytesToHex(recovered, .lower) });
    }
}

pub fn main() !void {
    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);
    if (args.len == 2 and std.mem.eql(u8, args[1], "vectors")) return vectors();
    if (args.len == 2 and std.mem.eql(u8, args[1], "crypto-vectors")) return cryptoVectors();
    if (args.len == 5 and std.mem.eql(u8, args[1], "bench")) {
        return benchmark(args[2], try std.fmt.parseInt(u32, args[3], 10), try std.fmt.parseInt(usize, args[4], 10));
    }
    try std.fs.File.stderr().writeAll("usage: zig-agent-bench vectors | bench KERNEL ITERATIONS BODY_LEN\n");
    std.process.exit(2);
}
