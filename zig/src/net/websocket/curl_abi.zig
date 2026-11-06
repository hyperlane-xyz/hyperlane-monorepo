//! Minimal independent libcurl ABI for nonblocking CONNECT_ONLY WebSockets.
//! Loaded symbols are verified by dlopen, including optional WebSocket support.
const std = @import("std");
pub const Handle = anyopaque;
pub const Multi = anyopaque;
const Version = extern struct { age: c_int, version: [*:0]const u8, version_num: c_uint, host: [*:0]const u8, features: c_int };
pub const Message = extern struct { kind: c_int, easy: *Handle, data: extern union { pointer: ?*anyopaque, result: c_int } };
pub const Api = struct {
    version_info: *const fn (c_int) callconv(.c) ?*const Version,
    global_init: *const fn (c_long) callconv(.c) c_int,
    easy_init: *const fn () callconv(.c) ?*Handle,
    easy_cleanup: *const fn (*Handle) callconv(.c) void,
    easy_setopt: *const fn (*Handle, c_int, ...) callconv(.c) c_int,
    easy_perform: *const fn (*Handle) callconv(.c) c_int,
    easy_getinfo: *const fn (*Handle, c_int, ...) callconv(.c) c_int,
    easy_send: *const fn (*Handle, [*]const u8, usize, *usize) callconv(.c) c_int,
    easy_recv: *const fn (*Handle, [*]u8, usize, *usize) callconv(.c) c_int,
    multi_init: *const fn () callconv(.c) ?*Multi,
    multi_cleanup: *const fn (*Multi) callconv(.c) c_int,
    multi_add_handle: *const fn (*Multi, *Handle) callconv(.c) c_int,
    multi_remove_handle: *const fn (*Multi, *Handle) callconv(.c) c_int,
    multi_socket_action: *const fn (*Multi, c_int, c_int, *c_int) callconv(.c) c_int,
    multi_perform: *const fn (*Multi, *c_int) callconv(.c) c_int,
    multi_timeout: *const fn (*Multi, *c_long) callconv(.c) c_int,
    multi_wait: *const fn (*Multi, ?*anyopaque, c_uint, c_int, *c_int) callconv(.c) c_int,
    multi_info_read: *const fn (*Multi, *c_int) callconv(.c) ?*Message,
    websocket_api: bool,

    pub fn load(library: *std.DynLib) !Api {
        var api: Api = undefined;
        inline for (std.meta.fields(Api)) |field| {
            if (field.type == bool) continue;
            const name = "curl_" ++ field.name;
            @field(api, field.name) = library.lookup(field.type, name) orelse return error.MissingWebSocketCurlSymbol;
        }
        api.websocket_api = library.lookup(*anyopaque, "curl_ws_recv") != null and library.lookup(*anyopaque, "curl_ws_send") != null;
        return api;
    }

    pub fn initialize(self: Api, secure: bool) !void {
        const version = self.version_info(0) orelse return error.LibcurlVersionUnavailable;
        if (version.features & (1 << 7) == 0) return error.LibcurlAsyncDnsRequired;
        if (secure and version.features & (1 << 2) == 0) return error.LibcurlTlsRequired;
        if (self.global_init(3) != 0) return error.LibcurlInitializationFailed;
    }
    pub fn check(code: c_int) !void {
        if (code != 0) return error.CurlOperationFailed;
    }
};
