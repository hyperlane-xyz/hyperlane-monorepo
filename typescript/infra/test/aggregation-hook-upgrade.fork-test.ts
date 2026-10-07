import { ChildProcess, spawn, spawnSync } from 'child_process';
import { expect } from 'chai';
import { constants, providers, utils } from 'ethers';
import { createServer } from 'net';

import {
  FallbackDomainRoutingHook__factory,
  HypERC20Collateral__factory,
  IERC20__factory,
  InterchainGasPaymaster__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import type { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  MultiProvider,
  getDomainId as resolveDomainId,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  assert,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { supportedChainNames } from '../config/environments/mainnet3/supportedChainNames.js';
import { getChainMetadata, getDomainId } from '../config/registry.js';
import { createMemoryExportStore } from '../src/aggregation-hook-upgrade/address-export.js';
import { runUpgrade } from '../src/aggregation-hook-upgrade/run.js';
import {
  ChainOutcome,
  UpgradeContext,
  UpgradePersistence,
  UpgradePhase,
} from '../src/aggregation-hook-upgrade/types.js';
import { DEPLOYERS, Owner } from '../src/governance.js';

import { revertMessage } from './aggregation-hook-upgrade.helpers.js';

// Replays the production ERC20 fee failure on a fork of Ethereum mainnet taken
// before the aggregation hook rollout: a USDC TokenRouter deployed by this
// test cannot pay its interchain gas in USDC until the routing hook points at
// a fixed aggregation hook. Once the rollout has landed the pre-fix assertions
// no longer hold at the chain head, so pin an earlier block with
// FORK_BLOCK_NUMBER to replay it.
const ORIGIN = 'ethereum';
const DESTINATION_DOMAIN = 56;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
// FiatToken stores `balanceAndBlacklistStates` at slot 9.
const USDC_BALANCE_SLOT = 9;
const ETHEREUM_IGP = '0x9e6B1022bE9BBF5aFd152483DAD9b88911bC8611';
const ONE_MILLION_USDC = 1_000_000n * 1_000_000n;
const TRANSFER_AMOUNT = 1_000_000n;
const DESTINATION_GAS = 200_000;
const NOW = '2026-10-06T00:00:00.000Z';
const REVERT = 'StaticAggregationHook: insufficient value';

const ethereumAddresses: ChainAddresses = {
  aggregationHook: '0x3d166d2424e47747D81bd71A305A8aee23d33397',
  fallbackRoutingHook: '0x571f1435613381208477ac5d6974310d88AC7cB7',
  interchainGasPaymaster: ETHEREUM_IGP,
  mailbox: '0xc005dc82818d67AF737725bD4bf75435d065D239',
  merkleTreeHook: '0x48e6c30B97748d1e2e03bf3e9FbE3890ca5f8CCA',
  pausableHook: '0x3A66Dc852e56d3748838b3C27CF381105b83705b',
  staticAggregationHookFactory: '0x8E0c6231F36cb081ccBcae5810C1793268D6CA7C',
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('Could not allocate a free port'));
      });
    });
  });
}

async function waitForNode(provider: providers.JsonRpcProvider) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await provider.getBlockNumber();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('anvil did not become ready');
}

describe('aggregation hook upgrade on an Ethereum fork', () => {
  const forkRpcUrl = process.env.FORK_RPC_URL_ETHEREUM;
  const forkBlock = process.env.FORK_BLOCK_NUMBER;
  let anvil: ChildProcess | undefined;
  let provider: providers.JsonRpcProvider;
  let multiProvider: MultiProvider;
  let fixtureOwnerAddress: Address;
  let registry: ChainMap<ChainAddresses>;
  let registryWrites: ChainAddresses[];
  let persist: UpgradePersistence;
  let buildContext: (phase: UpgradePhase, apply: boolean) => UpgradeContext;

  before(async function () {
    if (!forkRpcUrl) this.skip();
    if (spawnSync('anvil', ['--version']).status !== 0) this.skip();

    const port = await freePort();
    const args = [
      '--fork-url',
      forkRpcUrl,
      '--port',
      String(port),
      '--no-rate-limit',
      '--fork-retry-backoff',
      '3',
    ];
    if (forkBlock) args.push('--fork-block-number', forkBlock);
    anvil = spawn('anvil', args, { stdio: 'ignore' });
    provider = new providers.JsonRpcProvider(`http://127.0.0.1:${port}`);
    await waitForNode(provider);

    const deployer = DEPLOYERS.mainnet3;
    fixtureOwnerAddress = utils.getAddress(utils.hexZeroPad('0xf1c7', 20));
    for (const account of [deployer, fixtureOwnerAddress]) {
      await provider.send('anvil_impersonateAccount', [account]);
      await provider.send('anvil_setBalance', [
        account,
        utils.hexValue(utils.parseEther('100')),
      ]);
    }

    const metadata: ChainMetadata = {
      name: ORIGIN,
      chainId: 1,
      domainId: 1,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: `http://127.0.0.1:${port}` }],
      blocks: { confirmations: 0, reorgPeriod: 0, estimateBlockTime: 1 },
      nativeToken: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    };
    multiProvider = new MultiProvider({ [ORIGIN]: metadata });
    multiProvider.setProvider(ORIGIN, provider);
    multiProvider.setSharedSigner(provider.getSigner(deployer));

    const supportedDomains = supportedChainNames.map((chain) => ({
      chain,
      domainId: getDomainId(chain),
    }));
    const registryDomainIds = Object.values(getChainMetadata())
      .filter((chainMetadata) => !chainMetadata.isTestnet)
      .map((chainMetadata) => resolveDomainId(chainMetadata));

    registry = { [ORIGIN]: ethereumAddresses };
    registryWrites = [];
    persist = {
      writeRegistryAddresses: (chain, addresses) => {
        registryWrites.push(addresses);
        registry[chain] = addresses;
      },
      writeVerificationInputs: async () => {},
      writeVerificationRecovery: async (_module, chain) => `memory://${chain}`,
      writeTransactions: async (chain) => `memory://${chain}`,
      exportStore: createMemoryExportStore(),
    };
    buildContext = (phase, apply) => ({
      environment: 'mainnet3',
      phase,
      apply,
      multiProvider,
      chainAddresses: registry,
      supportedDomains,
      registryDomainIds,
      skipLists: { legacyCoreHookRecoveryChains: [], chainsToSkip: [] },
      persist,
      concurrency: 1,
      probeConcurrency: 16,
      logger: rootLogger.child({
        module: 'aggregation-hook-upgrade-fork-test',
      }),
      now: () => NOW,
    });
  });

  after(() => {
    anvil?.kill();
  });

  it('lets an ERC20 fee TokenRouter dispatch through the shadow and production routing hooks', async () => {
    const owner = provider.getSigner(fixtureOwnerAddress);
    const usdc = IERC20__factory.connect(USDC, owner);
    const mailbox = Mailbox__factory.connect(ethereumAddresses.mailbox, owner);
    const igp = InterchainGasPaymaster__factory.connect(ETHEREUM_IGP, owner);
    const productionRouting = FallbackDomainRoutingHook__factory.connect(
      ethereumAddresses.fallbackRoutingHook,
      provider,
    );
    const recipient = utils.hexZeroPad('0xbeef', 32);

    const balanceSlot = utils.keccak256(
      utils.defaultAbiCoder.encode(
        ['address', 'uint256'],
        [fixtureOwnerAddress, USDC_BALANCE_SLOT],
      ),
    );
    await provider.send('anvil_setStorageAt', [
      USDC,
      balanceSlot,
      utils.hexZeroPad(utils.hexValue(ONE_MILLION_USDC), 32),
    ]);
    expect((await usdc.balanceOf(fixtureOwnerAddress)).toString()).to.equal(
      ONE_MILLION_USDC.toString(),
    );

    const router = await new HypERC20Collateral__factory(owner).deploy(
      USDC,
      1,
      1,
      ethereumAddresses.mailbox,
    );
    await (
      await router.initialize(
        constants.AddressZero,
        constants.AddressZero,
        fixtureOwnerAddress,
      )
    ).wait();
    await (await router.setFeeHook(ETHEREUM_IGP)).wait();
    await (
      await router.enrollRemoteRouter(DESTINATION_DOMAIN, recipient)
    ).wait();
    await (
      await router['setDestinationGas(uint32,uint256)'](
        DESTINATION_DOMAIN,
        DESTINATION_GAS,
      )
    ).wait();
    const [gasQuote] = await router.quoteTransferRemote(
      DESTINATION_DOMAIN,
      recipient,
      TRANSFER_AMOUNT,
    );
    expect(gasQuote.token).to.equal(USDC);
    expect(gasQuote.amount.gt(0)).to.equal(true);
    const approveForTransfer = async () =>
      (
        await usdc.approve(router.address, gasQuote.amount.add(TRANSFER_AMOUNT))
      ).wait();
    await approveForTransfer();

    const transfer = () =>
      router.transferRemote(DESTINATION_DOMAIN, recipient, TRANSFER_AMOUNT);
    const expectFeePaid = async () => {
      await approveForTransfer();
      const before = await usdc.balanceOf(ETHEREUM_IGP);
      const receipt = await (await transfer()).wait();
      const after = await usdc.balanceOf(ETHEREUM_IGP);
      expect(after.sub(before).toString()).to.equal(gasQuote.amount.toString());
      const names = receipt.logs
        .filter(
          (log) => log.address.toLowerCase() === ETHEREUM_IGP.toLowerCase(),
        )
        .map((log) => igp.interface.parseLog(log).name);
      expect(names).to.include('GasPayment');
    };
    const nativeDispatch = async () => {
      const quote = await mailbox['quoteDispatch(uint32,bytes32,bytes)'](
        DESTINATION_DOMAIN,
        recipient,
        '0xabcd',
      );
      await (
        await mailbox['dispatch(uint32,bytes32,bytes)'](
          DESTINATION_DOMAIN,
          recipient,
          '0xabcd',
          { value: quote },
        )
      ).wait();
    };

    expect(
      await revertMessage(
        router.callStatic.transferRemote(
          DESTINATION_DOMAIN,
          recipient,
          TRANSFER_AMOUNT,
        ),
      ),
    ).to.include(
      REVERT,
      'The forked block already routes through a fixed aggregation hook; set FORK_BLOCK_NUMBER to a block before the rollout',
    );
    const productionBefore = await productionRouting.hooks(DESTINATION_DOMAIN);

    const [shadowResult] = await runUpgrade(
      buildContext(UpgradePhase.Shadow, true),
      [ORIGIN],
    );
    expect(shadowResult.outcome).to.equal(ChainOutcome.Applied);
    const shadow = shadowResult.shadowRoutingHook;
    assert(shadow, 'expected a shadow routing hook');
    expect(registryWrites).to.have.length(1);
    expect(registryWrites[0].fallbackRoutingHook).to.equal(
      ethereumAddresses.fallbackRoutingHook,
    );
    expect(Object.values(registryWrites[0])).to.not.include(shadow);
    expect(await productionRouting.hooks(DESTINATION_DOMAIN)).to.equal(
      productionBefore,
    );

    await (await router.setHook(shadow)).wait();
    await expectFeePaid();

    const [prodResult] = await runUpgrade(
      buildContext(UpgradePhase.Prod, true),
      [ORIGIN],
    );
    expect(prodResult.ownerType).to.equal(Owner.DEPLOYER);
    expect(prodResult.outcome).to.equal(ChainOutcome.Applied);
    expect(await productionRouting.hooks(DESTINATION_DOMAIN)).to.not.equal(
      productionBefore,
    );
    const finalRegistry = registryWrites[registryWrites.length - 1];
    expect(finalRegistry.fallbackRoutingHook).to.equal(
      ethereumAddresses.fallbackRoutingHook,
    );
    expect(finalRegistry.aggregationHook).to.not.equal(
      ethereumAddresses.aggregationHook,
    );
    expect(Object.values(finalRegistry)).to.not.include(shadow);

    await (await router.setHook(constants.AddressZero)).wait();
    await expectFeePaid();
    await nativeDispatch();

    const deployerNonce = await provider.getTransactionCount(
      DEPLOYERS.mainnet3,
    );
    const writes = registryWrites.length;
    for (const phase of Object.values(UpgradePhase)) {
      const [rerun] = await runUpgrade(buildContext(phase, true), [ORIGIN]);
      expect(rerun.outcome).to.equal(ChainOutcome.UpToDate);
    }
    expect(await provider.getTransactionCount(DEPLOYERS.mainnet3)).to.equal(
      deployerNonce,
    );
    expect(registryWrites).to.have.length(writes);
  });
});
