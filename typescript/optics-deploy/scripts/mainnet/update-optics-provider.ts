import { updateProviderDomain } from '../../src/provider';
import { makeCoreDeploys } from '../../src/core/CoreDeploy';
import { makeBridgeDeploys } from '../../src/bridge/BridgeDeploy';
import { core } from '../../config/environments/mainnet/core';
import { chains } from '../../config/environments/mainnet/chains';

const environment = 'mainnet';
const coreDeploys = makeCoreDeploys(environment, chains, core);
const bridgeDeploys = makeBridgeDeploys(environment, chains);

updateProviderDomain(environment, coreDeploys, bridgeDeploys);
