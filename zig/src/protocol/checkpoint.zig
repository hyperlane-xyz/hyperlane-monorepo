const std = @import("std");
const Keccak256 = std.crypto.hash.sha3.Keccak256;

pub fn domainHash(hook: [32]u8, domain: u32) [32]u8 {
    var bytes: [45]u8 = undefined;
    std.mem.writeInt(u32, bytes[0..4], domain, .big);
    bytes[4..36].* = hook;
    bytes[36..45].* = "HYPERLANE".*;
    var digest: [32]u8 = undefined;
    Keccak256.hash(&bytes, &digest, .{});
    return digest;
}

pub fn ethSignedMessageHash(hash: [32]u8) [32]u8 {
    var hasher = Keccak256.init(.{});
    hasher.update("\x19Ethereum Signed Message:\n32");
    hasher.update(&hash);
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    return digest;
}

/// CheckpointWithMessageId from hyperlane-core and CheckpointLib.sol.
pub const Checkpoint = struct {
    merkle_tree_hook_address: [32]u8,
    mailbox_domain: u32,
    root: [32]u8,
    index: u32,
    message_id: [32]u8,

    pub fn signingHash(self: Checkpoint) [32]u8 {
        var bytes: [100]u8 = undefined;
        bytes[0..32].* = domainHash(self.merkle_tree_hook_address, self.mailbox_domain);
        bytes[32..64].* = self.root;
        std.mem.writeInt(u32, bytes[64..68], self.index, .big);
        bytes[68..100].* = self.message_id;
        var hash: [32]u8 = undefined;
        Keccak256.hash(&bytes, &hash, .{});
        return hash;
    }

    pub fn digest(self: Checkpoint) [32]u8 {
        return ethSignedMessageHash(self.signingHash());
    }
};

test "domain hash fixtures" {
    var hook = [_]u8{0} ** 32;
    @memset(hook[12..], 0x22);
    const expected = [_][]const u8{
        "bbca56eb98960a4637eb40486d9a0695" ++ "50dd70d9c185ed138516e8e33cf3d7e7",
        "a6a93d86d397028e41995d521ccbc270" ++ "e6db2a2fc530dcb7f0135254f30c8424",
        "ffb4fbe5142f55e07b5d44b3c7f565c5" ++ "ef4b016551cbd7c23a92c91621aca06f",
    };
    for (expected, 1..) |hex, domain| {
        var digest: [32]u8 = undefined;
        _ = try std.fmt.hexToBytes(&digest, hex);
        try std.testing.expectEqualSlices(u8, &digest, &domainHash(hook, @intCast(domain)));
    }
}

test "checkpoint digest separates every field" {
    const checkpoint: Checkpoint = .{ .merkle_tree_hook_address = .{0x22} ** 32, .mailbox_domain = 1000, .root = .{0x11} ** 32, .index = 5, .message_id = .{0x33} ** 32 };
    const original = checkpoint.digest();
    inline for (std.meta.fields(Checkpoint)) |field| {
        var changed = checkpoint;
        if (field.type == u32) @field(changed, field.name) ^= 1 else @field(changed, field.name)[0] ^= 1;
        try std.testing.expect(!std.mem.eql(u8, &original, &changed.digest()));
    }
}
