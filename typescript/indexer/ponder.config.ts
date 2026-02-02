import { createConfig } from 'ponder';

import { InterchainGasPaymasterAbi } from './abis/InterchainGasPaymaster.js';
import { MailboxAbi } from './abis/Mailbox.js';
import { MerkleTreeHookAbi } from './abis/MerkleTreeHook.js';
import {
  type DeployEnv,
  buildPonderNetworks,
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

// Load chain configs and addresses
const chains = await loadChainConfigs(deployEnv);
const addresses = await loadContractAddresses(chains);

console.log(
  `Loaded ${chains.length} chains for ${deployEnv}:`,
  chains.map((c) => c.name).join(', '),
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

  networks: buildPonderNetworks(chains),

  contracts: {
    Mailbox: {
      ...buildMailboxContractConfig(chains, addresses, MailboxAbi),
      // Include transaction receipts for full tx log indexing (FR-9)
      includeTransactionReceipts: true,
    },
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
