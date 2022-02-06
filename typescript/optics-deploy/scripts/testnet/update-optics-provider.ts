import { updateProviderDomain } from '../../src/provider';
import { CoreDeploy } from '../../src/core/CoreDeploy';
import { BridgeDeploy } from '../../src/bridge/BridgeDeploy';
import { core } from '../../config/environments/testnet/core';
import { chains } from '../../config/environments/testnet/chains';

const environment = 'testnet';
const directory = `../../config/environments/${environment}/contracts`;
const coreDeploys = chains.map((c) => CoreDeploy.fromDirectory(directory, c, core))
const bridgeDeploys = chains.map((c) => BridgeDeploy.fromDirectory(directory, c, environment))

updateProviderDomain(environment, coreDeploys, bridgeDeploys);
