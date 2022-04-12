/// Contract states
#[derive(Debug)]
pub enum State {
    /// Contract is active
    Waiting,
    /// Contract has failed
    Failed,
}

/// The status of a message in the inbox
#[repr(u8)]
pub enum MessageStatus {
    /// Message is unknown
    None = 0,
    /// Message has been proven but not processed
    Proven = 1,
    /// Message has been processed
    Processed = 2,
}
