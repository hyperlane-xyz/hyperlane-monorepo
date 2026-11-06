const std = @import("std");
const types = @import("types.zig");
pub const Journal = struct {
    seed: [32]u8,
    deny_intent: bool = false,
    intents: usize = 0,
    key_reads: usize = 0,
    signed: usize = 0,
    pub fn persistence(self: *Journal) types.Persistence {
        return .{ .context = self, .persistIntent = intent, .persistSigned = saveSigned };
    }
    fn intent(ctx: *anyopaque, _: [32]u8, _: []const u8) !void {
        const self: *Journal = @ptrCast(@alignCast(ctx));
        if (self.deny_intent) return error.FixtureIntentDenied;
        self.intents += 1;
    }
    fn saveSigned(ctx: *anyopaque, _: [32]u8, _: types.Identity, _: []const u8) !void {
        const self: *Journal = @ptrCast(@alignCast(ctx));
        if (self.intents == 0) return error.FixtureMissingIntent;
        self.signed += 1;
    }
    pub fn key(ctx: *anyopaque, out: *[32]u8) !void {
        const self: *Journal = @ptrCast(@alignCast(ctx));
        if (self.intents == 0) return error.FixtureMissingIntent;
        self.key_reads += 1;
        out.* = self.seed;
    }
    pub fn ed(ctx: *anyopaque, public: [32]u8, message: []const u8) ![64]u8 {
        const self: *Journal = @ptrCast(@alignCast(ctx));
        if (self.intents == 0) return error.FixtureMissingIntent;
        self.key_reads += 1;
        const pair = try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(self.seed);
        try std.testing.expectEqual(public, pair.public_key.toBytes());
        return (try pair.sign(message, null)).toBytes();
    }
};
pub fn decode(a: std.mem.Allocator, text: []const u8) ![]u8 {
    const out = try a.alloc(u8, text.len / 2);
    errdefer a.free(out);
    _ = try std.fmt.hexToBytes(out, text);
    return out;
}
