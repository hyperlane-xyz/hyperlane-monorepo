const std = @import("std");
pub const api = @import("api.zig");
pub const json = @import("json.zig");
pub const query = @import("query.zig");
pub const relay_api = @import("relay_api.zig");

test {
    _ = api;
    _ = json;
    _ = query;
    _ = relay_api;
}

test {
    _ = api.Admin.handler;
    _ = api.Admin;
    _ = relay_api.RateLimiter;
    _ = relay_api.TxHashCache;
    _ = relay_api.RelayApi.handler;
    _ = relay_api.configFromSettings;
}
