import { expect } from 'chai';

import { assertBeaconProxy } from '../core/checks';
import { FundraiseDeploy as Deploy } from './FundraiseDeploy';
// import TestBridgeDeploy from './TestFundraiseDeploy;
import { checkVerificationInput } from '../core/checks';

const emptyAddr = '0x' + '00'.repeat(32);

export async function checkFundraiseDeploy(
  deploy: Deploy,
  remotes: number[],
) {
  assertBeaconProxy(deploy.contracts.fundraiseRouter!);
  const fundraiseRouter = deploy.contracts.fundraiseRouter?.proxy!;
  await Promise.all(
    remotes.map(async (remoteDomain) => {
      const registeredRouter = await fundraiseRouter.remotes(remoteDomain);
      expect(registeredRouter).to.not.equal(emptyAddr);
    }),
  );

  if (deploy.chain.domain === 3000) {
    const governanceToken = await deploy.contracts.governanceToken?.proxy!;
    const owner = await governanceToken.owner()
    expect(owner).to.equal(fundraiseRouter.address)
  }

  // TODO: Fix this
  console.log("AM NOT CHECKING OWNERSHIP")
  // expect(await fundraiseRouter.owner()).to.equal(
  //   deploy.coreContractAddresses.governance.proxy,
  // );

  // check verification addresses
  checkVerificationInput(
    deploy,
    'FundraiseRouter Implementation',
    deploy.contracts.fundraiseRouter?.implementation.address!,
  );
  checkVerificationInput(
    deploy,
    'FundraiseRouter UpgradeBeacon',
    deploy.contracts.fundraiseRouter?.beacon.address!,
  );
  checkVerificationInput(
    deploy,
    'FundraiseRouter Proxy',
    deploy.contracts.fundraiseRouter?.proxy.address!,
  );
}
