use eyre::bail;

/// Contract states
#[repr(u8)]
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum OutboxState {
    /// Before initialize function is called.
    /// Note: the contract is initialized at deploy time, so it should never be in this state
    UnInitialized = 0,
    /// As long as the contract has not become fraudulent.
    Active = 1,
    /// After a valid fraud proof has been submitted; contract will no longer accept updates or new
    /// messages
    Failed = 2,
}

impl TryFrom<u8> for OutboxState {
    type Error = eyre::Report;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        use OutboxState::*;
        Ok(match value {
            0 => UnInitialized,
            1 => Active,
            2 => Failed,
            _ => bail!("Invalid state value"),
        })
    }
}

/// The status of a message in the inbox
#[repr(u8)]
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum MessageStatus {
    /// Message is unknown
    None = 0,
    /// Message has been processed
    Processed = 1,
}

impl TryFrom<u8> for MessageStatus {
    type Error = eyre::Report;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        use MessageStatus::*;
        Ok(match value {
            0 => None,
            1 => Processed,
            _ => bail!("Invalid message status value"),
        })
    }
}
