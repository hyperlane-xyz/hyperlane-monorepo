//! decodePairRaw against the tree path fetch() always ran (null checks,
//! validate, decodePair): it may decline, but whatever it decides must equal
//! the tree result, and it never decides where the tree path fails.
const std = @import("std");
const A = std.mem.Allocator;
const receipts = @import("receipts_evm.zig");
const enrich = @import("enrichment.zig");
const envelope = @import("../../net/json_envelope.zig");
const mutate = @import("../../net/json_envelope_differential_test.zig").mutate;

const block_hash = "0x" ++ "ab" ** 32;
const tx_hash = "0x" ++ "cd" ** 32;
const meta: enrich.Meta = .{ .block_number = 0x1b4, .block_hash = .{0xab} ** 32, .tx_hash = .{0} ** 32 ++ .{0xcd} ** 32 };
const log = "{\"address\":\"0x" ++ "11" ** 20 ++ "\",\"topics\":[\"0x" ++ "22" ** 32 ++ "\",\"0x" ++ "33" ** 32 ++ "\"],\"data\":\"0x" ++ "44" ** 64 ++ "\",\"blockNumber\":\"0x1b4\",\"transactionHash\":\"" ++ tx_hash ++ "\",\"transactionIndex\":\"0x3\",\"blockHash\":\"" ++ block_hash ++ "\",\"logIndex\":\"0x7\",\"removed\":false}";

const transactions = [_][]const u8{
    // EIP-1559.
    "{\"blockHash\":\"" ++ block_hash ++ "\",\"blockNumber\":\"0x1b4\",\"from\":\"0x" ++ "aa" ** 20 ++ "\",\"gas\":\"0x5208\",\"gasPrice\":\"0x3b9aca0e\",\"maxFeePerGas\":\"0x77359400\",\"maxPriorityFeePerGas\":\"0x3b9aca00\",\"hash\":\"" ++ tx_hash ++ "\",\"input\":\"0xa9059cbb" ++ "00" ** 12 ++ "bb" ** 20 ++ "\",\"nonce\":\"0x2a\",\"to\":\"0x" ++ "bb" ** 20 ++ "\",\"transactionIndex\":\"0x3\",\"value\":\"0x0\",\"type\":\"0x2\",\"accessList\":[],\"chainId\":\"0x1\",\"v\":\"0x1\",\"r\":\"0x1\",\"s\":\"0x2\",\"yParity\":\"0x1\"}",
    // Legacy contract creation, whitespace, empty input.
    "{ \"hash\" : \"" ++ tx_hash ++ "\",\n \"blockHash\":\"" ++ block_hash ++ "\", \"blockNumber\":\"0x1b4\", \"from\":\"0x" ++ "AA" ** 20 ++ "\", \"gas\":\"0x" ++ "f" ** 64 ++ "\", \"gasPrice\":\"0x1\", \"input\":\"0x\", \"nonce\":\"0x0\", \"to\":null, \"value\":\"0x0\" }",
    // Optional fees present as null.
    "{\"hash\":\"" ++ tx_hash ++ "\",\"blockHash\":\"" ++ block_hash ++ "\",\"blockNumber\":\"0x1b4\",\"from\":\"0x" ++ "aa" ** 20 ++ "\",\"gas\":\"0x1\",\"gasPrice\":null,\"maxFeePerGas\":null,\"maxPriorityFeePerGas\":null,\"input\":\"0x00\",\"nonce\":\"0xffffffffffffffff\",\"to\":\"0x" ++ "bb" ** 20 ++ "\",\"extra\":{\"nested\":[1,2,{\"x\":null}]}}",
};
const receipts_corpus = [_][]const u8{
    "{\"blockHash\":\"" ++ block_hash ++ "\",\"blockNumber\":\"0x1b4\",\"contractAddress\":null,\"cumulativeGasUsed\":\"0x1f4a0\",\"effectiveGasPrice\":\"0x3b9aca0e\",\"from\":\"0x" ++ "aa" ** 20 ++ "\",\"gasUsed\":\"0x5208\",\"logs\":[" ++ log ++ "," ++ log ++ "],\"logsBloom\":\"0x" ++ "00" ** 256 ++ "\",\"status\":\"0x1\",\"to\":\"0x" ++ "bb" ** 20 ++ "\",\"transactionHash\":\"" ++ tx_hash ++ "\",\"transactionIndex\":\"0x3\",\"type\":\"0x2\"}",
    "{\"transactionHash\":\"" ++ tx_hash ++ "\",\"blockHash\":\"" ++ block_hash ++ "\",\"blockNumber\":\"0x1b4\",\"gasUsed\":\"0x0\",\"cumulativeGasUsed\":\"0x1\",\"logs\":[]}",
    "{\"transactionHash\":\"" ++ tx_hash ++ "\",\"blockHash\":\"" ++ block_hash ++ "\",\"blockNumber\":\"0x1b4\",\"gasUsed\":\"0x10\",\"cumulativeGasUsed\":\"0x20\",\"effectiveGasPrice\":null,\"logs\":[" ++ log ++ "]}",
};

/// fetch()'s tree sequence after the RPC: the oracle.
fn treePath(a: A, t: []const u8, r: []const u8) !enrich.OwnedTxn {
    var tx = try envelope.parseValue(a, t, true);
    defer tx.deinit();
    var receipt = try envelope.parseValue(a, r, true);
    defer receipt.deinit();
    if (tx.value == .null) return error.ScraperTransactionUnavailable;
    if (receipt.value == .null) return error.ScraperReceiptUnavailable;
    return receipts.decodePair(a, meta, tx.value, receipt.value);
}

const Counts = struct { decided: usize = 0, total: usize = 0 };
fn check(a: A, t: []const u8, r: []const u8, counts: *Counts) !void {
    counts.total += 1;
    var raw = try receipts.decodePairRaw(a, meta, t, r);
    defer if (raw) |*value| value.deinit();
    var tree = treePath(a, t, r) catch |err| {
        if (err == error.OutOfMemory) return err;
        if (raw != null) {
            std.debug.print("raw decided where the tree path fails ({s}):\n{s}\n{s}\n", .{ @errorName(err), t, r });
            return error.TestUnexpectedResult;
        }
        return;
    };
    defer tree.deinit();
    const decided = raw orelse return;
    counts.decided += 1;
    var expected = tree.value;
    var actual = decided.value;
    try std.testing.expectEqualSlices(u8, expected.raw_input.?, actual.raw_input.?);
    expected.raw_input = null;
    actual.raw_input = null;
    try std.testing.expectEqualDeep(expected, actual);
}

fn replaceOnce(a: A, source: []const u8, from: []const u8, to: []const u8) !?[]u8 {
    const at = std.mem.indexOf(u8, source, from) orelse return null;
    return try std.mem.concat(a, u8, &.{ source[0..at], to, source[at + from.len ..] });
}

test "raw receipt decoding decides the corpus exactly as the tree path" {
    const a = std.testing.allocator;
    var counts: Counts = .{};
    for (transactions) |t| for (receipts_corpus) |r| try check(a, t, r, &counts);
    try std.testing.expectEqual(counts.total, counts.decided);
    // Unavailable results are the tree path's errors.
    try check(a, "null", receipts_corpus[0], &counts);
    try check(a, transactions[0], "null", &counts);
}

test "raw receipt decoding on targeted edits declines or matches" {
    const a = std.testing.allocator;
    const edits = [_][2][]const u8{
        .{ "\"0x5208\"", "\"\\u0030x5208\"" }, // escaped quantity
        .{ "\"0x5208\"", "21000" }, // number-typed
        .{ "\"0x5208\"", "null" },
        .{ "\"0x5208\"", "\"0x05208\"" }, // leading zero
        .{ "\"0x2a\"", "\"0x02a\"" },
        .{ "\"0x2a\"", "\"0x2a\",\"nonce\":\"0x2a\"" }, // duplicate top-level key
        .{ "\"removed\":false", "\"removed\":false,\"removed\":false" }, // duplicate inside logs
        .{ "\"input\":\"0xa9", "\"input\":\"0xa" }, // odd-length input
        .{ "\"input\":\"0x\"", "\"input\":\"0\"" },
        .{ "\"input\":\"0x00\"", "\"input\":\"0xzz\"" },
        .{ "\"to\":null", "\"to\":false" },
        .{ "\"to\":null", "\"too\":null" }, // missing `to`
        .{ "\"to\":\"0x", "\"to\":\"0x00" },
        .{ "\"gasPrice\":null", "\"gasPrice\":\"\"" },
        .{ "\"gasPrice\":null", "\"gasPrice\":{}" },
        .{ "\"blockNumber\":\"0x1b4\"", "\"blockNumber\":\"0x1b5\"" }, // identity mismatch
        .{ "\"blockHash\":\"0xab", "\"blockHash\":\"0xAc" },
        .{ "\"hash\":\"0xcd", "\"hash\":\"0xce" },
        .{ "\"transactionHash\":\"0xcd", "\"transactionHash\":\"0xdd" },
        .{ "\"transactionHash\":\"0xcd", "\"transactionHash\":\"\\u0030xcd" },
        .{ "\"effectiveGasPrice\":null", "\"effectiveGasPrice\":\"0x0\"" },
        .{ "\"effectiveGasPrice\":\"0x3b9aca0e\"", "\"effectiveGasPrice\":1" },
        .{ "\"gasUsed\"", "\"g\\u0061sUsed\"" }, // escaped key
        .{ "\"cumulativeGasUsed\":\"0x1f4a0\"", "\"cumulativeGasUsed\":\"0x\"" },
        .{ "\"from\":\"0x", "\"from\":\"0x0" },
        .{ "{", "[" },
    };
    var counts: Counts = .{};
    for (edits) |edit| for (transactions) |t| for (receipts_corpus) |r| {
        if (try replaceOnce(a, t, edit[0], edit[1])) |edited| {
            defer a.free(edited);
            try check(a, edited, r, &counts);
        }
        if (try replaceOnce(a, r, edit[0], edit[1])) |edited| {
            defer a.free(edited);
            try check(a, t, edited, &counts);
        }
    };
    try std.testing.expect(counts.total > 100);
    // Edits that keep the pair valid (e.g. effectiveGasPrice null -> 0x0) still decide.
    try std.testing.expect(counts.decided > 0);
}

test "raw receipt decoding on seeded mutations declines or matches" {
    const a = std.testing.allocator;
    var prng = std.Random.DefaultPrng.init(0x5eed_4ec3_1970_0002);
    const random = prng.random();
    var buffer: std.ArrayList(u8) = .empty;
    defer buffer.deinit(a);
    var counts: Counts = .{};
    for (0..4000) |round| {
        const t = transactions[random.uintLessThan(usize, transactions.len)];
        const r = receipts_corpus[random.uintLessThan(usize, receipts_corpus.len)];
        try mutate(random, if (round % 2 == 0) t else r, &buffer, a);
        if (round % 2 == 0) try check(a, buffer.items, r, &counts) else try check(a, t, buffer.items, &counts);
    }
    try std.testing.expect(counts.decided > 50);
}

test "raw receipt decoding frees everything on allocation failure" {
    const run = struct {
        fn run(a: A) !void {
            var decoded = (try receipts.decodePairRaw(a, meta, transactions[0], receipts_corpus[0])).?;
            decoded.deinit();
        }
    }.run;
    try std.testing.checkAllAllocationFailures(std.testing.allocator, run, .{});
}
