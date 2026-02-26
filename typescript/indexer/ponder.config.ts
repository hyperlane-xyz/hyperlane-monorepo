import { createConfig } from 'ponder';

import { InterchainGasPaymasterAbi } from './abis/InterchainGasPaymaster.js';
import { MailboxAbi } from './abis/Mailbox.js';
import { MerkleTreeHookAbi } from './abis/MerkleTreeHook.js';
import {
  type DeployEnv,
  buildPonderChains,
  loadChainConfigs,
} from './src/config/chains.js';
import {
  buildIgpContractConfig,
  buildMailboxContractConfig,
  buildMerkleTreeHookContractConfig,
  loadContractAddresses,
} from './src/config/contracts.js';

// Load environment
const deployEnv = (process.env.DEPLOY_ENV || 'testnet4') as DeployEnv;

// Note: Scripts use `--log-level error` to suppress warnings about eth_getBlockReceipts
// failures. Some RPC providers don't support this batch method, causing Ponder to emit
// warnings with stack traces. However, Ponder automatically falls back to individual
// eth_getTransactionReceipt calls, so these warnings are benign. Use `dev:verbose` to
// see all logs when debugging.

// Load chain configs and addresses
const chains = await loadChainConfigs(deployEnv);
const addresses = await loadContractAddresses(chains);

// Log startup summary (eslint-disable needed: ponder.config.ts runs before logger init)
const chainNames = chains.map((c) => c.name).join(', ');
// eslint-disable-next-line no-console
console.log(
  `[indexer] Starting ${deployEnv} indexer for ${chains.length} chains: ${chainNames}`,
);

// Build Ponder configuration
export default createConfig({
  database: {
    kind: 'postgres',
    connectionString: process.env.DATABASE_URL,
    poolConfig: {
      max: 30,
    },
  },

  chains: buildPonderChains(chains),

  contracts: {
    Mailbox: buildMailboxContractConfig(chains, addresses, MailboxAbi),
    InterchainGasPaymaster: buildIgpContractConfig(
      chains,
      addresses,
      InterchainGasPaymasterAbi,
    ),
    MerkleTreeHook: buildMerkleTreeHookContractConfig(
      chains,
      addresses,
      MerkleTreeHookAbi,
    ),
  },
});
