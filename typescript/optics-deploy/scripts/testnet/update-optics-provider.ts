import { updateProviderDomain } from '../../src/provider';
import { makeCoreDeploys } from '../../src/core/CoreDeploy';
import { makeBridgeDeploys } from '../../src/bridge/BridgeDeploy';
import { core } from '../../config/environments/testnet/core';
import { chains } from '../../config/environments/testnet/chains';

const environment = 'testnet';
const coreDeploys = makeCoreDeploys(environment, chains, core);
const bridgeDeploys = makeBridgeDeploys(environment, chains);

updateProviderDomain(environment, coreDeploys, bridgeDeploys);
