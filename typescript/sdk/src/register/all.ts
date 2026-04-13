import { registerAleoRuntimeAdapters } from './aleo.js';
import { registerCosmosRuntimeAdapters } from './cosmos.js';
import { registerEvmRuntimeAdapters } from './evm.js';
import { registerRadixRuntimeAdapters } from './radix.js';
import { registerSealevelRuntimeAdapters } from './sealevel.js';
import { registerStarknetRuntimeAdapters } from './starknet.js';
import { registerTronRuntimeAdapters } from './tron.js';

export function registerAllRuntimeAdapters(): void {
  registerEvmRuntimeAdapters();
  registerSealevelRuntimeAdapters();
  registerCosmosRuntimeAdapters();
  registerStarknetRuntimeAdapters();
  registerRadixRuntimeAdapters();
  registerAleoRuntimeAdapters();
  registerTronRuntimeAdapters();
}
