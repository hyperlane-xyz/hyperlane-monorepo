// Ethers-compatible adapters (primary interface)
export * from './ethers/index.js';

// Contract factories (typechain re-exports)
export * from './factories/index.js';

// AltVM clients (provider-sdk pattern)
export { TronProvider } from './clients/provider.js';
export { TronSigner } from './clients/signer.js';
export { TronProtocolProvider } from './clients/protocol.js';

export { TronReceipt } from './utils/types.js';
