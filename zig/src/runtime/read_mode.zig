//! How a cooperative read continuation (net/read_replay, net/http_replay)
//! waits on this thread. Default `.journal`: submit, yield PendingReadIo and
//! replay the callback later. `.direct`: the thread is dedicated to one
//! retained callback (a lane_owner worker), so a read simply waits for its
//! response inline. No callback re-execution, response clone or identity hash.
pub const Mode = enum { journal, direct };
pub threadlocal var mode: Mode = .journal;

pub fn direct() bool {
    return mode == .direct;
}
