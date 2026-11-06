const std = @import("std");
const abi = @import("../evm/codecs.zig");
const Message = @import("../protocol/message.zig").Message;
const types = @import("types.zig");

pub const Config = struct {
    mailbox: types.Address,
    ica_router: types.Hash,
    additional_ica_routers: []const types.Hash = &.{},

    pub fn matches(self: Config, message: Message) bool {
        if (message.body.len == 0 or message.body[0] != 2) return false;
        if (std.mem.eql(u8, &message.recipient, &self.ica_router)) return true;
        for (self.additional_ica_routers) |router| {
            if (std.mem.eql(u8, &message.recipient, &router)) return true;
        }
        return false;
    }
};

fn processArgument(args: []const u8, offset: usize) ![]const u8 {
    if (offset > args.len or args.len - offset < 32) return error.InvalidMevPayload;
    const length = try abi.uintWord(usize, args[offset..][0..32]);
    const start = try std.math.add(usize, offset, 32);
    const end = try std.math.add(usize, start, length);
    if (end > args.len) return error.InvalidMevPayload;
    const padded = try std.math.add(usize, length, (32 - length % 32) % 32);
    const padded_end = try std.math.add(usize, start, padded);
    if (padded_end > args.len or !std.mem.allEqual(u8, args[end..padded_end], 0)) return error.InvalidMevPayload;
    return args[start..end];
}

pub fn matchesPayload(config: Config, data_json: []const u8, allocator: std.mem.Allocator) !bool {
    const tuple = try std.json.parseFromSliceLeaky(std.json.Value, allocator, data_json, .{ .duplicate_field_behavior = .@"error" });
    if (tuple != .array or tuple.array.items.len != 2) return error.InvalidMevPayload;
    const request = try types.parseRequest(allocator, tuple.array.items[0]);
    const to = switch (request.request) {
        .legacy => |tx| tx.to,
        .eip2930 => |tx| tx.to,
        .eip1559 => |tx| tx.to,
    };
    if (to == null or !std.mem.eql(u8, &to.?, &config.mailbox)) return false;
    const function = try types.field(tuple.array.items[1], "name");
    if (function != .string or !std.mem.eql(u8, function.string, "process")) return error.InvalidMevPayload;
    const selector = abi.selector("process(bytes,bytes)");
    if (request.owned_data.len < 4 or !std.mem.eql(u8, request.owned_data[0..4], &selector)) return error.InvalidMevPayload;
    const args = request.owned_data[4..];
    if (args.len < 96) return error.InvalidMevPayload;
    const metadata_offset = try abi.uintWord(usize, args[0..32]);
    const message_offset = try abi.uintWord(usize, args[32..64]);
    if (metadata_offset != 64 or message_offset < 96 or message_offset % 32 != 0 or message_offset >= args.len) return error.InvalidMevPayload;
    _ = try processArgument(args, metadata_offset);
    const message_bytes = try processArgument(args, message_offset);
    const message_end = try std.math.add(usize, message_offset, try std.math.add(usize, 32, message_bytes.len + (32 - message_bytes.len % 32) % 32));
    if (message_end != args.len) return error.InvalidMevPayload;
    const message = Message.decode(message_bytes) catch return error.InvalidMevPayload;
    return config.matches(message);
}

test "ICA routing requires mailbox process recipient and reveal body" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const message: Message = .{ .recipient = @splat(0x42), .body = &.{2} };
    const bytes = try message.encodeAlloc(allocator);
    const calldata = try abi.processCalldata(allocator, &.{}, bytes);
    const hex = try abi.hexAlloc(allocator, calldata);
    const data = try std.fmt.allocPrint(allocator, "[{{\"type\":\"0x00\",\"to\":\"0x3535353535353535353535353535353535353535\",\"gasPrice\":\"0x1\",\"data\":\"{s}\"}},{{\"name\":\"process\",\"inputs\":[],\"outputs\":[],\"constant\":null,\"stateMutability\":\"nonpayable\"}}]", .{hex});
    const config: Config = .{ .mailbox = @splat(0x35), .ica_router = @splat(0x42) };
    try std.testing.expect(try matchesPayload(config, data, allocator));
    const commit: Message = .{ .recipient = @splat(0x42), .body = &.{1} };
    const commit_bytes = try commit.encodeAlloc(allocator);
    const commit_call = try abi.processCalldata(allocator, &.{}, commit_bytes);
    const commit_hex = try abi.hexAlloc(allocator, commit_call);
    const commit_data = try std.fmt.allocPrint(allocator, "[{{\"type\":\"0x00\",\"to\":\"0x3535353535353535353535353535353535353535\",\"gasPrice\":\"0x1\",\"data\":\"{s}\"}},{{\"name\":\"process\",\"inputs\":[],\"outputs\":[],\"constant\":null,\"stateMutability\":\"nonpayable\"}}]", .{commit_hex});
    try std.testing.expect(!try matchesPayload(config, commit_data, allocator));
}
