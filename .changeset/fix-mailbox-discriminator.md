---
"@hyperlane-xyz/sdk": patch
---

Fixed Mailbox instruction Borsh schema to use u8 discriminator (matching Rust's Borsh enum serialization) instead of u32.
