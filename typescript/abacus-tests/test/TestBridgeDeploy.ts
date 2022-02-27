import { BytesLike, Signer } from 'ethers';
import {
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
} from '@abacus-network/ts-interface/dist/abacus-core';
import {
  BridgeToken,
  BridgeToken__factory,
  MockCore,
  MockCore__factory,
  MockWeth,
  MockWeth__factory,
} from '@abacus-network/ts-interface/dist/abacus-xapps';
import { TokenIdentifier } from '@abacus-network/sdk/dist/abacus/tokens';

import { BridgeDeploy } from '@abacus-network/abacus-deploy/dist/src/bridge/BridgeDeploy';
import { BridgeContracts } from '@abacus-network/abacus-deploy/dist/src/bridge/BridgeContracts';
import * as process from '@abacus-network/abacus-deploy/dist/src/bridge';
import { ChainConfig } from '@abacus-network/abacus-deploy/dist/src/config/chain';
import { CoreConfig } from '@abacus-network/abacus-deploy/dist/src/config/core';
import { DeployEnvironment } from '@abacus-network/abacus-deploy/dist/src/deploy';

function toBytes32(address: string): string {
  return '0x' + '00'.repeat(12) + address.slice(2);
}

// A BridgeRouter deployed with a mock Core suite.
//
// Intended usage: instatiate in hardhat tests with `deploy`. Interact with
// the Bridge contracts as normal. Dispatch messages to the bridge using
// router's `handle` function. The test signer is pre-authorized. Messages the
// router dispatches will be logged in the `Enqueue` event on the `MockCore`
// contract.
export default class TestBridgeDeploy extends BridgeDeploy {
  ubc: UpgradeBeaconController;
  mockCore: MockCore;
  mockWeth: MockWeth;
  localDomain: number;

  constructor(
    ubc: UpgradeBeaconController,
    mockCore: MockCore,
    mockWeth: MockWeth,
    contracts: BridgeContracts,
    domain: number,
    chain: ChainConfig,
    callerKnowsWhatTheyAreDoing: boolean = false,
  ) {
    if (!callerKnowsWhatTheyAreDoing) {
      throw new Error("Don't instantiate via new.");
    }
    const coreContractAddresses = {
      home: {
        proxy: mockCore.address,
        implementation: mockCore.address,
        beacon: mockCore.address,
      },
      governanceRouter: {
        proxy: mockCore.address,
        implementation: mockCore.address,
        beacon: mockCore.address,
      },
      xAppConnectionManager: mockCore.address,
      upgradeBeaconController: mockCore.address,
      updaterManager: mockCore.address,
    };
    super(chain, DeployEnvironment.test, true, coreContractAddresses);
    this.ubc = ubc;
    this.mockCore = mockCore;
    this.mockWeth = mockWeth;
    this.localDomain = domain;
    this.config.weth = mockWeth.address;
    this.contracts = contracts;
  }

  static async deploy(
    gtc: (
      domain: number,
      updater: string,
      watchers: string[],
      recoveryManager?: string | undefined,
      weth?: string | undefined,
    ) => Promise<[ChainConfig, CoreConfig]>,
    ethers: any,
    signer: Signer,
  ): Promise<TestBridgeDeploy> {
    const mockCore = await new MockCore__factory(signer).deploy();
    const mockWeth = await new MockWeth__factory(signer).deploy();
    const ubc = await new UpgradeBeaconController__factory(signer).deploy();
    const contracts = new BridgeContracts();
    const domain = await mockCore.localDomain();
    const [chain] = await gtc(domain, '', [], '', mockWeth.address);
    chain.signer = signer;

    let deploy = new TestBridgeDeploy(
      ubc,
      mockCore,
      mockWeth,
      contracts,
      domain,
      chain,
      true,
    );

    await process.deployTokenUpgradeBeacon(deploy);
    await process.deployBridgeRouter(deploy);
    await process.deployEthHelper(deploy);

    // enroll the signer as a remote BridgeRouter
    // so the test BridgeRouter will accept messages
    // directly from the signer
    await contracts.bridgeRouter?.proxy.enrollRemoteRouter(
      1,
      toBytes32(await signer.getAddress()),
    );

    return deploy;
  }

  get ubcAddress(): string {
    return this.ubc.address;
  }

  get coreDeployPath() {
    return '';
  }
  get overrides() {
    return {};
  }
  get config() {
    return { weth: this.mockWeth.address };
  }

  get bridgeRouter() {
    return this.contracts.bridgeRouter?.proxy;
  }

  get remoteDomain(): number {
    return 1;
  }

  get testToken(): string {
    return `0x${'11'.repeat(32)}`;
  }

  get testTokenId(): TokenIdentifier {
    return {
      domain: this.remoteDomain,
      id: this.testToken,
    };
  }

  writeOutput() {}

  async getTestRepresentation(): Promise<BridgeToken | undefined> {
    return await this.getRepresentation(this.remoteDomain, this.testToken);
  }

  async getRepresentation(
    domain: number,
    canonicalTokenAddress: BytesLike,
  ): Promise<BridgeToken | undefined> {
    const reprAddr = await this.bridgeRouter![
      'getLocalAddress(uint32,bytes32)'
    ](domain, canonicalTokenAddress);

    if (domain === 0) {
      return undefined;
    }

    return BridgeToken__factory.connect(reprAddr, this.signer);
  }
}
