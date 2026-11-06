//! Native build ABI guard. The helper links this version-only shim alongside
//! the exact upstream RocksDB/compression archives; no Rust runtime is linked.
const std = @import("std");
extern fn ziggy_rocksdb_abi_version() u32;
extern fn ziggy_rocksdb_header_version() u32;
extern fn ziggy_rocksdb_runtime_version() ?[*:0]const u8;
pub fn verify() !void {
    if (ziggy_rocksdb_abi_version() != 1 or ziggy_rocksdb_header_version() != 0x0a0402) return error.RocksDBNativeAbiMismatch;
    const version = ziggy_rocksdb_runtime_version() orelse return error.RocksDBNativeVersionUnavailable;
    if (!std.mem.eql(u8, std.mem.span(version), "10.4.2")) return error.RocksDBNativeVersionMismatch;
}
