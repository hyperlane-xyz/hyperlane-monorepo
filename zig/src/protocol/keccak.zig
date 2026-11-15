//! Keccak-256 (Ethereum padding 0x01) specialised for protocol hashing.
//!
//! The scalar permutation keeps the 25 lanes in SSA locals with comptime lane
//! indices, so no bounds checks remain in ReleaseSafe; the implementation is
//! chosen per target at comptime (FEAT_SHA3 vector code on capable aarch64).
//! Blocks are absorbed straight from the caller's bytes; only a trailing
//! partial block is buffered. Fixed-size inputs (Merkle nodes) skip the sponge.
const std = @import("std");
const builtin = @import("builtin");

pub const rate = 136;
pub const digest_length = 32;
const lanes_per_block = rate / 8;

const round_constants = [24]u64{
    0x0000000000000001, 0x0000000000008082, 0x800000000000808a, 0x8000000080008000,
    0x000000000000808b, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008a, 0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
    0x000000008000808b, 0x800000000000008b, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800a, 0x800000008000000a,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
};

/// Rho rotation for lane x + 5y.
const rho = [25]u6{
    0,  1,  62, 28, 27,
    36, 44, 6,  55, 20,
    3,  10, 43, 25, 39,
    41, 45, 15, 21, 8,
    18, 2,  61, 56, 14,
};

/// Source lane (x + 5y) feeding pi output position (X + 5Y): X = y and
/// Y = 2x + 3y (mod 5), so x = 3(Y - 3X) (mod 5).
fn piSource(comptime out_x: usize, comptime out_y: usize) usize {
    const x = (3 * (out_y + 5 * 3 - 3 * out_x)) % 5;
    return x + 5 * out_x;
}

/// One round, row-ordered (XKCP opt64 style): theta columns, then for each
/// output plane its five rho/pi lanes and chi straight into `e`, keeping only
/// five temporaries live instead of a whole B state. All lane indices are
/// comptime, so no bounds checks remain in ReleaseSafe.
inline fn round(a: *const [25]u64, e: *[25]u64, rc: u64) void {
    var c: [5]u64 = undefined;
    inline for (0..5) |x| c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    var d: [5]u64 = undefined;
    inline for (0..5) |x| d[x] = c[(x + 4) % 5] ^ std.math.rotl(u64, c[(x + 1) % 5], 1);
    inline for (0..5) |y| {
        var b: [5]u64 = undefined;
        inline for (0..5) |x| {
            const src = comptime piSource(x, y);
            b[x] = std.math.rotl(u64, a[src] ^ d[src % 5], rho[src]);
        }
        inline for (0..5) |x| e[x + 5 * y] = b[x] ^ (~b[(x + 1) % 5] & b[(x + 2) % 5]);
    }
    e[0] ^= rc;
}

pub const Implementation = enum {
    /// 24 rounds fully unrolled; best scalar shape on 31-GPR aarch64.
    unrolled,
    /// Two-round loop body; on 16-GPR x86-64 the smaller body spills less
    /// (llvm-mca znver3: ~887 vs ~919 cycles unrolled, ~1034 for RustCrypto).
    looped,
    /// ARMv8.2 FEAT_SHA3 vector instructions.
    arm_sha3,
};

pub const default_implementation: Implementation = if (has_arm_sha3)
    .arm_sha3
else if (builtin.cpu.arch == .x86_64)
    .looped
else
    .unrolled;

/// Keccak-f[1600] permutation (24 rounds).
pub fn permute(st: *[25]u64) void {
    // Comptime evaluation (e.g. Merkle zero hashes) cannot run inline asm.
    if (@inComptime()) return permuteWith(.unrolled, st);
    permuteWith(default_implementation, st);
}

pub fn permuteWith(comptime implementation: Implementation, st: *[25]u64) void {
    @setEvalBranchQuota(20_000);
    var a = st.*;
    switch (implementation) {
        .unrolled => {
            var e: [25]u64 = undefined;
            inline for (0..12) |i| {
                round(&a, &e, round_constants[2 * i]);
                round(&e, &a, round_constants[2 * i + 1]);
            }
        },
        .looped => {
            var e: [25]u64 = undefined;
            for (0..12) |i| {
                round(&a, &e, round_constants[2 * i]);
                round(&e, &a, round_constants[2 * i + 1]);
            }
        },
        .arm_sha3 => if (comptime has_arm_sha3) permuteArmSha3(&a) else @compileError("target lacks FEAT_SHA3"),
    }
    st.* = a;
}

/// Whether the target CPU implements FEAT_SHA3 (EOR3/RAX1/XAR/BCAX).
pub const has_arm_sha3 = switch (builtin.cpu.arch) {
    .aarch64 => std.Target.aarch64.featureSetHas(builtin.cpu.features, .sha3),
    else => false,
};

/// Keccak-f[1600] with ARMv8.2 SHA3 instructions, adapted from XKCP/K12
/// KeccakP-1600-ARMv8Asha3.S (via RustCrypto keccak, MIT/Apache-2.0). Only the
/// low 64-bit half of each vector register carries state.
fn permuteArmSha3(st: *[25]u64) void {
    asm volatile (
        \\ mov x9, %[st]
        \\ mov x10, %[rc]
        \\ mov x8, #24
        \\ ld1 { v0.1d, v1.1d, v2.1d, v3.1d }, [x9], #32
        \\ ld1 { v4.1d, v5.1d, v6.1d, v7.1d }, [x9], #32
        \\ ld1 { v8.1d, v9.1d, v10.1d, v11.1d }, [x9], #32
        \\ ld1 { v12.1d, v13.1d, v14.1d, v15.1d }, [x9], #32
        \\ ld1 { v16.1d, v17.1d, v18.1d, v19.1d }, [x9], #32
        \\ ld1 { v20.1d, v21.1d, v22.1d, v23.1d }, [x9], #32
        \\ ld1 { v24.1d }, [x9]
        \\ sub x9, x9, #192
        \\ 0: sub x8, x8, #1
        \\ eor3 v25.16b, v20.16b, v15.16b, v10.16b
        \\ eor3 v26.16b, v21.16b, v16.16b, v11.16b
        \\ eor3 v27.16b, v22.16b, v17.16b, v12.16b
        \\ eor3 v28.16b, v23.16b, v18.16b, v13.16b
        \\ eor3 v29.16b, v24.16b, v19.16b, v14.16b
        \\ eor3 v25.16b, v25.16b, v5.16b, v0.16b
        \\ eor3 v26.16b, v26.16b, v6.16b, v1.16b
        \\ eor3 v27.16b, v27.16b, v7.16b, v2.16b
        \\ eor3 v28.16b, v28.16b, v8.16b, v3.16b
        \\ eor3 v29.16b, v29.16b, v9.16b, v4.16b
        \\ rax1 v30.2d, v25.2d, v27.2d
        \\ rax1 v31.2d, v26.2d, v28.2d
        \\ rax1 v27.2d, v27.2d, v29.2d
        \\ rax1 v28.2d, v28.2d, v25.2d
        \\ rax1 v29.2d, v29.2d, v26.2d
        \\ eor v0.16b, v0.16b, v29.16b
        \\ xar v25.2d, v1.2d, v30.2d, #63
        \\ xar v1.2d, v6.2d, v30.2d, #20
        \\ xar v6.2d, v9.2d, v28.2d, #44
        \\ xar v9.2d, v22.2d, v31.2d, #3
        \\ xar v22.2d, v14.2d, v28.2d, #25
        \\ xar v14.2d, v20.2d, v29.2d, #46
        \\ xar v26.2d, v2.2d, v31.2d, #2
        \\ xar v2.2d, v12.2d, v31.2d, #21
        \\ xar v12.2d, v13.2d, v27.2d, #39
        \\ xar v13.2d, v19.2d, v28.2d, #56
        \\ xar v19.2d, v23.2d, v27.2d, #8
        \\ xar v23.2d, v15.2d, v29.2d, #23
        \\ xar v15.2d, v4.2d, v28.2d, #37
        \\ xar v28.2d, v24.2d, v28.2d, #50
        \\ xar v24.2d, v21.2d, v30.2d, #62
        \\ xar v8.2d, v8.2d, v27.2d, #9
        \\ xar v4.2d, v16.2d, v30.2d, #19
        \\ xar v16.2d, v5.2d, v29.2d, #28
        \\ xar v5.2d, v3.2d, v27.2d, #36
        \\ xar v27.2d, v18.2d, v27.2d, #43
        \\ xar v3.2d, v17.2d, v31.2d, #49
        \\ xar v30.2d, v11.2d, v30.2d, #54
        \\ xar v31.2d, v7.2d, v31.2d, #58
        \\ xar v29.2d, v10.2d, v29.2d, #61
        \\ bcax v20.16b, v26.16b, v22.16b, v8.16b
        \\ bcax v21.16b, v8.16b, v23.16b, v22.16b
        \\ bcax v22.16b, v22.16b, v24.16b, v23.16b
        \\ bcax v23.16b, v23.16b, v26.16b, v24.16b
        \\ bcax v24.16b, v24.16b, v8.16b, v26.16b
        \\ ld1r { v26.2d }, [x10], #8
        \\ bcax v17.16b, v30.16b, v19.16b, v3.16b
        \\ bcax v18.16b, v3.16b, v15.16b, v19.16b
        \\ bcax v19.16b, v19.16b, v16.16b, v15.16b
        \\ bcax v15.16b, v15.16b, v30.16b, v16.16b
        \\ bcax v16.16b, v16.16b, v3.16b, v30.16b
        \\ bcax v10.16b, v25.16b, v12.16b, v31.16b
        \\ bcax v11.16b, v31.16b, v13.16b, v12.16b
        \\ bcax v12.16b, v12.16b, v14.16b, v13.16b
        \\ bcax v13.16b, v13.16b, v25.16b, v14.16b
        \\ bcax v14.16b, v14.16b, v31.16b, v25.16b
        \\ bcax v7.16b, v29.16b, v9.16b, v4.16b
        \\ bcax v8.16b, v4.16b, v5.16b, v9.16b
        \\ bcax v9.16b, v9.16b, v6.16b, v5.16b
        \\ bcax v5.16b, v5.16b, v29.16b, v6.16b
        \\ bcax v6.16b, v6.16b, v4.16b, v29.16b
        \\ bcax v3.16b, v27.16b, v0.16b, v28.16b
        \\ bcax v4.16b, v28.16b, v1.16b, v0.16b
        \\ bcax v0.16b, v0.16b, v2.16b, v1.16b
        \\ bcax v1.16b, v1.16b, v27.16b, v2.16b
        \\ bcax v2.16b, v2.16b, v28.16b, v27.16b
        \\ eor v0.16b, v0.16b, v26.16b
        \\ cbnz x8, 0b
        \\ st1 { v0.1d, v1.1d, v2.1d, v3.1d }, [x9], #32
        \\ st1 { v4.1d, v5.1d, v6.1d, v7.1d }, [x9], #32
        \\ st1 { v8.1d, v9.1d, v10.1d, v11.1d }, [x9], #32
        \\ st1 { v12.1d, v13.1d, v14.1d, v15.1d }, [x9], #32
        \\ st1 { v16.1d, v17.1d, v18.1d, v19.1d }, [x9], #32
        \\ st1 { v20.1d, v21.1d, v22.1d, v23.1d }, [x9], #32
        \\ st1 { v24.1d }, [x9]
        :
        : [st] "r" (st),
          [rc] "r" (&round_constants),
        : .{ .memory = true, .x8 = true, .x9 = true, .x10 = true, .v0 = true, .v1 = true, .v2 = true, .v3 = true, .v4 = true, .v5 = true, .v6 = true, .v7 = true, .v8 = true, .v9 = true, .v10 = true, .v11 = true, .v12 = true, .v13 = true, .v14 = true, .v15 = true, .v16 = true, .v17 = true, .v18 = true, .v19 = true, .v20 = true, .v21 = true, .v22 = true, .v23 = true, .v24 = true, .v25 = true, .v26 = true, .v27 = true, .v28 = true, .v29 = true, .v30 = true, .v31 = true });
}

inline fn absorbBlock(st: *[25]u64, block: *const [rate]u8) void {
    inline for (0..lanes_per_block) |i| st[i] ^= std.mem.readInt(u64, block[i * 8 ..][0..8], .little);
    permute(st);
}

inline fn squeeze(st: *const [25]u64) [digest_length]u8 {
    var out: [digest_length]u8 = undefined;
    inline for (0..4) |i| std.mem.writeInt(u64, out[i * 8 ..][0..8], st[i], .little);
    return out;
}

/// Pads the final partial block (len < rate bytes of `block` are data).
inline fn absorbFinal(st: *[25]u64, block: *[rate]u8, len: usize) void {
    @memset(block[len..], 0);
    block[len] ^= 0x01;
    block[rate - 1] ^= 0x80;
    absorbBlock(st, block);
}

/// Streaming Keccak-256. API mirrors std.crypto.hash.sha3.Keccak256 so call
/// sites can switch without restructuring.
pub const Keccak256 = struct {
    st: [25]u64 = @splat(0),
    buf: [rate]u8 = undefined,
    /// Buffered bytes; always < rate between calls.
    len: usize = 0,

    pub const Options = struct {};
    pub const block_length = rate;
    pub const digest_length = 32;

    pub fn init(_: Options) Keccak256 {
        return .{};
    }

    pub fn update(self: *Keccak256, bytes: []const u8) void {
        var in = bytes;
        if (self.len != 0) {
            const take = @min(rate - self.len, in.len);
            @memcpy(self.buf[self.len..][0..take], in[0..take]);
            self.len += take;
            in = in[take..];
            if (self.len < rate) return;
            absorbBlock(&self.st, &self.buf);
            self.len = 0;
        }
        while (in.len >= rate) {
            absorbBlock(&self.st, in[0..rate]);
            in = in[rate..];
        }
        @memcpy(self.buf[0..in.len], in);
        self.len = in.len;
    }

    pub fn final(self: *Keccak256, out: *[32]u8) void {
        absorbFinal(&self.st, &self.buf, self.len);
        out.* = squeeze(&self.st);
    }

    pub fn finalResult(self: *Keccak256) [32]u8 {
        var out: [32]u8 = undefined;
        self.final(&out);
        return out;
    }

    pub fn hash(bytes: []const u8, out: *[32]u8, _: Options) void {
        out.* = keccak256(bytes);
    }
};

/// One-shot Keccak-256 without a streaming buffer for full blocks.
pub fn keccak256(bytes: []const u8) [digest_length]u8 {
    var st: [25]u64 = @splat(0);
    var in = bytes;
    while (in.len >= rate) {
        absorbBlock(&st, in[0..rate]);
        in = in[rate..];
    }
    var block: [rate]u8 = undefined;
    @memcpy(block[0..in.len], in);
    absorbFinal(&st, &block, in.len);
    return squeeze(&st);
}

/// keccak256(left ++ right): one padded block built directly in lanes.
pub fn hashPair(left: *const [32]u8, right: *const [32]u8) [digest_length]u8 {
    var st: [25]u64 = @splat(0);
    inline for (0..4) |i| {
        st[i] = std.mem.readInt(u64, left[i * 8 ..][0..8], .little);
        st[i + 4] = std.mem.readInt(u64, right[i * 8 ..][0..8], .little);
    }
    st[8] = 0x01;
    st[lanes_per_block - 1] = 0x80 << 56;
    permute(&st);
    return squeeze(&st);
}

fn stdHash(bytes: []const u8) [32]u8 {
    var out: [32]u8 = undefined;
    std.crypto.hash.sha3.Keccak256.hash(bytes, &out, .{});
    return out;
}

test "every available permutation matches XKCP vectors and std on random states" {
    var prng = std.Random.DefaultPrng.init(0x70657266);
    inline for (comptime std.enums.values(Implementation)) |implementation| {
        if (implementation == .arm_sha3 and !has_arm_sha3) continue;
        var st: [25]u64 = @splat(0);
        permuteWith(implementation, &st);
        try std.testing.expectEqual(@as(u64, 0xF1258F7940E1DDE7), st[0]);
        try std.testing.expectEqual(@as(u64, 0xEAF1FF7B5CECA249), st[24]);
        permuteWith(implementation, &st);
        try std.testing.expectEqual(@as(u64, 0x2D5C954DF96ECB3C), st[0]);
        try std.testing.expectEqual(@as(u64, 0x20D06CD26A8FBF5C), st[24]);
        for (0..64) |_| {
            for (&st) |*lane| lane.* = prng.random().int(u64);
            var reference: std.crypto.core.keccak.KeccakF(1600) = .{ .st = st };
            reference.permute();
            permuteWith(implementation, &st);
            try std.testing.expectEqualSlices(u64, &reference.st, &st);
        }
    }
}

test "comptime permutation matches runtime" {
    const at_comptime = comptime hashPair(&@splat(0x11), &@splat(0x22));
    try std.testing.expectEqualSlices(u8, &at_comptime, &hashPair(&@splat(0x11), &@splat(0x22)));
}

test "known Keccak-256 vectors" {
    var expected: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&expected, "c5d2460186f7233c927e7db2dcc703c0" ++ "e500b653ca82273b7bfad8045d85a470");
    try std.testing.expectEqualSlices(u8, &expected, &keccak256(""));
    _ = try std.fmt.hexToBytes(&expected, "4e03657aea45a94fc7d47ba826c8d667" ++ "c0d1e6e33a64a036ec44f58fa12d6c45");
    try std.testing.expectEqualSlices(u8, &expected, &keccak256("abc"));
}

test "one-shot, streaming and pair hashing match std at every length and split" {
    var data: [4 * rate + 3]u8 = undefined;
    var prng = std.Random.DefaultPrng.init(0x6b656363);
    prng.random().bytes(&data);
    for (0..data.len + 1) |len| {
        const expected = stdHash(data[0..len]);
        try std.testing.expectEqualSlices(u8, &expected, &keccak256(data[0..len]));
        for ([_]usize{ 0, 1, 7, 8, 77, 135, 136, 137, 300 }) |split_at| {
            if (split_at > len) continue;
            var hasher = Keccak256.init(.{});
            hasher.update(data[0..split_at]);
            hasher.update(data[split_at..len]);
            try std.testing.expectEqualSlices(u8, &expected, &hasher.finalResult());
        }
        // Byte-at-a-time exercises every buffered offset.
        var bytewise = Keccak256.init(.{});
        for (data[0..len]) |byte| bytewise.update(&.{byte});
        try std.testing.expectEqualSlices(u8, &expected, &bytewise.finalResult());
    }
    for (0..64) |i| {
        const pair = data[i..][0..64];
        try std.testing.expectEqualSlices(u8, &stdHash(pair), &hashPair(pair[0..32], pair[32..64]));
    }
}
