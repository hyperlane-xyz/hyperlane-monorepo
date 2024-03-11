import { Server } from '@chainlink/ccip-read-server';
import { log } from 'console';

import { ProofsServiceAbi } from './abis/ProofsServiceAbi';
import * as config from './config';
import { ProofsService } from './services/ProofsService';

// Initalize Services
const proofsService = new ProofsService(
  // SuccinctConfig
  {
    stepFunctionId: config.STEP_FN_ID,
    lightClientAddress: config.LIGHT_CLIENT_ADDR,
    apiKey: config.SUCCINCT_API_KEY,
    platformUrl: config.SUCCINCT_PLATFORM_URL,
    chainId: config.CHAIN_ID,
  },
  // RpcConfig
  {
    url: config.RPC_ADDRESS,
    chainId: config.CHAIN_ID,
  },
  // HyperlaneConfig
  {
    url: config.HYPERLANE_API_URL,
  },
);

// Initalize Server and add Service handlers
const server = new Server();

server.add(ProofsServiceAbi, [
  { type: 'getProofs', func: proofsService.getProofs.bind(this) },
]);

// Start Server
const app = server.makeApp(config.SERVER_URL_PREFIX);
app.listen(config.SERVER_PORT, () =>
  log(`Listening on port ${config.SERVER_PORT}`),
);
