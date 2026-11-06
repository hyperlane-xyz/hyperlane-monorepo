//! Finalized Aleo reads. Mapping metadata reports actual read height; historical
//! mapping reads are not silently simulated with latest state.
const std = @import("std");
const rest = @import("rest.zig");
const plaintext = @import("plaintext.zig");
const crypto = @import("crypto.zig");
const json = @import("../net/json_rpc.zig");
pub const Mapping = struct {
    document: ?plaintext.Document,
    height: ?u32,
    pub fn value(self: *const Mapping) ?plaintext.Value {
        return if (self.document) |document| document.value else null;
    }
    pub fn deinit(self: *Mapping) void {
        if (self.document) |*document| document.deinit();
        self.* = undefined;
    }
};
pub const Header = struct { height: u32, hash: [32]u8, parent: [32]u8, timestamp: u64 };
pub const Provider = struct {
    client: rest.Client,
    native: *crypto.Crypto,
    plaintext_limits: plaintext.Limits = .{},
    pub fn height(self: *Provider) !u32 {
        var result = try self.client.get(&.{ "block", "height", "latest" }, &.{});
        defer result.deinit();
        return json.integer(u32, result.value());
    }
    pub fn header(self: *Provider, height_: u32) !Header {
        var buffer: [16]u8 = undefined;
        const number = try std.fmt.bufPrint(&buffer, "{d}", .{height_});
        var response = try self.client.get(&.{ "block", number }, &.{});
        defer response.deinit();
        const value = response.value();
        const metadata = try json.field(try json.field(value, "header"), "metadata");
        const actual = try json.integer(u32, try json.field(metadata, "height"));
        if (actual != height_) return error.WrongAleoBlockHeight;
        return .{ .height = actual, .hash = try self.native.id(.block, try json.string(try json.field(value, "block_hash"))), .parent = try self.native.id(.block, try json.string(try json.field(value, "previous_hash"))), .timestamp = try json.integer(u64, try json.field(metadata, "timestamp")) };
    }
    pub fn mapping(self: *Provider, program: []const u8, name: []const u8, key: []const u8, with_metadata: bool) !Mapping {
        var response = try self.client.get(&.{ "program", program, "mapping", name, key }, if (with_metadata) &.{.{ .name = "metadata", .value = "true" }} else &.{});
        defer response.deinit();
        var value = response.value();
        var height_: ?u32 = null;
        if (with_metadata) {
            height_ = try json.integer(u32, try json.field(value, "height"));
            value = try json.field(value, "data");
        }
        if (value == .null) return .{ .document = null, .height = height_ };
        const text = try json.string(value);
        return .{ .document = try plaintext.Document.parse(self.client.allocator, text, self.plaintext_limits), .height = height_ };
    }
    pub fn balance(self: *Provider, address: [32]u8) !u64 {
        const text = try self.native.addressText(self.client.allocator, address);
        defer self.client.allocator.free(text);
        var result = try self.mapping("credits.aleo", "account", text, false);
        defer result.deinit();
        return if (result.value()) |value| try value.number(u64) else 0;
    }
    /// Only a literal HTTP404 denotes an absent transaction; malformed/error JSON
    /// and all other HTTP failures remain failures.
    pub fn transaction(self: *Provider, id: []const u8, confirmed: bool) !?rest.Response {
        _ = try self.native.id(.transaction, id);
        return self.client.optional(&.{ "transaction", if (confirmed) "confirmed" else "unconfirmed", id }, &.{});
    }
    pub fn broadcast(self: *Provider, signed_transaction: []const u8) !rest.Response {
        return self.client.post(&.{ "transaction", "broadcast" }, signed_transaction);
    }
};
