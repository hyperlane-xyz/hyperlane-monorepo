/**
 * Test timeout for operations that require node startup and deployment
 */
export const DEFAULT_E2E_TEST_TIMEOUT = 180_000; // Tron nodes take longer to start

/**
 * Test private key for Tron local network
 * This is the witness key from local-node/conf/config.conf
 * Corresponds to address: TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY
 */
export const TEST_TRON_PRIVATE_KEY =
  'da146374a75310b9666e834ee4ad0866d6f4035967bfc76217c5a495fff9f0d0';

/**
 * Test deployer address derived from TEST_TRON_PRIVATE_KEY
 * EVM-compatible hex address
 */
export const TEST_TRON_DEPLOYER_ADDRESS =
  '0x970BF2D2a8691BB27D9b7A7c32B3DdF7a8Cac3F8';

/**
 * Tron base58 address for the test account
 */
export const TEST_TRON_BASE58_ADDRESS = 'TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY';

/**
 * Max fee limit for Tron transactions (1000 TRX in sun)
 */
export const MAX_FEE_LIMIT = 1_000_000_000;
