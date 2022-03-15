import {
  dev,
  testnet,
  mainnet,
  mainnetLegacy,
  AbacusContext,
} from '@abacus-network/sdk';
import config from './config';

// register mainnet
mainnet.registerRpcProvider('celo', config.celoRpc);
mainnet.registerRpcProvider('ethereum', config.ethereumRpc);
mainnet.registerRpcProvider('polygon', config.polygonRpc);

mainnetLegacy.registerRpcProvider('celo', config.celoRpc);
mainnetLegacy.registerRpcProvider('ethereum', config.ethereumRpc);
mainnetLegacy.registerRpcProvider('polygon', config.polygonRpc);

// register testnet
testnet.registerRpcProvider('alfajores', config.alfajoresRpc);
testnet.registerRpcProvider('kovan', config.kovanRpc);
testnet.registerRpcProvider('gorli', config.gorliRpc);
testnet.registerRpcProvider('ropsten', config.ropstenRpc);

// register dev
dev.registerRpcProvider('alfajores', config.alfajoresRpc);
dev.registerRpcProvider('kovan', config.kovanRpc);
dev.registerRpcProvider('gorli', config.gorliRpc);
dev.registerRpcProvider('mumbai', config.mumbaiRpc);
dev.registerRpcProvider('fuji', config.fujiRpc);

let context: AbacusContext;
switch (config.environment) {
  case 'mainnet':
    context = mainnet;
    break;

  case 'testnet':
    context = testnet;
    break;

  default:
    // dev
    context = dev;
    break;
}

export { context, mainnet, testnet, dev, mainnetLegacy };
