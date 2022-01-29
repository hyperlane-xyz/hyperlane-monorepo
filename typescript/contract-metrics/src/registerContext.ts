import {devCommunity, mainnetCommunity, staging} from "optics-multi-provider-community";
import config from "./config";

// register mainnet
mainnetCommunity.registerRpcProvider('celo', config.celoRpc);
mainnetCommunity.registerRpcProvider('ethereum', config.ethereumRpc);
mainnetCommunity.registerRpcProvider('polygon', config.polygonRpc);
mainnetCommunity.registerRpcProvider('avalanche', config.avalancheRpc);

// register staging
staging.registerRpcProvider('alfajores', config.alfajoresRpc);
staging.registerRpcProvider('kovan', config.kovanRpc);

// register devCommunity
devCommunity.registerRpcProvider('alfajores', config.alfajoresRpc);
devCommunity.registerRpcProvider('kovan', config.kovanRpc);

export {
    mainnetCommunity, staging, devCommunity
};