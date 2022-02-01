import {
  dev,
  staging,
  prod,
  prodLegacy
} from 'optics-multi-provider-community';
import config from './config';

// register prod
prod.registerRpcProvider('celo', config.celoRpc);
prod.registerRpcProvider('ethereum', config.ethereumRpc);
prod.registerRpcProvider('polygon', config.polygonRpc);
prod.registerRpcProvider('avalanche', config.avalancheRpc);

prodLegacy.registerRpcProvider('celo', config.celoRpc);
prodLegacy.registerRpcProvider('ethereum', config.ethereumRpc);
prodLegacy.registerRpcProvider('polygon', config.polygonRpc);

// register staging
staging.registerRpcProvider('alfajores', config.alfajoresRpc);
staging.registerRpcProvider('kovan', config.kovanRpc);

// register dev
dev.registerRpcProvider('alfajores', config.alfajoresRpc);
dev.registerRpcProvider('kovan', config.kovanRpc);

export { prod, staging, dev, prodLegacy };
