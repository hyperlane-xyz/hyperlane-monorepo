const std = @import("std");
const http = @import("../http.zig");
const api = @import("api.zig");
const relay_api = @import("relay_api.zig");
const relay_policy = @import("../../agents/relay_policy.zig");
const runtime_denylist = @import("../runtime_denylist.zig");
const protocol = @import("../../protocol/root.zig");
const A = std.mem.Allocator;

pub const TestRequest = struct {
    value: http.Request,
    storage: []u8,
    headers: []http.Header,

    pub fn init(a: A, method: []const u8, target: []const u8, body: []const u8) !TestRequest {
        const head = try std.fmt.allocPrint(a, "{s} {s} HTTP/1.1\r\nHost: fixture\r\nOrigin: https://nexus.hyperlane.xyz\r\nContent-Type: application/json\r\nAccess-Control-Request-Method: GET\r\nContent-Length: {d}\r\n\r\n", .{ method, target, body.len });
        defer a.free(head);
        const storage = try a.alloc(u8, head.len + body.len);
        errdefer a.free(storage);
        @memcpy(storage[0..head.len], head);
        @memcpy(storage[head.len..], body);
        const headers = try a.alloc(http.Header, 4);
        errdefer a.free(headers);
        const method_end = std.mem.indexOfScalar(u8, storage, ' ').?;
        const target_start = method_end + 1;
        const target_end = target_start + target.len;
        const target_text = storage[target_start..target_end];
        const query = std.mem.indexOfScalar(u8, target_text, '?');
        headers[0] = .{ .name = "Host", .value = "fixture" };
        headers[1] = .{ .name = "Content-Type", .value = "application/json" };
        headers[2] = .{ .name = "Origin", .value = "https://nexus.hyperlane.xyz" };
        headers[3] = .{ .name = "Access-Control-Request-Method", .value = "GET" };
        return .{
            .value = .{
                .allocator = a,
                .storage = storage,
                .header_storage = headers,
                .method = storage[0..method_end],
                .target = target_text,
                .path = if (query) |index| target_text[0..index] else target_text,
                .query = if (query) |index| target_text[index + 1 ..] else null,
                .version = .http_1_1,
                .headers = headers,
                .body = storage[head.len..],
            },
            .storage = storage,
            .headers = headers,
        };
    }
    pub fn deinit(self: *TestRequest) void {
        const a = self.value.allocator;
        a.free(self.storage);
        a.free(self.headers);
    }
};

pub const FixtureContext = struct { byte: u8 = 0 };

pub fn admin(
    context: *anyopaque,
    policy: *relay_policy.Policy,
    denylist: *runtime_denylist.RuntimeDenylist,
    clock: runtime_denylist.Clock,
) api.Admin {
    return .{
        .messages = .{
            .context = context,
            .contains_fn = contains,
            .list_fn = listMessages,
            .insert_fn = insertMessage,
            .by_id_fn = messageById,
        },
        .merkle = .{
            .context = context,
            .contains_chain = contains,
            .list_fn = listMerkle,
            .insert_fn = insertMerkle,
        },
        .proofs = .{ .context = context, .contains_fn = contains, .proof_fn = proof },
        .queue = .{ .context = context, .render_fn = renderQueue },
        .retry = .{ .context = context, .retry_fn = retry },
        .policy = policy,
        .origin_signers = .{ .context = context, .lookup_fn = signers },
        .reprocess = .{ .context = context, .enqueue_fn = enqueue },
        .gas = .{ .context = context, .add_fn = addGas, .list_fn = listGas, .remove_fn = removeGas },
        .denylist = denylist,
        .denylist_clock = clock,
        .denylist_refresh = .{ .context = context, .bind_fn = bindCancel, .unbind_fn = unbindCancel },
        .nonce = .{ .context = context, .contains_fn = contains, .overwrite_fn = overwriteNonce },
        .environment = .{ .context = context, .get_fn = getEnv, .set_fn = setEnv },
    };
}

pub const fixture_message: protocol.Message = .{
    .version = 3,
    .nonce = 10,
    .origin = 1,
    .sender = @splat(1),
    .destination = 2,
    .recipient = @splat(2),
    .body = &.{ 3, 4 },
};

fn contains(context: *anyopaque, domain: u32) bool {
    _ = context;
    return domain == 1;
}

fn listMessages(context: *anyopaque, a: A, _: u32, start: u32, end: u32, cancel: *const std.atomic.Value(bool)) anyerror!api.MessageList {
    _ = context;
    if (cancel.load(.acquire)) return error.Cancelled;
    if (start > fixture_message.nonce or end < fixture_message.nonce) return .{};
    const messages = try a.alloc(protocol.Message, 1);
    messages[0] = fixture_message;
    messages[0].body = try a.dupe(u8, fixture_message.body);
    return .{ .messages = messages };
}

fn insertMessage(_: *anyopaque, _: api.MessageInput, _: *const std.atomic.Value(bool)) anyerror!void {}

fn messageById(context: *anyopaque, a: A, _: u32, id: [32]u8, _: *const std.atomic.Value(bool)) anyerror!?protocol.Message {
    _ = context;
    if (!std.mem.eql(u8, &id, &fixture_message.id())) return null;
    const message = try a.alloc(u8, fixture_message.body.len);
    @memcpy(message, fixture_message.body);
    var result = fixture_message;
    result.body = message;
    return result;
}

fn listMerkle(context: *anyopaque, a: A, _: u32, start: u32, end: u32, _: *const std.atomic.Value(bool)) anyerror!api.MerkleList {
    _ = context;
    if (start != 0 or end != 0) return .{};
    const rows = try a.alloc(api.MerkleInsertion, 1);
    rows[0] = .{ .insertion_block_number = 20, .leaf_index = 0, .message_id = fixture_message.id() };
    return .{ .insertions = rows };
}

fn insertMerkle(_: *anyopaque, _: api.MerkleInput, _: *const std.atomic.Value(bool)) anyerror!void {}

fn proof(_: *anyopaque, _: u32, _: u32, _: u32, _: *const std.atomic.Value(bool)) anyerror!protocol.Proof {
    return error.UnknownMerkleLeaf;
}

fn renderQueue(_: *anyopaque, a: A, domain: u32, _: *const std.atomic.Value(bool)) anyerror!http.Response {
    const body = if (domain != 1) try std.fmt.allocPrint(a, "No queue found for domain {d}", .{domain}) else try a.dupe(u8, "[\n  {\n    \"id\": \"0x01\",\n    \"operation\": {\"retry_count\":0}\n  }\n]");
    defer a.free(body);
    return http.Response.init(a, 200, &.{.{ .name = "content-type", .value = "text/plain; charset=utf-8" }}, body);
}

fn retry(_: *anyopaque, _: A, _: []const u8, _: @import("../../settings/types.zig").MatchingList, _: *const std.atomic.Value(bool)) anyerror!api.RetryResult {
    return .{ .evaluated = 3, .matched = 2, .failed = 0 };
}

fn signers(_: *anyopaque, _: std.mem.Allocator, _: [32]u8, _: *const std.atomic.Value(bool)) anyerror![]const [32]u8 {
    return &.{};
}

fn enqueue(_: *anyopaque, a: A, _: protocol.Message, _: *const std.atomic.Value(bool)) anyerror![]u8 {
    return a.dupe(u8, "PendingMessage { fixture }");
}

fn addGas(_: *anyopaque, _: A, _: api.GasRule, _: *const std.atomic.Value(bool)) anyerror!void {}
fn listGas(context: *anyopaque, a: A, _: *const std.atomic.Value(bool)) anyerror![]api.GasDomainRules {
    _ = context;
    const domains = try a.alloc(api.GasDomainRules, 1);
    const rules = try a.alloc(api.GasRule, 1);
    rules[0] = .{ .policy = .none, .matching_list = &.{} };
    domains[0] = .{ .domain = "ethereum", .rules = rules };
    return domains;
}
fn removeGas(_: *anyopaque, _: usize, _: *const std.atomic.Value(bool)) anyerror!void {}
fn overwriteNonce(_: *anyopaque, _: u32, _: ?u64, _: *const std.atomic.Value(bool)) anyerror!void {}
fn bindCancel(_: *anyopaque, _: *const std.atomic.Value(bool)) !void {}
fn unbindCancel(_: *anyopaque, _: *const std.atomic.Value(bool)) void {}
fn getEnv(_: *anyopaque, _: A, _: []const u8, _: *const std.atomic.Value(bool)) anyerror!api.EnvironmentValue {
    return .{ .value = "fixture" };
}
fn setEnv(_: *anyopaque, _: A, _: []const u8, _: ?[]const u8, _: *const std.atomic.Value(bool)) anyerror!api.EnvironmentValue {
    return .absent;
}
