import { BigNumber, BytesLike, Signer } from 'ethers';
import {
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
} from 'optics-ts-interface/dist/optics-core';
import {
  BridgeRouter,
  BridgeToken,
  BridgeToken__factory,
  MockCore,
  MockCore__factory,
  MockWeth,
  MockWeth__factory,
} from 'optics-ts-interface/dist/optics-xapps';
import { BridgeContracts } from './BridgeContracts';
import * as process from '.';
import { ChainName, ChainConfig, ChainConfigJson } from '../../src/config/chain';
import { CoreConfig } from '../../src/config/core';
import { Deploy } from '../deploy';

import { TokenIdentifier } from '@abacus-network/sdk/dist/optics/tokens';

function toBytes32(address: string): string {
  return '0x' + '00'.repeat(12) + address.slice(2);
}

export async function getTestChain(
  ethers: any,
  domain: number,
  updater: string,
  watchers: string[],
): Promise<[ChainConfig, CoreConfig]> {
  const [, , , , , , , signer] = await ethers.getSigners();
  const chainConfigJson: ChainConfigJson = {
    name: ChainName.ALFAJORES,
    rpc: '',
    deployerKey: '', 
    domain,
    confirmations: 0,
    gasPrice: BigNumber.from(20000000000),
    gasLimit: BigNumber.from(6_000_000),
  }
  const chainConfig = new ChainConfig(chainConfigJson);
  chainConfig.replaceSigner(signer)
  return [
    chainConfig, 
    {
      environment: 'dev',
      recoveryTimelock: 1,
      optimisticSeconds: 3,
      processGas: 850_000,
      reserveGas: 15_000,
      addresses: {
        alfajores: {
          updater,
          watchers,
          recoveryManager: signer.address,
        }
      }
    },
  ];
}

// A BridgeRouter deployed with a mock Core suite.
//
// Intended usage: instatiate in hardhat tests with `deploy`. Interact with
// the Bridge contracts as normal. Dispatch messages to the bridge using
// router's `handle` function. The test signer is pre-authorized. Messages the
// router dispatches will be logged in the `Enqueue` event on the `MockCore`
// contract.
export default class TestBridgeDeploy extends Deploy<BridgeContracts> {
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
    chainConfig: ChainConfig,
    callerKnowsWhatTheyAreDoing: boolean = false,
  ) {
    if (!callerKnowsWhatTheyAreDoing) {
      throw new Error("Don't instantiate via new.");
    }
    super(chainConfig, contracts, 'test', true);
    this.ubc = ubc;
    this.mockCore = mockCore;
    this.mockWeth = mockWeth;
    this.localDomain = domain;
    this.config.weth = mockWeth.address;
  }

  static async deploy(ethers: any, signer: Signer): Promise<TestBridgeDeploy> {
    const mockCore = await new MockCore__factory(signer).deploy();
    const mockWeth = await new MockWeth__factory(signer).deploy();
    const ubc = await new UpgradeBeaconController__factory(signer).deploy();
    const contracts = new BridgeContracts();
    const domain = await mockCore.localDomain();
    const [chainConfig] = await getTestChain(ethers, domain, '', []);
    chainConfig.signer = signer;

    let deploy = new TestBridgeDeploy(
      ubc,
      mockCore,
      mockWeth,
      contracts,
      domain,
      chainConfig,
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

  get coreContractAddresses() {
    return {
      xAppConnectionManager: this.mockCore.address,
      home: { proxy: this.mockCore.address },
      governanceRouter: { proxy: this.mockCore.address },
    };
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

  get bridgeRouter(): BridgeRouter | undefined {
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

  writeOutput() {};

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
