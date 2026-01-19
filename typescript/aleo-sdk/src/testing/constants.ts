import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { type TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';

/**
 * Test timeout for operations that require node startup and deployment
 */
export const DEFAULT_E2E_TEST_TIMEOUT = 100_000;

/**
 * Test private key for Aleo local network
 * This matches the key used in docker-compose.yml with pre-funded account
 */
export const TEST_ALEO_PRIVATE_KEY =
  'APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH';

/**
 * Docker image for Aleo devnode
 */
export const ALEO_DEVNODE_IMAGE =
  'gcr.io/abacus-labs-dev/hyperlane-aleo-tools:v1.0.1';

/**
 * Environment variables for Aleo devnode
 */
export const TEST_ALEO_ENV = {
  NETWORK: 'testnet',
  PRIVATE_KEY: 'APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH',
  ENDPOINT: 'http://0.0.0.0:3030',
  CONSENSUS_VERSION_HEIGHTS: '0,1,2,3,4,5,6,7,8,9,10,11',
  CREATE_BLOCK: 'true',
};

/**
 * Default test chain metadata for Aleo local network
 */
export const TEST_ALEO_CHAIN_METADATA: TestChainMetadata = {
  name: 'aleotest',
  protocol: ProtocolType.Aleo,
  chainId: 1,
  domainId: 1413831649,
  nativeToken: {
    decimals: 6,
    name: 'Aleo Credits',
    symbol: 'ALEO',
    denom: 'microcredits',
  },
  blocks: {
    confirmations: 0,
    estimateBlockTime: 5,
  },
  rpcUrls: [
    {
      http: 'http://127.0.0.1:3030',
    },
  ],
  rpcPort: 3030,
  rpcUrl: 'http://127.0.0.1:3030',
};
