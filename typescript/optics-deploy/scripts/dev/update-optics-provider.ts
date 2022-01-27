import * as alfajores from '../../config/testnets/alfajores';
import * as kovan from '../../config/testnets/kovan';
import * as gorli from '../../config/testnets/gorli';
import * as fuji from '../../config/testnets/fuji';
import * as mumbai from '../../config/testnets/mumbai';
import { updateProviderDomain } from '../../src/provider';
import { configPath } from './agentConfig';
import { makeCoreDeploys } from '../../src/core/CoreDeploy';
import { makeBridgeDeploys } from '../../src/bridge/BridgeDeploy';

const networks = [alfajores, kovan, gorli, fuji, mumbai];
const chainAccessor = (_: any) => _.chain;
const coreDeploys = makeCoreDeploys(configPath, networks, chainAccessor, (_) => _.devConfig);
const bridgeDeploys = makeBridgeDeploys(configPath, networks, chainAccessor, (_) => _.bridgeConfig);
updateProviderDomain('dev', configPath, coreDeploys, bridgeDeploys);
