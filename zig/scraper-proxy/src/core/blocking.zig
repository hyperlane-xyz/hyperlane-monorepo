//! Marks a section where the calling thread may block (DB socket wait, pool
//! wait, join). HTTP poller threads install a hook so another poller takes
//! over meanwhile; on any other thread this is a no-op.
pub const Hook = struct {
    ctx: *anyopaque,
    begin: *const fn (ctx: *anyopaque) void,
    end: *const fn (ctx: *anyopaque) void,
};

pub threadlocal var hook: ?Hook = null;

pub inline fn begin() void {
    if (hook) |h| h.begin(h.ctx);
}

pub inline fn end() void {
    if (hook) |h| h.end(h.ctx);
}
