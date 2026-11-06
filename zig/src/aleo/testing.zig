const std = @import("std");
const codec = @import("codec.zig");
const p = @import("plaintext.zig");
const rest = @import("rest.zig");
const provider = @import("provider.zig");
const crypto = @import("crypto.zig");
const contracts = @import("contracts.zig");
const json = @import("../net/json_rpc.zig");
const mock = @import("../cloud/testing.zig");
const a = std.testing.allocator;
fn fixture(kind: []const u8) ![]u8 {
    const fixture_bytes = try @import("../testing/fixture.zig").bytes(a, @embedFile("fixtures/source.jsonl.gz"), 16 * 1024 * 1024);
    defer a.free(fixture_bytes);
    var lines = std.mem.splitScalar(u8, fixture_bytes, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var parsed = try std.json.parseFromSlice(std.json.Value, a, line, .{});
        defer parsed.deinit();
        if (!std.mem.eql(u8, kind, try json.string(try json.field(parsed.value, "kind")))) continue;
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(a);
        for ((try json.field(parsed.value, "wire_utf8_chunks")).array.items) |chunk| try out.appendSlice(a, try json.string(chunk));
        return out.toOwnedSlice(a);
    }
    return error.MissingAleoFixture;
}
fn native() !crypto.Crypto {
    const path = std.process.getEnvVarOwned(a, "HYPERLANE_ALEO_CRYPTO_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(path);
    return crypto.Crypto.init(path);
}

test "Aleo REST fallback ownership and literal404 optional handling are bounded" {
    var script: mock.Mock = .{ .steps = &.{ .{ .method = .GET, .suffix = "/testnet/block/height/latest", .status = 503 }, .{ .method = .GET, .suffix = "/testnet/block/height/latest", .response = "42" }, .{ .method = .GET, .suffix = "/testnet/transaction/confirmed/public", .status = 404 }, .{ .method = .POST, .suffix = "/testnet/transaction/broadcast", .request_body = "{}", .status = 503 } } };
    var client = try rest.Client.init(a, script.transport(), &.{ .{ .url = "https://first" }, .{ .url = "https://second" } }, 1);
    var response = try client.get(&.{ "block", "height", "latest" }, &.{});
    defer response.deinit();
    try std.testing.expectEqual(@as(u32, 42), try json.integer(u32, response.value()));
    try std.testing.expect((try client.optional(&.{ "transaction", "confirmed", "public" }, &.{})) == null);
    try std.testing.expectError(error.AleoHttpStatus, client.post(&.{ "transaction", "broadcast" }, "{}"));
    try script.expectDone();
}

test "Aleo production mapping fixtures retain typed widths little endian tree root and observed height" {
    var n = try native();
    defer n.deinit();
    const mailbox = try fixture("mailbox");
    defer a.free(mailbox);
    const tree = try fixture("hook");
    defer a.free(tree);
    const block = try fixture("block_metadata");
    defer a.free(block);
    var script: mock.Mock = .{ .steps = &.{ .{ .method = .GET, .suffix = "/mainnet/program/test_mailbox.aleo/mapping/mailbox/true?metadata=true", .response = mailbox }, .{ .method = .GET, .suffix = "?metadata=true", .response = tree }, .{ .method = .GET, .suffix = "/mainnet/block/1", .response = block } } };
    var client: provider.Provider = .{ .client = try rest.Client.init(a, script.transport(), &.{.{ .url = "https://fixture" }}, 0), .native = &n };
    var contract = try contracts.Contracts.init(&client, .{ .mailbox = "test_mailbox.aleo", .hook_manager = "test_hook.aleo", .ism_manager = "test_ism.aleo", .validator_announce = "test_announce.aleo", .hook = try n.programAddress("credits.aleo"), .domain = 100 });
    const state = try contract.mailbox(true);
    try std.testing.expectEqual(@as(u32, 2), state.count);
    try std.testing.expectEqual(@as(u32, 2), state.processed);
    try std.testing.expectEqual(@as(u32, 12620133), state.height.?);
    const actual = try contract.tree();
    try std.testing.expect(actual.tree.count > 0);
    const header = try client.header(1);
    try std.testing.expectEqual(@as(u32, 1), header.height);
    try std.testing.expectError(error.AleoHistoricalMappingUnavailable, contract.checkpointAt(1));
    try std.testing.expectError(error.AleoDryRunUnavailable, contract.verify());
    try script.expectDone();
}

test "Aleo program calls locations and metadata queries preserve exact typed plaintext contracts" {
    var n = try native();
    defer n.deinit();
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const alloc = arena.allocator();
    const address = try n.programAddress("credits.aleo");
    const address_text = try n.addressText(alloc, address);
    var program: [128]u8 = .{0} ** 128;
    @memcpy(program[0.."recipient.aleo".len], "recipient.aleo");
    const recipient_json = try std.json.Stringify.valueAlloc(alloc, try (try p.byteArray(alloc, &program)).render(alloc), .{});
    const app = try std.fmt.allocPrint(alloc, "{{ism: {s}, hook: {s}}}", .{ address_text, address_text });
    const app_json = try std.json.Stringify.valueAlloc(alloc, app, .{});
    var location: [480]u8 = .{0} ** 480;
    @memcpy(location[0.."s3://public".len], "s3://public");
    const location_json = try std.json.Stringify.valueAlloc(alloc, try (try p.byteArray(alloc, &location)).render(alloc), .{});
    var validators: [6]p.Value = undefined;
    for (&validators, 0..) |*validator, i| validator.* = .{ .object = try alloc.dupe(p.Member, &.{.{ .name = "bytes", .value = try p.byteArray(alloc, &(if (i == 0) [_]u8{1} ** 20 else [_]u8{0} ** 20)) }}) };
    const validators_value: p.Value = .{ .object = &.{ .{ .name = "validators", .value = .{ .array = &validators } }, .{ .name = "validator_count", .value = p.number(@as(u8, 1)) }, .{ .name = "threshold", .value = p.number(@as(u8, 1)) } } };
    const validators_json = try std.json.Stringify.valueAlloc(alloc, try validators_value.render(alloc), .{});
    const route_json = try std.json.Stringify.valueAlloc(alloc, address_text, .{});
    var script: mock.Mock = .{ .steps = &.{
        .{ .method = .GET, .suffix = address_text, .response = recipient_json }, .{ .method = .GET, .suffix = "/app_metadata/true", .response = app_json }, .{ .method = .GET, .suffix = "/app_metadata/true", .response = app_json },
        .{ .method = .GET, .suffix = "%5D%7D", .response = "null" },             .{ .method = .GET, .suffix = address_text, .response = "\"5u8\"" },        .{ .method = .GET, .suffix = address_text, .response = validators_json },
        .{ .method = .GET, .suffix = "100u32%7D", .response = route_json },      .{ .method = .GET, .suffix = "%5D%7D", .response = "\"1u8\"" },            .{ .method = .GET, .suffix = "0u8%7D", .response = location_json },
        .{ .method = .GET, .suffix = address_text, .response = "null" },
    } };
    var client: provider.Provider = .{ .client = try rest.Client.init(a, script.transport(), &.{.{ .url = "https://fixture" }}, 0), .native = &n };
    var chain = try contracts.Contracts.init(&client, .{ .mailbox = "test_mailbox.aleo", .hook_manager = "test_hook.aleo", .ism_manager = "test_ism.aleo", .validator_announce = "test_announce.aleo", .hook = address, .domain = 100 });
    const message: codec.Message = .{ .version = 3, .nonce = 7, .origin = 100, .destination = 200, .sender = address, .recipient = address, .body = &.{ 0, 1 } };
    var call = try chain.process(message, &.{ 9, 8 });
    defer call.deinit();
    try std.testing.expectEqualStrings("recipient.aleo", call.program_id);
    try std.testing.expectEqualStrings("79u32", call.inputs[3]);
    var metadata = try p.Document.parse(a, call.inputs[5], .{});
    defer metadata.deinit();
    const bytes = try metadata.value.bytes(alloc, 512);
    try std.testing.expectEqualSlices(u8, &.{ 9, 8 }, bytes[0..2]);
    try std.testing.expect(std.mem.allEqual(u8, bytes[2..], 1));
    const wire = try call.json(alloc);
    try std.testing.expect(std.mem.indexOf(u8, wire, "\"function_name\":\"process\"") != null);
    try std.testing.expect(!try chain.delivered(message.id()));
    try std.testing.expectEqual(@as(u8, 5), try chain.moduleType(address));
    try std.testing.expectEqual(@as(u8, 1), (try chain.validators(address)).threshold);
    try std.testing.expectEqual(address, try chain.route(address, 100));
    var locations = try chain.locations(&.{.{1} ** 20});
    defer locations.deinit();
    try std.testing.expectEqualStrings("s3://public", locations.values[0][0]);
    try std.testing.expectEqual(@as(u64, 0), try client.balance(address));
    var announcement = try chain.announcement(.{1} ** 20, &location, .{2} ** 65);
    defer announcement.deinit();
    try std.testing.expectEqualStrings("announce", announcement.function_name);
    try std.testing.expectError(error.InvalidAleoAnnouncementLength, chain.announcement(.{1} ** 20, "short", .{2} ** 65));
    try script.expectDone();
}

test "Aleo actual production delivery block reconciles native finalize keys with immutable event mapping" {
    const events = @import("events.zig");
    var n = try native();
    defer n.deinit();
    const executable = std.process.getEnvVarOwned(a, "HYPERLANE_ALEO_VM_WORKER") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(executable);
    const library = std.process.getEnvVarOwned(a, "HYPERLANE_ALEO_VM_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(library);
    const block = try std.fs.cwd().readFileAlloc(a, sourcePath(), 16 * 1024 * 1024);
    defer a.free(block);
    var script: mock.Mock = .{ .steps = &.{ .{ .method = .GET, .suffix = "/testnet/block/height/latest", .response = "12618649" }, .{ .method = .GET, .suffix = "/process_event_index/12618649u32", .response = "\"1u32\"" }, .{ .method = .GET, .suffix = "/testnet/block/12618649", .response = block }, .{ .method = .GET, .suffix = "/process_events/1u32", .response = "\"[306532680884196914369041306889957777502u128,248078813986496060276330224523516710975u128]\"" } } };
    var client: provider.Provider = .{ .client = try rest.Client.init(a, script.transport(), &.{.{ .url = "https://fixture" }}, 1), .native = &n };
    var decoder: events.NativeDecoder = .{ .executable = executable, .library = library, .network = 1 };
    var indexer: events.Indexer = .{ .provider = &client, .decoder = decoder.interface(), .program = "test_mailbox.aleo", .kind = .delivery, .domain = 1617853565 };
    var result = try indexer.fetch(a, 12618649, 12618649);
    defer result.deinit();
    try std.testing.expectEqual(@as(usize, 1), result.items.len);
    try std.testing.expectEqual(@as(u32, 1), result.items[0].index);
    try std.testing.expectEqual(@as(u32, 0), result.items[0].transaction_index);
    var expected: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&expected, "042cb7ff55639abdda73ace1fbf728dc4" ++ "8a314137842274742ae64060cd4480c");
    try std.testing.expectEqual(expected, result.items[0].transaction);
    try script.expectDone();
}

fn sourcePath() []const u8 {
    std.fs.cwd().access("rust/main/config", .{}) catch return "../rust/main/chains/hyperlane-aleo/src/indexer/mock_responses/delivery_block.json";
    return "rust/main/chains/hyperlane-aleo/src/indexer/mock_responses/delivery_block.json";
}

test "Aleo concrete scraper factory and validator source consume committed typed settings without startup network" {
    const settings = @import("../settings/root.zig");
    const scraper = @import("../agents/scraper/aleo.zig");
    const validator = @import("validator.zig");
    var n = try native();
    defer n.deinit();
    const mailbox = try fixture("mailbox");
    defer a.free(mailbox);
    const block = try fixture("block_metadata");
    defer a.free(block);
    var loaded = try settings.Settings.load(a, .scraper, .{ .defaults_dir = defaultsDir(), .arguments = &.{ "--chainsToScrape=aleotestnet", "--db=postgresql://localhost/disposable" } });
    defer loaded.deinit();
    var script: mock.Mock = .{ .steps = &.{ .{ .method = .GET, .suffix = "/testnet/block/1", .response = block }, .{ .method = .GET, .suffix = "/mailbox/true?metadata=true", .response = mailbox }, .{ .method = .GET, .suffix = "/block/height/latest", .response = "1" }, .{ .method = .GET, .suffix = "/dispatch_event_index/1u32", .response = "null" }, .{ .method = .GET, .suffix = "/block/height/latest", .response = "1" }, .{ .method = .GET, .suffix = "/process_event_index/1u32", .response = "null" }, .{ .method = .GET, .suffix = "/block/height/latest", .response = "1" }, .{ .method = .GET, .suffix = "block_height:%201u32%7D", .response = "null" }, .{ .method = .GET, .suffix = "/block/height/latest", .response = "1" }, .{ .method = .GET, .suffix = "block_height:%201u32%7D", .response = "null" } } };
    var factory = try scraper.Factory.init(a, script.transport(), &n, &loaded.chains[0], .{ .executable = "/explicit/public/worker", .library = "/explicit/public/library" });
    defer factory.deinit();
    const source = factory.interface();
    try std.testing.expect(!source.historical_counts);
    try std.testing.expectEqual(@as(u64, 1), (try source.header(.{ .height = 1 })).height);
    try std.testing.expectEqual(@as(?u32, 2), (try source.streamTip(0)).count);
    var batch = try source.events(a, 1, 1, .{0} ** 4);
    defer batch.deinit();
    try std.testing.expectEqual(@as(usize, 0), batch.events.len);
    try script.expectDone();
    var settings_ = try settings.Settings.load(a, .validator, .{ .defaults_dir = defaultsDir(), .arguments = &.{ "--originChainName=aleotestnet", "--validator.key=0x11111111111111111111111111111111" ++ "11111111111111111111111111111111", "--checkpointSyncer.type=localStorage", "--checkpointSyncer.path=/tmp/public-fixture" } });
    defer settings_.deinit();
    var polling: mock.Mock = .{ .steps = &.{ .{ .method = .GET, .suffix = "/testnet/block/height/latest", .response = "12620133" }, .{ .method = .GET, .suffix = "?metadata=true", .response = try fixture("hook") }, .{ .method = .GET, .suffix = "?metadata=true", .response = "{\"data\":\"{id:[1u128,2u128],index:1u32}\",\"height\":1}" }, .{ .method = .GET, .suffix = "/block/1", .response = block } } };
    defer a.free(polling.steps[1].response);
    const read = try validator.Source.init(a, &settings_, polling.transport(), &n);
    defer read.deinit();
    const interface = read.interface();
    try std.testing.expectEqual(@as(usize, 1), read.endpointCount());
    try std.testing.expectEqual(@as(u64, 12620133), try interface.finalized_height(interface.context, .none));
    try std.testing.expect((try interface.checkpoint(interface.context, 0, .none)) != null);
    try polling.expectDone();
}
fn defaultsDir() []const u8 {
    std.fs.cwd().access("rust/main/config", .{}) catch return "../rust/main/config";
    return "rust/main/config";
}
