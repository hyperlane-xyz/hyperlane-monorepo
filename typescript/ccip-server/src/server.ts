import { Server } from '@chainlink/ccip-read-server';
import { ethers } from 'ethers';

import { ProofsServiceAbi } from './abis/ProofsServiceAbi';
import * as config from './config';
import { LightClientService } from './services/LightClientService';
import { ProofsService } from './services/ProofsService';
import { RPCService } from './services/RPCService';

const rpcService = new RPCService(config.RPC_ADDRESS);
const lightClient = new ethers.Contract(
  config.LIGHT_CLIENT_ADDR,
  ProofsServiceAbi,
  rpcService.provider,
);
const lightClientService = new LightClientService(
  lightClient,
  config.STEP_FN_ID,
  config.CHAIN_ID,
  config.SUCCINCT_PLATFORM_URL,
  config.SUCCINCT_API_KEY,
);
const proofsService = new ProofsService(rpcService, lightClientService);

const server = new Server();
server.add(ProofsServiceAbi, [
  {
    type: 'getProofs',
    func: proofsService.getProofs,
  },
]);
const app = server.makeApp(config.SERVER_URL_PREFIX);
app.listen(config.SERVER_PORT, () =>
  console.log(`Listening on port ${config.SERVER_PORT}`),
);
