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
const L2_RPC_ADDRESS = process.env.L2_RPC_ADDRESS as string;
const L2_CHAIN_ID = process.env.L2_CHAIN_ID as string;
const HYPERLANE_EXPLORER_API = process.env.HYPERLANE_EXPLORER_API as string;

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
};
