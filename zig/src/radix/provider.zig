//! Source-backed Radix Core/Gateway REST routes. Transport injection keeps chain
//! semantics in Zig and makes endpoint headers/deadlines explicit. Responses
//! retain ownership until deinit; preview output uses Scrypto SBOR, not JSON RPC.
const std = @import("std");
const http = @import("../cloud/http.zig");
const curl = @import("../net/curl.zig");
const json = @import("../cosmos/types.zig");
const address = @import("address.zig");
const sbor = @import("sbor.zig");
const tx = @import("transaction.zig");
pub const Endpoint = struct { url: []const u8, headers: []const http.Header = &.{} };
pub const NativeTransport = struct {
    client: *curl.Client,
    timeout_ms: u32 = 30000,
    connect_timeout_ms: u32 = 10000,
    cancel: ?*const std.atomic.Value(bool) = null,
    pub fn interface(self: *NativeTransport) http.Transport {
        return .{ .context = self, .send_fn = send };
    }
    fn send(context: *anyopaque, allocator: std.mem.Allocator, request: http.Request) !http.Response {
        const self: *NativeTransport = @ptrCast(@alignCast(context));
        if (request.method != .POST) return error.UnsupportedRadixHttpMethod;
        const headers = try allocator.alloc(curl.Header, request.headers.len);
        defer allocator.free(headers);
        for (headers, request.headers) |*out, in| out.* = .{ .name = in.name, .value = in.value };
        var response = try self.client.send(allocator, .{ .url = request.url, .method = .post, .headers = headers, .body = request.body, .timeout_ms = self.timeout_ms, .connect_timeout_ms = self.connect_timeout_ms, .max_response_bytes = request.max_response_bytes - 1, .cancel = self.cancel });
        defer response.deinit();
        return .{ .allocator = allocator, .status = response.status, .bytes = try allocator.dupe(u8, response.body) };
    }
};
pub const Response = struct {
    parsed: std.json.Parsed(std.json.Value),
    pub fn value(self: Response) std.json.Value {
        return self.parsed.value;
    }
    pub fn deinit(self: *Response) void {
        self.parsed.deinit();
        self.* = undefined;
    }
};
pub const CallResult = struct {
    allocator: std.mem.Allocator,
    bytes: []u8,
    state_version: u64,
    pub fn value(self: CallResult) !sbor.Value {
        return sbor.decode(self.bytes, .scrypto);
    }
    pub fn deinit(self: *CallResult) void {
        self.allocator.free(self.bytes);
        self.* = undefined;
    }
};
pub const Ledger = struct { state_version: u64, epoch: u64 };
pub const Status = enum { unknown, pending, commit_pending_outcome, committed_success, committed_failure, rejected };
pub const StatusResult = struct { status: Status, committed_state_version: ?u64 };
pub const Client = struct {
    allocator: std.mem.Allocator,
    transport: http.Transport,
    core: Endpoint,
    gateway: Endpoint,
    network: address.Network,
    confirmations: u32,
    /// Ordered read fallback pools; submission always uses one exact endpoint.
    core_endpoints: []const Endpoint = &.{},
    gateway_endpoints: []const Endpoint = &.{},
    pub fn call(self: Client, endpoint: Endpoint, path: []const u8, payload: anytype) !Response {
        if (std.mem.eql(u8, path, "/transaction/submit")) return self.callOne(endpoint, path, payload);
        const same = std.mem.eql(u8, self.core.url, self.gateway.url);
        const core_route = std.mem.eql(u8, path, "/status/network-status") or std.mem.eql(u8, path, "/transaction/call-preview");
        const candidates = if (std.mem.eql(u8, endpoint.url, self.core.url) and (!same or core_route)) self.core_endpoints else if (std.mem.eql(u8, endpoint.url, self.gateway.url)) self.gateway_endpoints else &.{};
        if (candidates.len == 0) return self.callOne(endpoint, path, payload);
        var last: anyerror = error.EmptyRadixEndpoints;
        for (candidates) |candidate| return self.callOne(candidate, path, payload) catch |err| {
            if (err == error.PendingReadIo or err == error.OutOfMemory or err == error.RequestCancelled) return err;
            last = err;
            continue;
        };
        return last;
    }
    fn callOne(self: Client, endpoint: Endpoint, path: []const u8, payload: anytype) !Response {
        if (path.len == 0 or path[0] != '/') return error.InvalidRadixApiPath;
        const split = std.mem.indexOfScalar(u8, endpoint.url, '?') orelse endpoint.url.len;
        const url = try std.fmt.allocPrint(self.allocator, "{s}{s}{s}", .{ std.mem.trimEnd(u8, endpoint.url[0..split], "/"), path, endpoint.url[split..] });
        defer self.allocator.free(url);
        const body = try std.json.Stringify.valueAlloc(self.allocator, payload, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(body);
        const headers = try self.allocator.alloc(http.Header, endpoint.headers.len + 1);
        defer self.allocator.free(headers);
        for (endpoint.headers, headers[0..endpoint.headers.len]) |entry, *out| {
            if (std.ascii.eqlIgnoreCase(entry.name, "content-type")) return error.DuplicateRadixContentType;
            out.* = entry;
        }
        headers[headers.len - 1] = .{ .name = "content-type", .value = "application/json" };
        var response = try self.transport.send(self.allocator, .{ .method = .POST, .url = url, .headers = headers, .body = body, .max_response_bytes = 8 * 1024 * 1024 });
        defer response.deinit();
        if (response.status != 200) return error.RadixHttpStatus;
        // always allocate: the transport body is released after JSON parsing.
        return .{ .parsed = try std.json.parseFromSlice(std.json.Value, self.allocator, response.bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" }) };
    }
    pub fn coreState(self: Client) !u64 {
        var response = try self.call(self.core, "/status/network-status", .{ .network = self.network.logical_name });
        defer response.deinit();
        return json.uint(try json.field(try json.field(response.value(), "current_state_identifier"), "state_version"));
    }
    pub fn finalizedState(self: Client) !u64 {
        return (try self.coreState()) -| self.confirmations;
    }
    pub fn gatewayState(self: Client) !Ledger {
        var response = try self.call(self.gateway, "/status/gateway-status", struct {}{});
        defer response.deinit();
        return self.ledger(response.value());
    }
    fn ledger(self: Client, value: std.json.Value) !Ledger {
        const ledger_ = try json.field(value, "ledger_state");
        if (!std.mem.eql(u8, try json.string(try json.field(ledger_, "network")), self.network.logical_name)) return error.WrongRadixNetwork;
        return .{ .state_version = try json.uint(try json.field(ledger_, "state_version")), .epoch = try json.uint(try json.field(ledger_, "epoch")) };
    }
    pub fn callMethod(self: Client, component: [30]u8, method: []const u8, arguments: []const []const u8, state_version: ?u64) !CallResult {
        var text: [160]u8 = undefined;
        const component_text = try address.encode(self.network, "component", &component, &text);
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        const args = try allocator.alloc([]const u8, arguments.len);
        for (arguments, args) |argument, *out| {
            _ = try sbor.decode(argument, .manifest);
            out.* = try json.hex(allocator, argument);
        }
        const target = .{ .type = "Method", .component_address = component_text, .method_name = method };
        var response = if (state_version) |sv| try self.call(self.core, "/transaction/call-preview", .{ .arguments = args, .at_ledger_state = .{ .type = "ByStateVersion", .state_version = sv }, .network = self.network.logical_name, .target = target }) else try self.call(self.core, "/transaction/call-preview", .{ .arguments = args, .network = self.network.logical_name, .target = target });
        defer response.deinit();
        if (!std.mem.eql(u8, try json.string(try json.field(response.value(), "status")), "Succeeded")) return error.RadixPreviewFailed;
        const actual = try json.uint(try json.field(try json.field(response.value(), "at_ledger_state"), "state_version"));
        if (state_version) |expected| if (actual != expected) return error.WrongRadixStateVersion;
        const hex = try json.string(try json.field(try json.field(response.value(), "output"), "hex"));
        if (hex.len % 2 != 0) return error.InvalidRadixHex;
        const bytes = try self.allocator.alloc(u8, hex.len / 2);
        errdefer self.allocator.free(bytes);
        _ = try std.fmt.hexToBytes(bytes, hex);
        _ = try sbor.decode(bytes, .scrypto);
        return .{ .allocator = self.allocator, .bytes = bytes, .state_version = actual };
    }
    pub fn preview(self: Client, prepared: tx.Prepared) !Response {
        const encoded = try json.hex(self.allocator, prepared.preview);
        defer self.allocator.free(encoded);
        var response = try self.call(self.gateway, "/transaction/preview-v2", .{ .preview_transaction = .{ .type = "Compiled", .preview_transaction_hex = encoded }, .flags = .{ .use_free_credit = true }, .opt_ins = .{ .core_api_receipt = true } });
        errdefer response.deinit();
        _ = try json.field(response.value(), "receipt");
        return response;
    }
    pub fn committed(self: Client, intent_hash: [32]u8) !Response {
        var text: [160]u8 = undefined;
        const hash = try address.encode(self.network, "txid", &intent_hash, &text);
        var response = try self.call(self.gateway, "/transaction/committed-details", .{ .intent_hash = hash, .opt_ins = .{ .affected_global_entities = true, .manifest_instructions = true, .receipt_events = true, .receipt_fee_summary = true, .receipt_state_changes = true } });
        errdefer response.deinit();
        _ = try self.ledger(response.value());
        const transaction = try json.field(response.value(), "transaction");
        const actual = try json.string(try json.field(transaction, "intent_hash"));
        var actual_bytes: [32]u8 = undefined;
        const decoded = try address.decode(self.network, "txid", actual, &actual_bytes);
        if (!std.mem.eql(u8, decoded, &intent_hash)) return error.WrongRadixIntentHash;
        return response;
    }
    pub fn status(self: Client, intent_hash: [32]u8) !StatusResult {
        var text: [160]u8 = undefined;
        const hash = try address.encode(self.network, "txid", &intent_hash, &text);
        var response = try self.call(self.gateway, "/transaction/status", .{ .intent_hash = hash });
        defer response.deinit();
        _ = try self.ledger(response.value());
        const name = try json.string(try json.field(response.value(), "status"));
        const names = [_]struct { text: []const u8, value: Status }{ .{ .text = "Unknown", .value = .unknown }, .{ .text = "Pending", .value = .pending }, .{ .text = "CommitPendingOutcome", .value = .commit_pending_outcome }, .{ .text = "CommittedSuccess", .value = .committed_success }, .{ .text = "CommittedFailure", .value = .committed_failure }, .{ .text = "Rejected", .value = .rejected } };
        const result = for (names) |entry| {
            if (std.mem.eql(u8, entry.text, name)) break entry.value;
        } else return error.UnknownRadixStatus;
        const sv = response.value().object.get("committed_state_version") orelse .null;
        const state_version = if (sv == .null) null else try json.uint(sv);
        if ((result == .committed_success or result == .committed_failure) and state_version == null) return error.MissingRadixCommitState;
        return .{ .status = result, .committed_state_version = state_version };
    }
    /// Explicit submission only for authorized, already durably stored bytes.
    /// Transport errors remain ambiguous; reconcile by intent hash before retry.
    pub fn submit(self: Client, signed: tx.Signed) !bool {
        const encoded = try json.hex(self.allocator, signed.raw);
        defer self.allocator.free(encoded);
        var response = try self.call(self.gateway, "/transaction/submit", .{ .notarized_transaction_hex = encoded });
        defer response.deinit();
        const duplicate = try json.field(response.value(), "duplicate");
        if (duplicate != .bool) return error.InvalidRadixJson;
        return duplicate.bool;
    }
    pub fn streamPage(self: Client, start: u64, end: u64, emitter: ?[]const u8, cursor: ?[]const u8) !Response {
        if (start > end or end > std.math.maxInt(i64)) return error.InvalidRadixRange;
        var response = if (emitter) |contract| try self.call(self.gateway, "/stream/transactions", .{ .from_ledger_state = .{ .state_version = start }, .event_global_emitters_filter = [_][]const u8{contract}, .order = "Asc", .opt_ins = .{ .receipt_events = true }, .cursor = cursor }) else try self.call(self.gateway, "/stream/transactions", .{ .from_ledger_state = .{ .state_version = start }, .order = "Asc", .opt_ins = .{ .receipt_events = true }, .cursor = cursor });
        errdefer response.deinit();
        if ((try self.ledger(response.value())).state_version < end) return error.RadixGatewayBehind;
        const items = try json.field(response.value(), "items");
        if (items != .array) return error.InvalidRadixJson;
        var previous: u64 = start;
        for (items.array.items) |item| {
            const sv = try json.uint(try json.field(item, "state_version"));
            if (sv < start or sv < previous) return error.UnorderedRadixStream;
            previous = sv;
        }
        return response;
    }
};
test "Radix provider declarations compile against injected native HTTP boundary" {
    std.testing.refAllDecls(Client);
    std.testing.refAllDecls(NativeTransport);
}
