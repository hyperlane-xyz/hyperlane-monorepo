// Ethers-compatible adapters (primary interface)
export * from './ethers/index.js';

// AltVM clients (provider-sdk pattern)
export { TronProvider } from './clients/provider.js';
export { TronSigner } from './clients/signer.js';
export { TronProtocolProvider } from './clients/protocol.js';

export { TronReceipt } from './utils/types.js';
