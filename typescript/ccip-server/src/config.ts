import dotenvFlow from 'dotenv-flow';

dotenvFlow.config();

const RPC_ADDRESS = process.env.RPC_ADDRESS as string;
const SERVER_PORT = process.env.SERVER_PORT as string;
const SERVER_URL_PREFIX = process.env.SERVER_URL_PREFIX as string;
const HYPERLANE_API_URL = process.env.HYPERLANE_API_URL as string;

export { RPC_ADDRESS, SERVER_PORT, SERVER_URL_PREFIX, HYPERLANE_API_URL };
