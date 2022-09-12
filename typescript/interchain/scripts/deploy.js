'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
const ethers_1 = require('ethers');
const sdk_1 = require('@abacus-network/sdk');
const config_1 = require('../deploy/config');
const RipDeployer_1 = require('../deploy/RipDeployer');
async function main() {
  console.info('Getting signer');
  const signer = new ethers_1.Wallet('pkey');
  console.info('Preparing utilities');
  const chainProviders = (0, sdk_1.objMap)(
    config_1.prodConfigs,
    (_, config) => ({
      provider: config.provider,
      confirmations: config.confirmations,
      overrides: config.overrides,
      signer: new ethers_1.Wallet('pkey', config.provider),
    }),
  );
  const multiProvider = new sdk_1.MultiProvider(chainProviders);
  const core = sdk_1.AbacusCore.fromEnvironment('testnet2', multiProvider);
  const config = core.extendWithConnectionClientConfig(
    (0, sdk_1.getChainToOwnerMap)(config_1.prodConfigs, signer.address),
  );
  const deployer = new RipDeployer_1.RemoteIdentityProxyRouterDeployer(
    multiProvider,
    config,
    core,
  );
  const chainToContracts = await deployer.deploy();
  const addresses = (0, sdk_1.serializeContracts)(chainToContracts);
  console.info('===Contract Addresses===');
  console.info(JSON.stringify(addresses));
}
main()
  .then(() => console.info('Deploy complete'))
  .catch(console.error);
