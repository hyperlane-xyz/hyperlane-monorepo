//! Special ISM parity boundary. Rust's message_builder rejects every module
//! handled here; source-backed codecs live in sibling modules for reuse without
//! accidentally enabling metadata production.
const std = @import("std");
const protocol = @import("../../protocol/root.zig");
const metadata = @import("../metadata.zig");
const evm = @import("../../evm/root.zig");

pub const legacy = @import("legacy.zig");
pub const weighted = @import("weighted.zig");
pub const arb = @import("arb.zig");

pub const Context = struct {
    origin_chain: u256,
    destination_chain: u256,
    origin_rpc: *evm.RpcClient,
    destination_rpc: *evm.RpcClient,
    cancel: ?*const std.atomic.Value(bool) = null,
};

pub const Module = struct {
    allocator: std.mem.Allocator,
    context: *Context,

    /// Parent hook: Source.specialMetadata(module_type, address, message).
    /// Keep this fail-closed until Rust adds a corresponding metadata builder.
    pub fn build(self: *Module, module_type: metadata.ModuleType, address: [20]u8, message: protocol.Message) ![]u8 {
        _ = self;
        _ = address;
        _ = message;
        return specialMetadata(module_type);
    }
};

pub fn specialMetadata(module_type: metadata.ModuleType) ![]u8 {
    return switch (module_type) {
        .legacy_multisig,
        .arb_l2_to_l1,
        .weighted_merkle_root_multisig,
        .weighted_message_id_multisig,
        .op_l2_to_l1,
        .polymer,
        => error.UnsupportedIsmType,
        else => error.NotSpecialIsmType,
    };
}
