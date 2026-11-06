//! Optional dynamic binding to the pinned Rust `regex` crate.
//! The Zig process never substitutes another regex implementation for parity.
const std = @import("std");
pub const abi_version: u32 = 1;
const NewFn = *const fn ([*]const u8, usize, [*]u8, usize, *?*anyopaque) callconv(.c) i32;
const MatchFn = *const fn (*anyopaque, [*]const u8, usize, *u8) callconv(.c) i32;
const FreeFn = *const fn (*anyopaque) callconv(.c) void;
pub const Error = struct {
    code: i32,
    message: []const u8,
};
pub const Engine = struct {
    allocator: std.mem.Allocator,
    library: std.DynLib,
    new_fn: NewFn,
    match_fn: MatchFn,
    free_fn: FreeFn,
    pub fn init(allocator: std.mem.Allocator, path: []const u8) !Engine {
        var library = try std.DynLib.open(path);
        errdefer library.close();
        const version_fn = library.lookup(*const fn () callconv(.c) u32, "ziggy_regex_abi_version") orelse return error.MissingRegexSymbol;
        if (version_fn() != abi_version) return error.IncompatibleRegexAbi;
        return .{
            .allocator = allocator,
            .library = library,
            .new_fn = library.lookup(NewFn, "ziggy_regex_new") orelse return error.MissingRegexSymbol,
            .match_fn = library.lookup(MatchFn, "ziggy_regex_is_match") orelse return error.MissingRegexSymbol,
            .free_fn = library.lookup(FreeFn, "ziggy_regex_free") orelse return error.MissingRegexSymbol,
        };
    }
    pub fn compile(self: *Engine, pattern: []const u8) !Regex {
        var message: [512]u8 = undefined;
        var handle: ?*anyopaque = null;
        const code = self.new_fn(pattern.ptr, pattern.len, &message, message.len, &handle);
        if (code != 0) {
            return switch (code) {
                -1 => error.InvalidRegexPattern,
                -2 => error.RegexPatternTooLarge,
                else => error.RegexEngineFailure,
            };
        }
        if (handle == null) return error.RegexEngineFailure;
        return .{ .engine = self, .handle = handle.? };
    }
    /// Join matching jobs and destroy every Regex before unloading its ABI.
    pub fn deinit(self: *Engine) void {
        self.library.close();
        self.* = undefined;
    }
};
pub const Regex = struct {
    engine: *Engine,
    handle: *anyopaque,
    pub fn isMatch(self: Regex, subject: []const u8) !bool {
        var matched: u8 = 0;
        const code = self.engine.match_fn(self.handle, subject.ptr, subject.len, &matched);
        if (code != 0) return if (code == -3) error.RegexSubjectTooLarge else error.RegexEngineFailure;
        if (matched > 1) return error.InvalidRegexResult;
        return matched == 1;
    }
    pub fn deinit(self: *Regex) void {
        self.engine.free_fn(self.handle);
        self.* = undefined;
    }
};
