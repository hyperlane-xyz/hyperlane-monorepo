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

// Debug: print chain configs
for (const chain of chains) {
  console.log(
    `  ${chain.name}: chainId=${chain.chainId}, startBlock=${chain.startBlock}, rpc=${chain.rpcUrl?.slice(0, 50)}...`,
  );
}

// Debug: print addresses
console.log('Contract addresses:');
for (const [name, addr] of Object.entries(addresses)) {
  console.log(
    `  ${name}: mailbox=${addr.mailbox}, igp=${addr.interchainGasPaymaster}`,
  );
}

const networks = buildPonderNetworks(chains);
console.log('Networks:', Object.keys(networks));

const mailboxConfig = buildMailboxContractConfig(chains, addresses, MailboxAbi);
console.log('Mailbox networks:', Object.keys(mailboxConfig.network));
console.log('Mailbox config:', JSON.stringify(mailboxConfig, null, 2));

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
    // Try includeTransactionReceipts at contract level
    Mailbox: {
      ...buildMailboxContractConfig(chains, addresses, MailboxAbi),
      includeTransactionReceipts: true,
    },
    InterchainGasPaymaster: {
      ...buildIgpContractConfig(chains, addresses, InterchainGasPaymasterAbi),
      includeTransactionReceipts: true,
    },
    MerkleTreeHook: {
      ...buildMerkleTreeHookContractConfig(
        chains,
        addresses,
        MerkleTreeHookAbi,
      ),
      includeTransactionReceipts: true,
    },
  },
});
