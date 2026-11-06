//! Radix transaction enrichment. Sender is the first static CALL_METHOD fee
//! lock; recipient is the first component in affected_global_entities. Preserve
//! source's cumulative_gas_used=gas_price assignment for database parity.
const std = @import("std");
const enrich = @import("enrichment.zig");
const src = @import("source.zig");
const common = @import("receipts_common.zig");
const provider = @import("../../radix/provider.zig");
const address = @import("../../radix/address.zig");
const json = @import("../../cosmos/types.zig");
const V = std.json.Value;
const Token = struct { text: []const u8, string: bool = false };
fn tokenize(a: std.mem.Allocator, text: []const u8) ![]Token {
    if (text.len > 4 * 1024 * 1024 or !std.unicode.utf8ValidateSlice(text)) return error.InvalidRadixManifest;
    var tokens: std.ArrayList(Token) = .empty;
    var at: usize = 0;
    while (at < text.len) {
        const char = text[at];
        if (std.ascii.isWhitespace(char)) {
            at += 1;
            continue;
        }
        if (char == '#') {
            while (at < text.len and text[at] != '\n') at += 1;
            continue;
        }
        if (tokens.items.len == 262144) return error.RadixManifestTokenLimit;
        const start = at;
        if (char == '"') {
            at += 1;
            while (at < text.len and text[at] != '"') {
                if (text[at] == '\\') at += 1;
                if (at >= text.len) return error.InvalidRadixManifest;
                at += 1;
            }
            if (at == text.len) return error.InvalidRadixManifest;
            at += 1;
            const raw = text[start + 1 .. at - 1];
            const decoded = if (std.mem.indexOfScalar(u8, raw, '\\') == null) raw else (try std.json.parseFromSlice([]const u8, a, text[start..at], .{ .allocate = .alloc_always })).value;
            try tokens.append(a, .{ .text = decoded, .string = true });
        } else if (std.ascii.isAlphabetic(char)) {
            at += 1;
            while (at < text.len and (std.ascii.isAlphanumeric(text[at]) or text[at] == '_' or text[at] == ':')) at += 1;
            try tokens.append(a, .{ .text = text[start..at] });
        } else if (std.ascii.isDigit(char) or char == '-') {
            at += 1;
            while (at < text.len and std.ascii.isDigit(text[at])) at += 1;
            if (at == start + @intFromBool(char == '-')) return error.InvalidRadixManifest;
            const digits = text[start..at];
            const suffix_start = at;
            while (at < text.len and std.ascii.isAlphanumeric(text[at])) at += 1;
            const suffix = text[suffix_start..at];
            const kinds = [_][]const u8{ "u8", "u16", "u32", "u64", "u128", "i8", "i16", "i32", "i64", "i128" };
            var valid = false;
            inline for (kinds) |kind| if (std.mem.eql(u8, suffix, kind)) {
                _ = try std.fmt.parseInt(if (kind[0] == 'u') std.meta.Int(.unsigned, std.fmt.parseInt(u8, kind[1..], 10) catch unreachable) else std.meta.Int(.signed, std.fmt.parseInt(u8, kind[1..], 10) catch unreachable), digits, 10);
                valid = true;
            };
            if (!valid) return error.InvalidRadixManifest;
            try tokens.append(a, .{ .text = text[start..at] });
        } else if (std.mem.indexOfScalar(u8, "()<>,;", char) != null) {
            at += 1;
            try tokens.append(a, .{ .text = text[start..at] });
        } else if (char == '=' and at + 1 < text.len and text[at + 1] == '>') {
            at += 2;
            try tokens.append(a, .{ .text = text[start..at] });
        } else return error.InvalidRadixManifest;
    }
    return tokens.toOwnedSlice(a);
}
fn is(token: Token, text: []const u8) bool {
    return !token.string and std.mem.eql(u8, token.text, text);
}
pub fn feePayer(a: std.mem.Allocator, network: address.Network, manifest: []const u8) !?[32]u8 {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const tokens = tokenize(arena.allocator(), manifest) catch |err| {
        if (err == error.OutOfMemory) return err;
        return null;
    };
    var at: usize = 0;
    while (at < tokens.len) {
        const start = at;
        var depth: usize = 0;
        while (at < tokens.len) : (at += 1) {
            if (is(tokens[at], "(")) depth += 1;
            if (is(tokens[at], ")")) {
                if (depth == 0) break;
                depth -= 1;
            }
            if (is(tokens[at], ";") and depth == 0) break;
        }
        const end = at;
        if (at == tokens.len) break;
        at += 1;
        if (end - start < 6) continue;
        const t = tokens[start..end];
        if (!is(t[0], "CALL_METHOD") or !is(t[1], "Address") or !is(t[2], "(") or !t[3].string or !is(t[4], ")") or !t[5].string or !std.mem.startsWith(u8, t[5].text, "lock_fee")) continue;
        const value = decodeNode(network, t[3].text) catch continue;
        return value;
    }
    return null;
}
fn decodeNode(network: address.Network, text: []const u8) ![32]u8 {
    const split = std.mem.lastIndexOfScalar(u8, text, '1') orelse return error.InvalidRadixAddress;
    var prefix_buffer: [85]u8 = undefined;
    const suffix = try std.fmt.bufPrint(&prefix_buffer, "_{s}", .{network.suffix});
    if (!std.mem.endsWith(u8, text[0..split], suffix)) return error.WrongRadixAddressNetwork;
    const module = text[0 .. split - suffix.len];
    var bytes: [30]u8 = undefined;
    const decoded = try address.decode(network, module, text, &bytes);
    if (decoded.len != 30) return error.InvalidRadixAddress;
    return address.h256(bytes);
}
fn heightHash(height: u64) [32]u8 {
    var out: [32]u8 = .{0} ** 32;
    std.mem.writeInt(u64, out[24..], height, .big);
    return out;
}
pub fn decode(a: std.mem.Allocator, meta: enrich.Meta, value: V, network: address.Network) !enrich.OwnedTxn {
    if (!std.mem.allEqual(u8, meta.tx_hash[0..32], 0) or !std.mem.eql(u8, &heightHash(meta.block_number), &meta.block_hash)) return error.ScraperReceiptIdentityMismatch;
    const tx = try json.field(value, "transaction");
    if (try json.uint(try json.field(tx, "state_version")) != meta.block_number) return error.ScraperReceiptIdentityMismatch;
    var hash: [32]u8 = undefined;
    const decoded_hash = try address.decode(network, "txid", try json.string(try json.field(tx, "intent_hash")), &hash);
    if (decoded_hash.len != 32 or !std.mem.eql(u8, decoded_hash, meta.tx_hash[32..])) return error.ScraperReceiptIdentityMismatch;
    const receipt = try json.field(tx, "receipt");
    const summary = try json.field(receipt, "fee_summary");
    const gas = try std.math.add(u64, try json.uint(try json.field(summary, "execution_cost_units_consumed")), try json.uint(try json.field(summary, "finalization_cost_units_consumed")));
    const paid = try @import("../../radix/events.zig").decimalAttos(try json.string(try json.field(tx, "fee_paid")));
    const price: u256 = if (gas == 0 or paid <= 0) 0 else @as(u256, @intCast(paid)) / gas;
    const sender = try feePayer(a, network, try json.string(try json.field(tx, "manifest_instructions"))) orelse [_]u8{0} ** 32;
    var recipient: ?[32]u8 = null;
    const affected = if (tx == .object) tx.object.get("affected_global_entities") else null;
    if (affected) |entities| if (entities != .null) {
        if (entities != .array) return error.InvalidRadixAffectedEntities;
        for (entities.array.items) |entity| {
            const text = try json.string(entity);
            if (!std.mem.startsWith(u8, text, "component_")) continue;
            recipient = decodeNode(network, text) catch continue;
            break;
        }
    };
    return .{ .arena = std.heap.ArenaAllocator.init(a), .value = .{ .hash = meta.tx_hash, .block_hash = meta.block_hash, .block_number = meta.block_number, .gas_limit = gas, .gas_price = price, .effective_gas_price = price, .nonce = 0, .sender = sender, .recipient = recipient, .gas_used = gas, .cumulative_gas_used = price } };
}
pub const Radix = struct {
    client: provider.Client,
    http_owner: *@import("../../cloud/http.zig").HttpTransport,
    allow_std_fixture: bool = false,
    pub fn interface(self: *Radix) enrich.Fetcher {
        return .{ .context = self, .fetch_fn = fetch, .header_fn = header };
    }
    fn fetch(context: *anyopaque, a: std.mem.Allocator, meta: enrich.Meta, deadline: u64) !enrich.OwnedTxn {
        const self: *Radix = @ptrCast(@alignCast(context));
        if (!std.mem.allEqual(u8, meta.tx_hash[0..32], 0)) return error.UnsupportedReceiptTransactionHash;
        var transport: common.DeadlineTransport = .{ .rpc_read = true, .owner = self.http_owner, .deadline_ns = deadline, .allow_std_fixture = self.allow_std_fixture };
        const saved = self.client.transport;
        try transport.verify(saved);
        self.client.transport = transport.interface();
        defer self.client.transport = saved;
        var response = try self.client.committed(meta.tx_hash[32..64].*);
        defer response.deinit();
        _ = try common.milliseconds(deadline);
        return decode(a, meta, response.value(), self.client.network);
    }
    fn header(context: *anyopaque, meta: enrich.Meta, deadline: u64) !src.Header {
        const self: *Radix = @ptrCast(@alignCast(context));
        if (!std.mem.eql(u8, &heightHash(meta.block_number), &meta.block_hash)) return error.ScraperReceiptIdentityMismatch;
        var transport: common.DeadlineTransport = .{ .rpc_read = true, .owner = self.http_owner, .deadline_ns = deadline, .allow_std_fixture = self.allow_std_fixture };
        const saved = self.client.transport;
        try transport.verify(saved);
        self.client.transport = transport.interface();
        defer self.client.transport = saved;
        var response = try self.client.call(self.client.gateway, "/stream/transactions", .{ .at_ledger_state = .{ .state_version = meta.block_number }, .limit_per_page = 1 });
        defer response.deinit();
        const state = try json.field(response.value(), "ledger_state");
        if (!std.mem.eql(u8, try json.string(try json.field(state, "network")), self.client.network.logical_name)) return error.WrongRadixNetwork;
        const ledger = try json.uint(try json.field(state, "state_version"));
        if (ledger != meta.block_number) return error.ScraperReceiptIdentityMismatch;
        const timestamp = try json.string(try json.field(try json.field(response.value(), "ledger_state"), "proposer_round_timestamp"));
        return .{ .height = ledger, .hash = meta.block_hash, .timestamp = try @import("time.zig").rfc3339(timestamp) };
    }
};

test "scraper Radix fee payer matches pinned actual SDK manifest parser for comments escapes and injection" {
    const a = std.testing.allocator;
    var fixture = try @import("../../testing/fixture.zig").parse(V, a, @embedFile("fixtures/radix-receipt-manifests.json.gz"), .{});
    defer fixture.deinit();
    const cases = try json.field(fixture.value, "cases");
    for (cases.array.items) |case| {
        const actual = try feePayer(a, .mainnet, try json.string(try json.field(case, "manifest")));
        const expected = try json.field(case, "sender");
        if (expected == .null) try std.testing.expectEqual(@as(?[32]u8, null), actual) else {
            var bytes: [30]u8 = undefined;
            _ = try std.fmt.hexToBytes(&bytes, try json.string(expected));
            try std.testing.expectEqual(address.h256(bytes), actual.?);
        }
    }
}

test "scraper Radix receipt preserves manifest sender primary component atto fee and source cumulative field" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const fixture = try @import("../../testing/fixture.zig").parse(V, a, @embedFile("fixtures/radix-receipt-manifests.json.gz"), .{});
    const account = try json.string(try json.field(fixture.value, "account_text"));
    const component = try json.string(try json.field(fixture.value, "component_text"));
    const manifest = try std.fmt.allocPrint(a, "CALL_METHOD Address(\"{s}\") \"lock_fee\" Decimal(\"1.5\");", .{account});
    const hash = [_]u8{3} ** 32;
    var hash_text: [160]u8 = undefined;
    const intent = try address.encode(.mainnet, "txid", &hash, &hash_text);
    const body = try std.json.Stringify.valueAlloc(a, .{ .transaction = .{ .state_version = 100, .intent_hash = intent, .manifest_instructions = manifest, .affected_global_entities = [_][]const u8{ account, component }, .fee_paid = "1.5", .receipt = .{ .fee_summary = .{ .execution_cost_units_consumed = 20, .finalization_cost_units_consumed = 3 } } } }, .{});
    const parsed = try std.json.parseFromSlice(V, a, body, .{});
    const meta: enrich.Meta = .{ .block_number = 100, .block_hash = heightHash(100), .tx_hash = .{0} ** 32 ++ hash };
    var result = try decode(a, meta, parsed.value, .mainnet);
    defer result.deinit();
    try std.testing.expectEqual(try decodeNode(.mainnet, account), result.value.sender);
    try std.testing.expectEqual(try decodeNode(.mainnet, component), result.value.recipient.?);
    try std.testing.expectEqual(@as(u256, 23), result.value.gas_limit);
    try std.testing.expectEqual(@as(?u256, 1500000000000000000 / 23), result.value.gas_price);
    try std.testing.expectEqual(result.value.gas_price.?, result.value.cumulative_gas_used);
}
