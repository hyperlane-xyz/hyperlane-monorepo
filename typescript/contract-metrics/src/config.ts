import { ChainName } from '@abacus-network/sdk';
import Logger from 'bunyan';
import * as dotenv from 'dotenv';
import { MetricCollector } from './metrics';

dotenv.config({ path: process.env.CONFIG_PATH ?? '.env' });

const environment = process.env.ENVIRONMENT ?? 'dev';

let networks: ChainName[];
switch (environment) {
  case 'mainnet':
    networks = ['celo', 'ethereum', 'polygon', 'avalanche'];
    break;

  case 'testnet':
    networks = ['alfajores', 'goerli', 'kovan', 'ropsten'];
    break;

  default:
    // dev
    networks = ['alfajores', 'fuji', 'goerli', 'kovan', 'mumbai'];
    break;
}

const baseLogger = Logger.createLogger({
  name: 'contract-metrics',
  serializers: Logger.stdSerializers,
  level: 'debug',
  environment: environment,
});

const metrics = new MetricCollector(baseLogger);

export default {
  baseLogger: baseLogger,
  metrics: metrics,
  networks: networks,
  environment: environment,
  celoRpc: process.env.CELO_RPC ?? '',
  ethereumRpc: process.env.ETHEREUM_RPC ?? '',
  polygonRpc: process.env.POLYGON_RPC ?? '',
  avalancheRpc: process.env.AVALANCHE_RPC ?? '',
  alfajoresRpc: process.env.ALFAJORES_RPC ?? '',
  kovanRpc: process.env.KOVAN_RPC ?? '',
  rinkebyRpc: process.env.RINKEBY_RPC ?? '',
  gorliRpc: process.env.GORLI_RPC ?? '',
  ropstenRpc: process.env.ROPSTEN_RPC ?? '',
  fujiRpc: process.env.FUJI_RPC ?? '',
  mumbaiRpc: process.env.MUMBAI_RPC ?? '',
  googleCredentialsFile:
    process.env.GOOGLE_CREDENTIALS_FILE ?? './credentials.json',
};
