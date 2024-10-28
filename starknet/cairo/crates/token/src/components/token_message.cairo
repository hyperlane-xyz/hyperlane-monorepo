use alexandria_bytes::{Bytes, BytesTrait};


#[generate_trait]
pub impl TokenMessage of TokenMessageTrait {
    /// Formats a token message with the recipient, amount, and metadata.
    ///
    /// This function creates a token message by combining the recipient address, the transfer amount,
    /// and any additional metadata. The resulting message is returned as a `Bytes` object.
    ///
    /// # Arguments
    ///
    /// * `recipient` - A `u256` representing the recipient's address.
    /// * `amount` - A `u256` representing the amount of tokens to transfer.
    /// * `metadata` - A `Bytes` object representing additional metadata for the transfer.
    ///
    /// # Returns
    ///
    /// A `Bytes` object containing the formatted token message.
    fn format(recipient: u256, amount: u256, metadata: Bytes) -> Bytes {
        let mut bytes = BytesTrait::new_empty();
        bytes.append_u256(recipient);
        bytes.append_u256(amount);
        bytes.concat(@metadata);
        bytes
    }

    /// Extracts the recipient address from the token message.
    ///
    /// This function reads the recipient address from the token message, starting at the beginning of
    /// the message data. The recipient is returned as a `u256`.
    ///
    /// # Returns
    ///
    /// A `u256` representing the recipient address.
    fn recipient(self: @Bytes) -> u256 {
        let (_, recipient) = self.read_u256(0);
        recipient
    }

    /// Extracts the transfer amount from the token message.
    ///
    /// This function reads the amount of tokens to be transferred from the token message, starting at
    /// byte offset 32. The amount is returned as a `u256`.
    ///
    /// # Returns
    ///
    /// A `u256` representing the amount of tokens to be transferred.
    fn amount(self: @Bytes) -> u256 {
        let (_, amount) = self.read_u256(32);
        amount
    }

    /// Extracts the token ID from the token message.
    ///
    /// This function is equivalent to the `amount` function, as in certain token standards the token
    /// ID is encoded in the same field as the transfer amount.
    ///
    /// # Returns
    ///
    /// A `u256` representing the token ID or transfer amount.
    fn token_id(self: @Bytes) -> u256 {
        self.amount()
    }

    /// Extracts the metadata from the token message.
    ///
    /// This function reads and returns the metadata portion of the token message, starting at byte
    /// offset 64 and extending to the end of the message.
    ///
    /// # Returns
    ///
    /// A `Bytes` object representing the metadata included in the token message.
    fn metadata(self: @Bytes) -> Bytes {
        let (_, bytes) = self.read_bytes(64, self.size() - 64);
        bytes
    }
}

