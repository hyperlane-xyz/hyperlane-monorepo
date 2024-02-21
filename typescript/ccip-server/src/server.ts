import { Server } from '@chainlink/ccip-read-server';
import { log } from 'console';

import { ProofsServiceAbi } from './abis/ProofsServiceAbi';
import * as config from './config';
import { ProofsService } from './services/ProofsService';

// Initalize Services
const proofsService = new ProofsService(
  config.LIGHT_CLIENT_ADDR,
  config.RPC_ADDRESS,
  config.STEP_FN_ID,
  config.CHAIN_ID,
  config.SUCCINCT_PLATFORM_URL,
  config.SUCCINCT_API_KEY,
  config.HYPERLANE_API_URL,
);

// Initalize Server and add Service handlers
const server = new Server();

server.add(ProofsServiceAbi, [proofsService.handler('getProofs')]);

// Start Server
const app = server.makeApp(config.SERVER_URL_PREFIX);
app.listen(config.SERVER_PORT || 3001, () =>
  log(`Listening on port ${config.SERVER_PORT}`),
);
