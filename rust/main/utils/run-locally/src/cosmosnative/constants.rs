pub const PREFIX: &str = "hyp";
pub const DENOM: &str = "uhyp";
pub const CHAIN_ID: &str = "hyperlane-local";
pub const BINARY_NAME: &str = "hypd";

pub const KEY_CHAIN_VALIDATOR: (&str, &str) = (
    "alice",
    "0x33913dd43a5d5764f7a23da212a8664fc4f5eedc68db35f3eb4a5c4f046b5b51",
);
pub const KEY_VALIDATOR: (&str, &str) = (
    "bob",
    "0x0afcf195989ebb6306f23271e50832332180b73055eb57f6d3c53263127e7d78",
);
pub const KEY_RELAYER: (&str, &str) = (
    "charlie",
    "0x8ef41fc20bf963ce18494c0f13e9303f70abc4c1d1ecfdb0a329d7fd468865b8",
);

/// TODO: make this dynamic
/// NOTE: we have to pad the address to 32 bytes
/// this is the alice cosmos address represented in hex
pub const ALICE_HEX: &str = "0x0000000000000000000000004200dacc2961e425f687ecF7571b5FF32B6Fe808";
