/// Trait for event types which returns transaction_hash and block_height
pub trait TxSpecificData{
    /// returns block_height
    fn block_height(&self) -> String;
    /// returns transaction_hash
    fn transaction_hash(&self) -> String;
}