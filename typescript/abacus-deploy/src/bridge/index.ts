export { BridgeDeploy } from './BridgeDeploy';
export { BridgeInstance } from './BridgeInstance';
export { BridgeContracts } from './BridgeContracts';
export { BridgeInvariantChecker } from './BridgeInvariantChecker';
export {
  BridgeContractAddresses,
  BridgeAddresses,
  BridgeConfig,
  BridgeConfigWithoutCore,
} from './types';

/*
  // transfer ownership of BridgeRouters to Bridge
  await Promise.all(
    deploys.map(async (deploy) => {
      await transferOwnershipToBridge(deploy);
    }),
  );

  const checker = new BridgeInvariantChecker(deploys);
  await checker.checkDeploys();
  checker.expectEmpty();
export async function transferOwnershipToBridge(deploy: BridgeDeploy) {
  console.log(`transfer ownership of ${deploy.chain.name} BridgeRouter`);

  let tx = await deploy.contracts.bridgeRouter!.proxy.transferOwnership(
    deploy.coreContractAddresses.governanceRouter.proxy,
    deploy.overrides,
  );

  await tx.wait(deploy.chain.confirmations);

  console.log(`transferred ownership of ${deploy.chain.name} BridgeRouter`);
}
  */
