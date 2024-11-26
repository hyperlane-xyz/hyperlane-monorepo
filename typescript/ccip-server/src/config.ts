import dotenvFlow from 'dotenv-flow';

dotenvFlow.config();

const RPC_ADDRESS = process.env.RPC_ADDRESS as string;
const CONSENSUS_API_URL = process.env.CONSENSUS_API_URL as string;
const CHAIN_ID = process.env.CHAIN_ID as string;
const SERVER_PORT = process.env.SERVER_PORT as string;
const SERVER_URL_PREFIX = process.env.SERVER_URL_PREFIX as string;

export {
  RPC_ADDRESS,
  CONSENSUS_API_URL,
  CHAIN_ID,
  SERVER_PORT,
  SERVER_URL_PREFIX,
};
