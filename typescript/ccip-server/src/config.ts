import dotenvFlow from 'dotenv-flow';

dotenvFlow.config();

const RPC_ADDRESS = process.env.RPC_ADDRESS as string;
const LIGHT_CLIENT_ADDR = process.env.LIGHT_CLIENT_ADDR as string;
const STEP_FN_ID = process.env.STEP_FN_ID as string;
const CHAIN_ID = process.env.CHAIN_ID as string;
const SUCCINCT_PLATFORM_URL = process.env.SUCCINCT_PLATFORM_URL as string;
const SUCCINCT_API_KEY = process.env.SUCCINCT_API_KEY as string;
const SERVER_PORT = process.env.SERVER_PORT as string;
const SERVER_URL_PREFIX = process.env.SERVER_URL_PREFIX as string;
const HYPERLANE_EXPLORER_API = process.env.HYPERLANE_EXPLORER_API as string;

// OPStack service
const L2_RPC_ADDRESS = process.env.L2_RPC_ADDRESS as string;
const L2_CHAIN_ID = process.env.L2_CHAIN_ID as string;
const L1_ADDRESS_MANAGER = process.env.L1_ADDRESS_MANAGER as string;
const L1_CROSS_DOMAIN_MESSENGER = process.env
  .L1_CROSS_DOMAIN_MESSENGER as string;
const L1_STANDARD_BRIDGE = process.env.L1_STANDARD_BRIDGE as string;
const L1_STATE_COMMITMENT_CHAIN = process.env
  .L1_STATE_COMMITMENT_CHAIN as string;
const L1_CANONICAL_TRANSACTION_CHAIN = process.env
  .L1_CANONICAL_TRANSACTION_CHAIN as string;
const L1_BOND_MANAGER = process.env.L1_BOND_MANAGER as string;
const L1_OPTIMISM_PORTAL = process.env.L1_OPTIMISM_PORTAL as string;
const L2_OUTPUT_ORACLE = process.env.L2_OUTPUT_ORACLE as string;

// CCTP
const CCTP_ATTESTATION_API = process.env.CCTP_ATTESTATION_API as string;

export {
  RPC_ADDRESS,
  L2_RPC_ADDRESS,
  LIGHT_CLIENT_ADDR,
  STEP_FN_ID,
  CHAIN_ID,
  L2_CHAIN_ID,
  SUCCINCT_PLATFORM_URL,
  SUCCINCT_API_KEY,
  SERVER_PORT,
  SERVER_URL_PREFIX,
  HYPERLANE_EXPLORER_API,
  L1_ADDRESS_MANAGER,
  L1_CROSS_DOMAIN_MESSENGER,
  L1_STANDARD_BRIDGE,
  L1_STATE_COMMITMENT_CHAIN,
  L1_CANONICAL_TRANSACTION_CHAIN,
  L1_BOND_MANAGER,
  L1_OPTIMISM_PORTAL,
  L2_OUTPUT_ORACLE,
  CCTP_ATTESTATION_API,
};
