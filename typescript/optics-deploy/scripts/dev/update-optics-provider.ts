import { updateProviderDomain } from '../../src/provider';
import { makeCoreDeploys } from '../../src/core/CoreDeploy';
import { makeBridgeDeploys } from '../../src/bridge/BridgeDeploy';
import { core } from '../../config/environments/dev/core';
import { chains } from '../../config/environments/dev/chains';

const environment = 'dev';
const coreDeploys = makeCoreDeploys(environment, chains, core);
const bridgeDeploys = makeBridgeDeploys(environment, chains);

updateProviderDomain(environment, coreDeploys, bridgeDeploys);
