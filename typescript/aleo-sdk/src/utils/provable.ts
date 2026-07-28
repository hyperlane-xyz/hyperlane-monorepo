import type * as AleoMainnetSdk from '@provablehq/sdk/mainnet.js';

export type AleoSdk = typeof AleoMainnetSdk;

export type AleoPlaintextRuntime = Pick<AleoSdk, 'Plaintext'>;
