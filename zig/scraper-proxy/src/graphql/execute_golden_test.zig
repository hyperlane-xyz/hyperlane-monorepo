//! Execution golden cases: field errors at every nesting level (nullable and
//! non-null leaves, list items, root fields), coercion failures, custom
//! scalar pass-through (jsonb with index keys), aliases, fragments,
//! directives and multi-root merging. Expected bodies were produced by the
//! value-tree executor that passed the TS parity suite, before completion
//! switched to writing JSON directly.
const std = @import("std");
const core = @import("core");
const json = core.json;
const parser = @import("parser.zig");
const schema_mod = @import("schema.zig");
const values = @import("values.zig");
const execute = @import("execute.zig");
const route = @import("route.zig");

const Fake = struct {
    rows: json.Value,
    fn resolve(ctx: *anyopaque, _: std.mem.Allocator, info: *const execute.Info, _: json.Value, _: json.Value) std.mem.Allocator.Error!execute.ResolveResult {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        if (!std.mem.eql(u8, info.parent_type.name, "query_root")) return .default;
        if (std.mem.eql(u8, info.field_name, "message_activity")) return .{ .failure = .{ .message = "boom", .code = "X" } };
        return .{ .value = self.rows.get(info.field_name) orelse .null };
    }
};

fn run(a: std.mem.Allocator, schema: *const schema_mod.Schema, query: []const u8, rows: json.Value) ![]const u8 {
    var diag: parser.Diagnostic = .{};
    const doc = try parser.parse(a, query, .{}, &diag);
    var fake: Fake = .{ .rows = rows };
    const coerced = (try values.getVariableValues(a, schema, doc.definitions[0].operation.variable_definitions, null)).coerced;
    var ex = try execute.Executor.init(a, schema, doc, coerced, .{ .ctx = &fake, .resolve = Fake.resolve });
    const result = try ex.executeQuery(doc.definitions[0].operation, null);
    return route.serializeResponse(a, 200, result.data, result.errors);
}

const cases = [_]struct { query: []const u8, body: []const u8 }{
    .{ .query = "{ domain { id name chain_id native_token is_test_net is_deprecated } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"Cannot return null for non-nullable field domain.name.\",\"locations\":[{\"line\":1,\"column\":15}],\"path\":[\"domain\",\"1\",\"name\"]}]}" },
    .{ .query = "{ domain { id chain_id __typename } }", .body = "{\"data\":{\"domain\":[{\"id\":1,\"chain_id\":\"5\",\"__typename\":\"domain\"},{\"id\":2,\"chain_id\":null,\"__typename\":\"domain\"}]}}" },
    .{ .query = "{ domain_by_pk(id: 1) { id } }", .body = "{\"data\":{\"domain_by_pk\":null},\"errors\":[{\"message\":\"Int cannot represent non-integer value: 3.5\",\"locations\":[{\"line\":1,\"column\":25}],\"path\":[\"domain_by_pk\",\"id\"]}]}" },
    .{ .query = "{ domain_by_pk(id: 1) { native_token chain_id } }", .body = "{\"data\":{\"domain_by_pk\":{\"native_token\":\"N\",\"chain_id\":{\"10\":1,\"a\":[1,{\"2\":null}]}}}}" },
    .{ .query = "{ domain_by_pk(id: 1) { id name chain_id is_test_net is_deprecated } }", .body = "{\"data\":{\"domain_by_pk\":null},\"errors\":[{\"message\":\"Int cannot represent non-integer value: 3.5\",\"locations\":[{\"line\":1,\"column\":25}],\"path\":[\"domain_by_pk\",\"id\"]}]}" },
    .{ .query = "{ message_view { id msg_id nonce sender num_payments delivery_latency } }", .body = "{\"data\":{\"message_view\":[{\"id\":\"1\",\"msg_id\":\"0xab\",\"nonce\":null,\"sender\":\"0x\\u0001\\\"q\",\"num_payments\":\"3\",\"delivery_latency\":{\"x\":1}},{\"id\":\"2\",\"msg_id\":null,\"nonce\":12,\"sender\":null,\"num_payments\":null,\"delivery_latency\":null},{\"id\":\"3\",\"msg_id\":null,\"nonce\":null,\"sender\":null,\"num_payments\":null,\"delivery_latency\":null},{\"id\":\"4\",\"msg_id\":null,\"nonce\":0,\"sender\":null,\"num_payments\":null,\"delivery_latency\":null}]},\"errors\":[{\"message\":\"Int cannot represent non 32-bit signed integer value: 4294967296\",\"locations\":[{\"line\":1,\"column\":28}],\"path\":[\"message_view\",\"0\",\"nonce\"]},{\"message\":\"Int cannot represent non-integer value: 1.5\",\"locations\":[{\"line\":1,\"column\":28}],\"path\":[\"message_view\",\"2\",\"nonce\"]}]}" },
    .{ .query = "{ message_view { id is_provisional } }", .body = "{\"data\":{\"message_view\":null},\"errors\":[{\"message\":\"Boolean cannot represent a non boolean value: \\\"no\\\"\",\"locations\":[{\"line\":1,\"column\":21}],\"path\":[\"message_view\",\"2\",\"is_provisional\"]}]}" },
    .{ .query = "{ message_view { id nonce origin_domain_id } }", .body = "{\"data\":{\"message_view\":[{\"id\":\"1\",\"nonce\":null,\"origin_domain_id\":null},{\"id\":\"2\",\"nonce\":12,\"origin_domain_id\":null},{\"id\":\"3\",\"nonce\":null,\"origin_domain_id\":null},{\"id\":\"4\",\"nonce\":0,\"origin_domain_id\":null}]},\"errors\":[{\"message\":\"Int cannot represent non 32-bit signed integer value: 4294967296\",\"locations\":[{\"line\":1,\"column\":21}],\"path\":[\"message_view\",\"0\",\"nonce\"]},{\"message\":\"Int cannot represent non-integer value: 1.5\",\"locations\":[{\"line\":1,\"column\":21}],\"path\":[\"message_view\",\"2\",\"nonce\"]},{\"message\":\"Int cannot represent non 32-bit signed integer value: 2147483648\",\"locations\":[{\"line\":1,\"column\":27}],\"path\":[\"message_view\",\"3\",\"origin_domain_id\"]}]}" },
    .{ .query = "{ a: message_view { id nonce } b: domain_by_pk(id: 1) { native_token } }", .body = "{\"data\":{\"a\":[{\"id\":\"1\",\"nonce\":null},{\"id\":\"2\",\"nonce\":12},{\"id\":\"3\",\"nonce\":null},{\"id\":\"4\",\"nonce\":0}],\"b\":{\"native_token\":\"N\"}},\"errors\":[{\"message\":\"Int cannot represent non 32-bit signed integer value: 4294967296\",\"locations\":[{\"line\":1,\"column\":24}],\"path\":[\"a\",\"0\",\"nonce\"]},{\"message\":\"Int cannot represent non-integer value: 1.5\",\"locations\":[{\"line\":1,\"column\":24}],\"path\":[\"a\",\"2\",\"nonce\"]}]}" },
    .{ .query = "{ a: message_view { id nonce } b: domain { id name } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"Int cannot represent non 32-bit signed integer value: 4294967296\",\"locations\":[{\"line\":1,\"column\":24}],\"path\":[\"a\",\"0\",\"nonce\"]},{\"message\":\"Int cannot represent non-integer value: 1.5\",\"locations\":[{\"line\":1,\"column\":24}],\"path\":[\"a\",\"2\",\"nonce\"]},{\"message\":\"Cannot return null for non-nullable field domain.name.\",\"locations\":[{\"line\":1,\"column\":47}],\"path\":[\"b\",\"1\",\"name\"]}]}" },
    .{ .query = "{ x: domain_by_pk(id: 1) { native_token t: __typename ...F } } fragment F on domain { chain_id native_token }", .body = "{\"data\":{\"x\":{\"native_token\":\"N\",\"t\":\"domain\",\"chain_id\":{\"10\":1,\"a\":[1,{\"2\":null}]}}}}" },
    .{ .query = "{ raw_message_dispatch_by_pk(id: 1) { id msg_id nonce origin_domain destination_domain sender recipient msg_body origin_block_height origin_tx_hash time_created } }", .body = "{\"data\":{\"raw_message_dispatch_by_pk\":null},\"errors\":[{\"message\":\"Int cannot represent non-integer value: \\\"x\\\"\",\"locations\":[{\"line\":1,\"column\":55}],\"path\":[\"raw_message_dispatch_by_pk\",\"origin_domain\"]}]}" },
    .{ .query = "{ message_activity(message_id: \"x\") { id } m: message_view { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"boom\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"message_activity\"],\"extensions\":{\"code\":\"X\"}}]}" },
    .{ .query = "{ m: message_view { id } message_activity(message_id: \"x\") { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"boom\",\"locations\":[{\"line\":1,\"column\":26}],\"path\":[\"message_activity\"],\"extensions\":{\"code\":\"X\"}}]}" },
    .{ .query = "{ __typename domain_by_pk(id: 1) { native_token @include(if: false) chain_id @skip(if: false) } }", .body = "{\"data\":{\"__typename\":\"query_root\",\"domain_by_pk\":{\"chain_id\":{\"10\":1,\"a\":[1,{\"2\":null}]}}}}" },
};

test "execution golden cases" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const schema = schema_mod.testing.scraper();
    const rows_text =
        \\{"domain":[{"id":1,"name":"a","chain_id":"5","native_token":"ETH","is_test_net":false,"is_deprecated":true},{"id":2,"chain_id":null,"native_token":"X","is_test_net":"yes","is_deprecated":false}],
        \\ "domain_by_pk":{"id":3.5,"name":7,"chain_id":{"10":1,"a":[1,{"2":null}]},"native_token":"N","is_test_net":1,"is_deprecated":0},
        \\ "message_view":[{"id":"1","msg_id":"0xab","nonce":4294967296,"is_provisional":false,"num_payments":"3","sender":"0x\u0001\"q","delivery_latency":{"x":1}},
        \\                 {"id":"2","msg_id":null,"nonce":"12","is_provisional":true},
        \\                 {"id":"3","nonce":1.5,"is_provisional":"no"},
        \\                 {"id":"4","nonce":-0,"is_provisional":false,"origin_domain_id":2147483648}],
        \\ "raw_message_dispatch_by_pk":{"id":"9","msg_id":"0x","nonce":true,"origin_domain":"x","destination_domain":1e21,"sender":"s","recipient":"r","msg_body":null,"origin_block_height":"1","origin_tx_hash":"h","time_created":"t"}}
    ;
    const rows = try json.parse(a, rows_text, .{});
    for (cases) |c| try std.testing.expectEqualStrings(c.body, try run(a, schema, c.query, rows));
}
