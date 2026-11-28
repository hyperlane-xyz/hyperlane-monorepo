// The amount of gas to pay for when performing a transferRemote to a Sealevel chain.
export const SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT = 300_000;

export const STARKNET_WARP_ROUTE_HANDLER_GAS_AMOUNT = 5_000_000;

// The amount of gas to pay for when performing a transferRemote to Aevo, whose
// mint credits the accounts contract. Sized from a mint path of ~258k gas.
export const AEVO_WARP_ROUTE_HANDLER_GAS_AMOUNT = 300_000;

// Hyperlane quote signer authorized to sign offchain standing fee quotes.
export const QUOTE_SIGNER = '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d';
