import * as testnetSdk from '@provablehq/sdk/testnet.js';

import { AleoNetworkId } from '../constants.js';
import type { AleoSdk } from '../utils/provable.js';

import { createAleoProviderClass } from './provider.js';

// CAST: Both Provable network modules expose the same API, but private WASM
// fields make their otherwise-compatible class types nominal.
const sdk = testnetSdk as unknown as AleoSdk;

export const AleoProvider = createAleoProviderClass(sdk, AleoNetworkId.TESTNET);
export type AleoProvider = InstanceType<typeof AleoProvider>;
