import { Server } from '@chainlink/ccip-read-server';

import { ProofsServiceAbi } from './abis/ProofsServiceAbi';
import * as config from './config';
import { ProofsService } from './services/ProofsService';

// Initialize Services
const proofsService = new ProofsService(
  {
    lightClientAddress: config.LIGHT_CLIENT_ADDR,
    stepFunctionId: config.STEP_FN_ID,
    platformUrl: config.SUCCINCT_PLATFORM_URL,
    apiKey: config.SUCCINCT_API_KEY,
  },
  { url: config.RPC_ADDRESS, chainId: config.CHAIN_ID },
  { url: `${config.SERVER_URL_PREFIX}:${config.SERVER_PORT}` },
);

// Initialize Server and add Service handlers
const server = new Server();

server.add(ProofsServiceAbi, [
  { type: 'getProofs', func: proofsService.getProofs.bind(this) },
]);

// Start Server
const app = server.makeApp(config.SERVER_URL_PREFIX);
app.listen(config.SERVER_PORT, () =>
  console.log(`Listening on port ${config.SERVER_PORT}`),
);
