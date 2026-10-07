import { expect } from 'chai';
import {
  BigNumber,
  ContractFactory,
  ContractInterface,
  constants,
  providers,
  utils,
} from 'ethers';
import hre from 'hardhat';
import { pino } from 'pino';
import sinon from 'sinon';
import { fileURLToPath } from 'url';

import {
  DomainRoutingHook__factory,
  ERC20Test,
  ERC20Test__factory,
  FallbackDomainRoutingHook,
  FallbackDomainRoutingHook__factory,
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  Mailbox,
  Mailbox__factory,
  MerkleTreeHook__factory,
  PausableHook__factory,
  ProtocolFee__factory,
  StaticAggregationHook__factory,
  StaticAggregationHookFactory__factory,
  StorageGasOracle__factory,
  TestIsm__factory,
} from '@hyperlane-xyz/core';
import type { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  AnnotatedEV5Transaction,
  ChainMap,
  ContractVerificationInput,
  ContractVerifier,
  ExplorerFamily,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { Address, Logger, assert, eqAddress } from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';

import { Modules } from '../scripts/agent-utils.js';
import {
  ChainExport,
  ExportedFactory,
  createMemoryExportStore,
} from '../src/aggregation-hook-upgrade/address-export.js';
import { runUpgrade } from '../src/aggregation-hook-upgrade/run.js';
import { computeExitCode } from '../src/aggregation-hook-upgrade/summary.js';
import {
  ChainDomain,
  ChainOutcome,
  SkipReason,
  UpgradeContext,
  UpgradePersistence,
  UpgradePhase,
} from '../src/aggregation-hook-upgrade/types.js';
import { Owner } from '../src/governance.js';

import { revertMessage } from './aggregation-hook-upgrade.helpers.js';

const ORIGIN = 'test1';
const FIXED_DOMAIN = 77002;
const UNMAPPED_DOMAIN = 77001;
const IGNORED_DOMAIN = 77003;
const FEE_TOKEN_SUPPLY = utils.parseEther('1000000');
const GAS_LIMIT = 100_000;
const NOW = '2026-10-06T00:00:00.000Z';

interface LegacyFactoryArtifact {
  abi: ContractInterface;
  bytecode: string;
}

// Built from solidity/contracts/hooks/aggregation at fc9e1af786^ (PACKAGE_VERSION
// 11.0.0), the last StaticAggregationHook that reverts on ERC20 fee metadata.
const legacyArtifact = readJson<LegacyFactoryArtifact>(
  fileURLToPath(
    new URL(
      './fixtures/legacy-aggregation-hook/StaticAggregationHookFactory.json',
      import.meta.url,
    ),
  ),
);

interface RegistryWrite {
  chain: string;
  addresses: ChainAddresses;
}

interface VerificationWrite {
  module: Modules;
  inputs: ChainMap<ContractVerificationInput[]>;
}

interface TxWrite {
  chain: string;
  txs: AnnotatedEV5Transaction[];
}

interface RecoveryWrite {
  module: Modules;
  chain: string;
  inputs: ContractVerificationInput[];
}

function unsortedOrder(addresses: Address[]): Address[] {
  const sorted = [...addresses].sort();
  return sorted.every((address, i) => address === addresses[i])
    ? [...addresses].reverse()
    : addresses;
}

describe('aggregation hook upgrade', () => {
  let signer: providers.JsonRpcSigner;
  let other: providers.JsonRpcSigner;
  let signerAddress: Address;
  let otherAddress: Address;
  let multiProvider: MultiProvider;
  let mailbox: Mailbox;
  let igp: InterchainGasPaymaster;
  let feeToken: ERC20Test;
  let routing: FallbackDomainRoutingHook;
  let legacyFactoryAddress: Address;
  let legacyAggregator: Address;
  let legacyAggregatorB: Address;
  let fixedAggregator: Address;
  let merkleTreeHook: Address;
  let legacyChildren: Address[];
  let test2Domain: number;
  let test3Domain: number;
  let initialAddresses: ChainAddresses;
  let supportedDomains: ChainDomain[];
  let registryDomainIds: number[];

  let snapshotId: string;
  let registry: ChainMap<ChainAddresses>;
  let registryWrites: RegistryWrite[];
  let verificationWrites: VerificationWrite[];
  let txWrites: TxWrite[];
  let logLines: string[];
  let logger: Logger;
  let recoveryWrites: RecoveryWrite[];
  let failingVerificationModules: Set<Modules>;
  let failRecoveryWrite: boolean;
  let exportStore: ReturnType<typeof createMemoryExportStore>;
  let persist: UpgradePersistence;
  let failNextRegistryWrite: boolean;
  let contractVerifier: ContractVerifier | undefined;

  const recipient = utils.hexZeroPad('0x1234', 32);

  function feeMetadata(token: Address): string {
    return utils.solidityPack(
      ['uint16', 'uint256', 'uint256', 'address', 'address'],
      [1, 0, GAS_LIMIT, signerAddress, token],
    );
  }

  async function dispatchWithFee(hook: Address) {
    return mailbox['dispatch(uint32,bytes32,bytes,bytes,address)'](
      test2Domain,
      recipient,
      '0xabcd',
      feeMetadata(feeToken.address),
      hook,
    );
  }

  async function feeQuote(hook: Address): Promise<BigNumber> {
    return mailbox['quoteDispatch(uint32,bytes32,bytes,bytes,address)'](
      test2Domain,
      recipient,
      '0xabcd',
      feeMetadata(feeToken.address),
      hook,
    );
  }

  async function dispatchNative(hook: Address) {
    const quote = await mailbox[
      'quoteDispatch(uint32,bytes32,bytes,bytes,address)'
    ](test2Domain, recipient, '0xabcd', '0x', hook);
    return mailbox['dispatch(uint32,bytes32,bytes,bytes,address)'](
      test2Domain,
      recipient,
      '0xabcd',
      '0x',
      hook,
      { value: quote },
    );
  }

  async function expectFeePaid(hook: Address) {
    const quote = await feeQuote(hook);
    expect(quote.gt(0)).to.equal(true);
    const before = await feeToken.balanceOf(igp.address);
    const tx = await dispatchWithFee(hook);
    const receipt = await tx.wait();
    const after = await feeToken.balanceOf(igp.address);
    expect(after.sub(before).toString()).to.equal(quote.toString());
    const gasPayments = receipt.logs
      .filter((log) => eqAddress(log.address, igp.address))
      .map((log) => igp.interface.parseLog(log).name);
    expect(gasPayments).to.deep.equal(['GasPayment']);
  }

  function buildContext(
    phase: UpgradePhase,
    apply: boolean,
    provider: MultiProvider = multiProvider,
  ): UpgradeContext {
    return {
      environment: 'test',
      phase,
      apply,
      multiProvider: provider,
      chainAddresses: registry,
      supportedDomains,
      registryDomainIds,
      skipLists: { legacyCoreHookRecoveryChains: [], chainsToSkip: [] },
      contractVerifier,
      persist,
      concurrency: 2,
      probeConcurrency: 4,
      logger,
      now: () => NOW,
    };
  }

  async function run(
    phase: UpgradePhase,
    apply: boolean,
    provider: MultiProvider = multiProvider,
  ) {
    const [result] = await runUpgrade(buildContext(phase, apply, provider), [
      ORIGIN,
    ]);
    return result;
  }

  // The test network also mines on a timer, so block numbers are not stable.
  async function sentTxCount() {
    return signer.getTransactionCount();
  }

  function lastRegistryWrite(): ChainAddresses {
    const write = registryWrites[registryWrites.length - 1];
    assert(write, 'expected a registry write');
    return write.addresses;
  }

  before(async () => {
    const provider = new providers.Web3Provider((method, params) =>
      hre.network.provider.send(method, params),
    );
    signer = provider.getSigner(0);
    other = provider.getSigner(1);
    signerAddress = await signer.getAddress();
    otherAddress = await other.getAddress();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const originDomain = multiProvider.getDomainId(ORIGIN);
    test2Domain = multiProvider.getDomainId('test2');
    test3Domain = multiProvider.getDomainId('test3');

    mailbox = await new Mailbox__factory(signer).deploy(originDomain);
    const merkle = await new MerkleTreeHook__factory(signer).deploy(
      mailbox.address,
    );
    merkleTreeHook = merkle.address;
    const pausable = await new PausableHook__factory(signer).deploy();
    const protocolFee = await new ProtocolFee__factory(signer).deploy(
      utils.parseEther('1'),
      0,
      signerAddress,
      signerAddress,
    );
    igp = await new InterchainGasPaymaster__factory(signer).deploy();
    await igp.initialize(signerAddress, signerAddress);
    const oracle = await new StorageGasOracle__factory(signer).deploy();
    await oracle.setRemoteGasData({
      remoteDomain: test2Domain,
      tokenExchangeRate: BigNumber.from(10).pow(10),
      gasPrice: 1,
    });
    feeToken = await new ERC20Test__factory(signer).deploy(
      'Fee',
      'FEE',
      FEE_TOKEN_SUPPLY,
      18,
    );
    await igp.setTokenGasOracles([
      {
        feeToken: constants.AddressZero,
        remoteDomain: test2Domain,
        gasOracle: oracle.address,
      },
      {
        feeToken: feeToken.address,
        remoteDomain: test2Domain,
        gasOracle: oracle.address,
      },
    ]);
    await feeToken.approve(igp.address, FEE_TOKEN_SUPPLY);

    const legacyFactory = await new ContractFactory(
      legacyArtifact.abi,
      legacyArtifact.bytecode,
      signer,
    ).deploy();
    legacyFactoryAddress = legacyFactory.address;
    const legacyFactoryTyped = StaticAggregationHookFactory__factory.connect(
      legacyFactoryAddress,
      signer,
    );
    legacyChildren = unsortedOrder([
      pausable.address,
      merkle.address,
      igp.address,
    ]);
    await legacyFactoryTyped['deploy(address[])'](legacyChildren);
    legacyAggregator =
      await legacyFactoryTyped['getAddress(address[])'](legacyChildren);
    const childrenB = [merkle.address, pausable.address];
    await legacyFactoryTyped['deploy(address[])'](childrenB);
    legacyAggregatorB =
      await legacyFactoryTyped['getAddress(address[])'](childrenB);

    const fixedFactory = await new StaticAggregationHookFactory__factory(
      signer,
    ).deploy();
    await fixedFactory['deploy(address[])'](legacyChildren);
    fixedAggregator =
      await fixedFactory['getAddress(address[])'](legacyChildren);

    routing = await new FallbackDomainRoutingHook__factory(signer).deploy(
      mailbox.address,
      signerAddress,
      merkle.address,
    );
    await routing.setHooks([
      { destination: test2Domain, hook: legacyAggregator },
      { destination: FIXED_DOMAIN, hook: fixedAggregator },
      { destination: test3Domain, hook: merkle.address },
      { destination: IGNORED_DOMAIN, hook: legacyAggregatorB },
    ]);

    const testIsm = await new TestIsm__factory(signer).deploy();
    await mailbox.initialize(
      signerAddress,
      testIsm.address,
      routing.address,
      protocolFee.address,
    );

    initialAddresses = {
      aggregationHook: legacyAggregator,
      fallbackRoutingHook: routing.address,
      interchainGasPaymaster: igp.address,
      mailbox: mailbox.address,
      merkleTreeHook: merkle.address,
      pausableHook: pausable.address,
      staticAggregationHookFactory: legacyFactoryAddress,
    };
    supportedDomains = [
      { chain: 'test2', domainId: test2Domain },
      { chain: 'fixedchain', domainId: FIXED_DOMAIN },
      { chain: 'test3', domainId: test3Domain },
      { chain: 'unmappedchain', domainId: UNMAPPED_DOMAIN },
    ];
    registryDomainIds = [
      originDomain,
      test2Domain,
      test3Domain,
      FIXED_DOMAIN,
      UNMAPPED_DOMAIN,
      IGNORED_DOMAIN,
    ];
  });

  function makePersist(store: ReturnType<typeof createMemoryExportStore>) {
    return {
      writeRegistryAddresses: (chain: string, addresses: ChainAddresses) => {
        if (failNextRegistryWrite) {
          failNextRegistryWrite = false;
          throw new Error('registry unavailable');
        }
        registryWrites.push({ chain, addresses });
        registry[chain] = addresses;
      },
      writeVerificationInputs: async (
        module: Modules,
        inputs: ChainMap<ContractVerificationInput[]>,
      ) => {
        if (failingVerificationModules.has(module)) {
          throw new Error(`${module} verification file unavailable`);
        }
        verificationWrites.push({ module, inputs });
      },
      writeVerificationRecovery: async (
        module: Modules,
        chain: string,
        inputs: ContractVerificationInput[],
      ) => {
        if (failRecoveryWrite) throw new Error('recovery file unavailable');
        recoveryWrites.push({ module, chain, inputs });
        return `memory://recovery/${chain}.${module}`;
      },
      writeTransactions: async (
        chain: string,
        txs: AnnotatedEV5Transaction[],
      ) => {
        txWrites.push({ chain, txs });
        return `memory://${chain}`;
      },
      exportStore: store,
    } satisfies UpgradePersistence;
  }

  function seededExport(update: {
    factory: ExportedFactory;
    shadowRoutingHook?: Address;
  }): ChainExport {
    const entry: ChainExport = {
      signer: signerAddress,
      phase: UpgradePhase.Shadow,
      routingHook: routing.address,
      routingHookOwner: signerAddress,
      routingHookOwnerType: Owner.DEPLOYER,
      factory: update.factory,
      aggregators: [],
      firstRecordedAt: NOW,
      updatedAt: NOW,
    };
    if (update.shadowRoutingHook) {
      entry.shadowRoutingHook = update.shadowRoutingHook;
    }
    return entry;
  }

  function useSeededExport(entry: ChainExport) {
    exportStore = createMemoryExportStore({ [ORIGIN]: entry });
    persist = makePersist(exportStore);
  }

  function persistedInput(name: string): ContractVerificationInput | undefined {
    return verificationWrites
      .flatMap((write) => write.inputs[ORIGIN] ?? [])
      .find((input) => input.name === name);
  }

  function verificationNames(): string[] {
    return verificationWrites.flatMap((write) =>
      (write.inputs[ORIGIN] ?? []).map((input) => input.name),
    );
  }

  beforeEach(async () => {
    snapshotId = await hre.network.provider.send('evm_snapshot');
    registry = { [ORIGIN]: initialAddresses };
    registryWrites = [];
    verificationWrites = [];
    txWrites = [];
    recoveryWrites = [];
    logLines = [];
    logger = pino({ level: 'debug' }, { write: (line) => logLines.push(line) });
    failingVerificationModules = new Set();
    failRecoveryWrite = false;
    failNextRegistryWrite = false;
    contractVerifier = undefined;
    exportStore = createMemoryExportStore();
    persist = makePersist(exportStore);
  });

  afterEach(async () => {
    sinon.restore();
    await hre.network.provider.send('evm_revert', [snapshotId]);
  });

  it('reproduces the ERC20 fee revert on the legacy aggregation hook', async () => {
    const legacy = StaticAggregationHook__factory.connect(
      legacyAggregator,
      signer,
    );
    expect(legacyChildren).to.not.deep.equal([...legacyChildren].sort());
    expect(await legacy.hooks('0x')).to.deep.equal(legacyChildren);
    const reason = await revertMessage(dispatchWithFee(constants.AddressZero));
    expect(reason).to.include('StaticAggregationHook: insufficient value');
    await (await dispatchNative(constants.AddressZero)).wait();
  });

  it('shadow phase deploys the fixed hooks and a new routing hook without touching production', async () => {
    const result = await run(UpgradePhase.Shadow, true);
    expect(result.outcome).to.equal(ChainOutcome.Applied);

    expect(registryWrites).to.have.length(1);
    const written = lastRegistryWrite();
    const newFactory = written.staticAggregationHookFactory;
    expect(newFactory).to.not.equal(legacyFactoryAddress);
    expect(written.aggregationHook).to.equal(legacyAggregator);
    expect(written.fallbackRoutingHook).to.equal(routing.address);

    const aggregator = result.aggregators[0].address;
    const shadow = result.shadowRoutingHook;
    assert(aggregator && shadow, 'expected aggregator and shadow hook');
    expect(Object.values(written)).to.not.include(shadow);

    const factory = StaticAggregationHookFactory__factory.connect(
      newFactory,
      signer,
    );
    expect(await factory['getAddress(address[])'](legacyChildren)).to.equal(
      aggregator,
    );
    expect(
      await factory['getAddress(address[])']([...legacyChildren].sort()),
    ).to.not.equal(aggregator);
    expect(
      await StaticAggregationHook__factory.connect(aggregator, signer).hooks(
        '0x',
      ),
    ).to.deep.equal(legacyChildren);

    const shadowHook = FallbackDomainRoutingHook__factory.connect(
      shadow,
      signer,
    );
    expect(await shadowHook.owner()).to.equal(signerAddress);
    expect(await shadowHook.fallbackHook()).to.equal(merkleTreeHook);
    expect(await shadowHook.mailbox()).to.equal(mailbox.address);
    expect(await shadowHook.hooks(test2Domain)).to.equal(aggregator);
    expect(await shadowHook.hooks(FIXED_DOMAIN)).to.equal(fixedAggregator);
    expect(await shadowHook.hooks(test3Domain)).to.equal(merkleTreeHook);
    expect(await shadowHook.hooks(UNMAPPED_DOMAIN)).to.equal(
      constants.AddressZero,
    );
    expect(await shadowHook.hooks(IGNORED_DOMAIN)).to.equal(
      constants.AddressZero,
    );

    expect(await routing.hooks(test2Domain)).to.equal(legacyAggregator);
    expect(await routing.hooks(IGNORED_DOMAIN)).to.equal(legacyAggregatorB);
    expect(await routing.owner()).to.equal(signerAddress);
    expect(await mailbox.defaultHook()).to.equal(routing.address);

    await expectFeePaid(shadow);
    await (await dispatchNative(shadow)).wait();
    expect(
      await revertMessage(dispatchWithFee(constants.AddressZero)),
    ).to.include('StaticAggregationHook: insufficient value');

    const exported = await exportStore.read(ORIGIN);
    expect(exported?.shadowRoutingHook).to.equal(shadow);
    expect(exported?.factory.address).to.equal(newFactory);
    expect(exported?.factory.previous?.address).to.equal(legacyFactoryAddress);
    expect(exported?.aggregators).to.deep.equal([
      {
        children: legacyChildren,
        address: aggregator,
        replaces: [legacyAggregator],
      },
    ]);

    expect(verificationWrites.map((write) => write.module)).to.deep.equal([
      Modules.PROXY_FACTORY,
      Modules.HOOK,
    ]);
    const names = verificationWrites.flatMap((write) =>
      (write.inputs[ORIGIN] ?? []).map((input) => input.name),
    );
    expect(names).to.include.members([
      'StaticAggregationHookFactory',
      'StaticAggregationHook',
      'FallbackDomainRoutingHook',
    ]);

    expect(result.coverage?.legacy).to.equal(1);
    expect(result.coverage?.fixed).to.equal(1);
    expect(result.coverage?.unmapped).to.deep.equal(['unmappedchain']);
    expect(result.coverage?.nonAggregation.map((r) => r.chain)).to.deep.equal([
      'test3',
    ]);
    expect(result.coverage?.ignoredMapped).to.equal(1);
    expect(result.coverage?.ignoredLegacy).to.equal(1);
  });

  it('prod phase repoints the production routing hook and updates the registry', async () => {
    const result = await run(UpgradePhase.Prod, true);
    expect(result.outcome).to.equal(ChainOutcome.Applied);
    expect(result.shadowRoutingHook).to.equal(undefined);

    const aggregator = result.aggregators[0].address;
    assert(aggregator, 'expected aggregator');
    expect(await routing.hooks(test2Domain)).to.equal(aggregator);
    expect(await routing.hooks(FIXED_DOMAIN)).to.equal(fixedAggregator);
    expect(await routing.hooks(test3Domain)).to.equal(merkleTreeHook);
    expect(await routing.hooks(IGNORED_DOMAIN)).to.equal(legacyAggregatorB);
    expect(await mailbox.defaultHook()).to.equal(routing.address);

    await expectFeePaid(constants.AddressZero);
    await (await dispatchNative(constants.AddressZero)).wait();

    expect(registryWrites).to.have.length(2);
    const finalAddresses = lastRegistryWrite();
    expect(finalAddresses).to.deep.equal({
      aggregationHook: aggregator,
      fallbackRoutingHook: routing.address,
      interchainGasPaymaster: igp.address,
      mailbox: mailbox.address,
      merkleTreeHook,
      pausableHook: initialAddresses.pausableHook,
      staticAggregationHookFactory:
        registryWrites[0].addresses.staticAggregationHookFactory,
    });
    expect(result.registryKeysWritten).to.deep.equal([
      'staticAggregationHookFactory',
      'aggregationHook',
    ]);
    expect(result.setHooks).to.deep.equal({ migrate: 1, sent: 1, emitted: 0 });
  });

  it('re-runs are no-ops once converged', async () => {
    await run(UpgradePhase.Shadow, true);
    const afterShadow = await sentTxCount();
    const writesAfterShadow = registryWrites.length;
    const exportedAfterShadow = await exportStore.read(ORIGIN);
    const shadowAgain = await run(UpgradePhase.Shadow, true);
    expect(shadowAgain.outcome).to.equal(ChainOutcome.UpToDate);
    expect(await sentTxCount()).to.equal(afterShadow);
    expect(registryWrites).to.have.length(writesAfterShadow);
    expect(await exportStore.read(ORIGIN)).to.deep.equal(exportedAfterShadow);

    await run(UpgradePhase.Prod, true);
    const afterProd = await sentTxCount();
    const writesAfterProd = registryWrites.length;
    const prodAgain = await run(UpgradePhase.Prod, true);
    expect(prodAgain.outcome).to.equal(ChainOutcome.UpToDate);
    expect(await sentTxCount()).to.equal(afterProd);
    expect(registryWrites).to.have.length(writesAfterProd);
    const shadowAfterProd = await run(UpgradePhase.Shadow, true);
    expect(shadowAfterProd.outcome).to.equal(ChainOutcome.UpToDate);
    expect(shadowAfterProd.shadowRoutingHook).to.equal(
      exportedAfterShadow?.shadowRoutingHook,
    );
    expect(await sentTxCount()).to.equal(afterProd);
  });

  it('dry runs read state without any side effect', async () => {
    const before = await sentTxCount();
    for (const phase of Object.values(UpgradePhase)) {
      const result = await run(phase, false);
      expect(result.outcome).to.equal(ChainOutcome.Planned);
      expect(result.pending.length).to.be.greaterThan(0);
    }
    expect(await sentTxCount()).to.equal(before);
    expect(registryWrites).to.have.length(0);
    expect(verificationWrites).to.have.length(0);
    expect(txWrites).to.have.length(0);
    expect(await exportStore.read(ORIGIN)).to.equal(undefined);
    expect(await routing.hooks(test2Domain)).to.equal(legacyAggregator);

    await run(UpgradePhase.Shadow, true);
    const applied = await sentTxCount();
    const writes = registryWrites.length;
    const prodDryRun = await run(UpgradePhase.Prod, false);
    expect(prodDryRun.outcome).to.equal(ChainOutcome.Planned);
    expect(prodDryRun.pending).to.include('send setHooks for 1 domain(s)');
    expect(await sentTxCount()).to.equal(applied);
    expect(registryWrites).to.have.length(writes);
    expect(await routing.hooks(test2Domain)).to.equal(legacyAggregator);
  });

  it('plans every phase without a signer', async () => {
    const unsigned = MultiProvider.createTestMultiProvider({
      provider: signer.provider,
    });
    expect(unsigned.tryGetSigner(ORIGIN)).to.equal(null);
    const before = await sentTxCount();

    for (const phase of Object.values(UpgradePhase)) {
      const planned = await run(phase, false, unsigned);
      expect(planned.outcome).to.equal(ChainOutcome.Planned);
      expect(planned.pending.length).to.be.greaterThan(0);
    }

    await run(UpgradePhase.Shadow, true);
    const afterShadow = await sentTxCount();
    const shadowPlan = await run(UpgradePhase.Shadow, false, unsigned);
    expect(shadowPlan.outcome).to.equal(ChainOutcome.UpToDate);
    const prodPlan = await run(UpgradePhase.Prod, false, unsigned);
    expect(prodPlan.outcome).to.equal(ChainOutcome.Planned);
    expect(await sentTxCount()).to.equal(afterShadow);
    expect(afterShadow).to.be.greaterThan(before);
  });

  it('emits owner transactions instead of sending when the signer is not the owner', async () => {
    await (await routing.transferOwnership(otherAddress)).wait();

    const emitted = await run(UpgradePhase.Prod, true);
    expect(emitted.outcome).to.equal(ChainOutcome.Emitted);
    expect(emitted.txFile).to.equal(`memory://${ORIGIN}`);
    expect(emitted.setHooks).to.deep.equal({ migrate: 1, sent: 0, emitted: 1 });
    expect(await routing.hooks(test2Domain)).to.equal(legacyAggregator);
    expect(registryWrites).to.have.length(1);
    expect(lastRegistryWrite().aggregationHook).to.equal(legacyAggregator);

    const aggregator = emitted.aggregators[0].address;
    assert(aggregator, 'expected aggregator');
    expect(txWrites).to.have.length(1);
    const [tx] = txWrites[0].txs;
    assert(tx.to && tx.data, 'expected an owner transaction');
    expect(tx.to).to.equal(routing.address);
    const decoded =
      DomainRoutingHook__factory.createInterface().decodeFunctionData(
        'setHooks',
        tx.data.toString(),
      );
    expect(
      decoded[0].map((config: { destination: number; hook: string }) => [
        Number(config.destination),
        config.hook,
      ]),
    ).to.deep.equal([[test2Domain, aggregator]]);

    await (await other.sendTransaction({ to: tx.to, data: tx.data })).wait();
    expect(await routing.hooks(test2Domain)).to.equal(aggregator);

    const converged = await run(UpgradePhase.Prod, true);
    expect(converged.outcome).to.equal(ChainOutcome.Applied);
    expect(converged.setHooks).to.equal(undefined);
    expect(lastRegistryWrite().aggregationHook).to.equal(aggregator);
    expect(txWrites).to.have.length(1);

    const settled = await run(UpgradePhase.Prod, true);
    expect(settled.outcome).to.equal(ChainOutcome.UpToDate);
  });

  it('isolates per-chain failures and skips ineligible chains', async () => {
    registry.test2 = {
      mailbox: utils.getAddress(utils.hexZeroPad('0xdead', 20)),
      staticAggregationHookFactory: legacyFactoryAddress,
    };
    const results = await runUpgrade(buildContext(UpgradePhase.Shadow, true), [
      'test2',
      ORIGIN,
      'test3',
    ]);
    const byChain = new Map(results.map((r) => [r.chain, r]));
    expect(byChain.get('test2')?.outcome).to.equal(ChainOutcome.Error);
    expect(byChain.get('test2')?.detail).to.include('method="defaultHook()"');
    expect(byChain.get(ORIGIN)?.outcome).to.equal(ChainOutcome.Applied);
    expect(byChain.get('test3')?.outcome).to.equal(ChainOutcome.Skipped);
    expect(byChain.get('test3')?.skipReason).to.equal(
      SkipReason.NoRegistryFactory,
    );
    expect(computeExitCode(results, undefined)).to.equal(1);
    expect(registryWrites.every((write) => write.chain === ORIGIN)).to.equal(
      true,
    );
  });
  it('adopts a recorded fixed factory instead of deploying another', async () => {
    const recorded = await new StaticAggregationHookFactory__factory(
      signer,
    ).deploy();
    useSeededExport(
      seededExport({
        factory: { address: recorded.address, version: '12.2.0' },
      }),
    );
    const sentBefore = await sentTxCount();

    const result = await run(UpgradePhase.Shadow, true);
    expect(result.outcome).to.equal(ChainOutcome.Applied);
    expect(result.factory).to.deep.equal({
      address: recorded.address,
      previous: legacyFactoryAddress,
      deployed: false,
    });
    expect(registryWrites[0].addresses.staticAggregationHookFactory).to.equal(
      recorded.address,
    );
    expect(verificationNames()).to.not.include('StaticAggregationHookFactory');
    // aggregator deploy, shadow hook deploy, one shadow setHooks batch
    expect((await sentTxCount()) - sentBefore).to.equal(3);

    const aggregator = result.aggregators[0].address;
    assert(aggregator, 'expected aggregator');
    expect(await recorded['getAddress(address[])'](legacyChildren)).to.equal(
      aggregator,
    );
    const exported = await exportStore.read(ORIGIN);
    expect(exported?.factory.address).to.equal(recorded.address);
    expect(exported?.factory.previous?.address).to.equal(legacyFactoryAddress);
  });

  it('reuses the factory recorded before a post-deploy failure', async () => {
    failNextRegistryWrite = true;
    const failed = await run(UpgradePhase.Shadow, true);
    expect(failed.outcome).to.equal(ChainOutcome.Error);
    expect(registryWrites).to.have.length(0);

    const recorded = (await exportStore.read(ORIGIN))?.factory.address;
    assert(recorded, 'expected the deployed factory in the export');
    expect(recorded).to.not.equal(legacyFactoryAddress);
    expect(failed.detail).to.include(recorded);
    expect(failed.detail).to.include('was deployed on test1');
    expect(failed.detail).to.include('registry unavailable');
    expect(verificationNames()).to.include('StaticAggregationHookFactory');

    const rerun = await run(UpgradePhase.Shadow, true);
    expect(rerun.outcome).to.equal(ChainOutcome.Applied);
    expect(rerun.factory).to.deep.equal({
      address: recorded,
      previous: legacyFactoryAddress,
      deployed: false,
    });
    expect(registryWrites[0].addresses.staticAggregationHookFactory).to.equal(
      recorded,
    );
    expect(
      verificationNames().filter(
        (name) => name === 'StaticAggregationHookFactory',
      ),
    ).to.have.length(1);
  });

  it('reuses the shadow routing hook recorded before a post-deploy failure', async () => {
    const original = multiProvider.handleTx.bind(multiProvider);
    const setHooksSelector =
      DomainRoutingHook__factory.createInterface().getSighash('setHooks');
    sinon
      .stub(multiProvider, 'handleTx')
      .callsFake(async (...args: Parameters<typeof original>) => {
        const receipt = await original(...args);
        const tx = await args[1];
        if (tx.data.startsWith(setHooksSelector)) {
          throw new Error('rpc dropped');
        }
        return receipt;
      });

    const failed = await run(UpgradePhase.Shadow, true);
    expect(failed.outcome).to.equal(ChainOutcome.Error);
    const recorded = (await exportStore.read(ORIGIN))?.shadowRoutingHook;
    assert(recorded, 'expected the shadow routing hook in the export');
    expect(failed.detail).to.include(recorded);
    expect(failed.detail).to.include('Shadow routing hook');
    expect(failed.detail).to.include('rpc dropped');
    sinon.restore();

    const rerun = await run(UpgradePhase.Shadow, true);
    expect(rerun.shadowRoutingHook).to.equal(recorded);
    expect(rerun.outcome).to.equal(ChainOutcome.UpToDate);
    expect(
      verificationNames().filter(
        (name) => name === 'FallbackDomainRoutingHook',
      ),
    ).to.have.length(1);
    const shadowHook = FallbackDomainRoutingHook__factory.connect(
      recorded,
      signer,
    );
    expect(await shadowHook.hooks(test3Domain)).to.equal(merkleTreeHook);
  });

  describe('explorer verification', () => {
    interface Observation {
      name: string;
      exportedFactory?: Address;
      exportedShadow?: Address;
      persistedNames: string[];
    }

    let observations: Observation[];
    let verifier: sinon.SinonStubbedInstance<ContractVerifier>;

    beforeEach(() => {
      observations = [];
      verifier = sinon.createStubInstance(ContractVerifier);
      verifier.verifyContract.callsFake(async (_chain, input) => {
        const exported = await exportStore.read(ORIGIN);
        observations.push({
          name: input.name,
          exportedFactory: exported?.factory.address,
          exportedShadow: exported?.shadowRoutingHook,
          persistedNames: verificationNames(),
        });
      });
      sinon.stub(multiProvider, 'tryGetExplorerApi').returns({
        apiUrl: 'https://explorer.invalid/api',
        family: ExplorerFamily.Etherscan,
      });
      contractVerifier = verifier;
    });

    it('records deployed addresses and verification inputs before any explorer call', async () => {
      const result = await run(UpgradePhase.Shadow, true);
      expect(result.outcome).to.equal(ChainOutcome.Applied);

      expect(observations.map((o) => o.name)).to.have.members([
        'StaticAggregationHookFactory',
        'StaticAggregationHook',
        'FallbackDomainRoutingHook',
      ]);
      for (const observed of observations) {
        expect(observed.exportedFactory).to.equal(result.factory?.address);
        expect(observed.exportedShadow).to.equal(result.shadowRoutingHook);
        expect(observed.persistedNames).to.include(observed.name);
      }
    });

    it('still reports the deployment when explorer verification fails', async () => {
      verifier.verifyContract.rejects(new Error('explorer unavailable'));
      const result = await run(UpgradePhase.Shadow, true);
      expect(result.outcome).to.equal(ChainOutcome.Applied);
      expect(verifier.verifyContract.callCount).to.equal(3);
      const exported = await exportStore.read(ORIGIN);
      expect(exported?.factory.address).to.equal(result.factory?.address);
      expect(exported?.shadowRoutingHook).to.equal(result.shadowRoutingHook);
    });

    it('verifies contracts deployed before a later failure', async () => {
      failNextRegistryWrite = true;
      const failed = await run(UpgradePhase.Shadow, true);
      expect(failed.outcome).to.equal(ChainOutcome.Error);
      expect(observations.map((o) => o.name)).to.have.members([
        'StaticAggregationHookFactory',
        'StaticAggregationHook',
      ]);
      const recorded = (await exportStore.read(ORIGIN))?.factory.address;
      for (const observed of observations) {
        expect(observed.exportedFactory).to.equal(recorded);
      }
    });

    it('persists the implementation verification input before reading it back', async () => {
      const selector = utils.id('implementation()').slice(0, 10);
      const call = signer.call.bind(signer);
      sinon.stub(signer, 'call').callsFake(async (tx, blockTag) => {
        const data = await tx.data;
        if (data !== undefined && utils.hexlify(data).startsWith(selector)) {
          throw new Error('rpc dropped');
        }
        return call(tx, blockTag);
      });

      const failed = await run(UpgradePhase.Shadow, true);
      sinon.restore();

      expect(failed.outcome).to.equal(ChainOutcome.Error);
      expect(failed.detail).to.include('rpc dropped');
      const recorded = (await exportStore.read(ORIGIN))?.factory.address;
      assert(recorded, 'expected the deployed factory in the export');
      const implementation =
        await StaticAggregationHookFactory__factory.connect(
          recorded,
          signer,
        ).implementation();
      expect(persistedInput('StaticAggregationHook')).to.deep.include({
        address: implementation,
        constructorArguments: '',
        isProxy: true,
      });
    });

    it('builds the factory and implementation verification inputs the SDK deployer produced', async () => {
      const result = await run(UpgradePhase.Shadow, true);
      assert(result.factory?.address, 'expected a deployed factory');
      const implementation =
        await StaticAggregationHookFactory__factory.connect(
          result.factory.address,
          signer,
        ).implementation();

      expect(persistedInput('StaticAggregationHookFactory')).to.deep.include({
        address: result.factory.address,
        constructorArguments: '',
        isProxy: false,
      });
      expect(persistedInput('StaticAggregationHook')).to.deep.include({
        address: implementation,
        constructorArguments: '',
        isProxy: true,
      });
    });

    // The SDK hook deployer would name this input `FallbackRoutingHook`, which
    // the verifier cannot resolve to a contract; the real contract name can.
    it('names the shadow hook verification input after its contract', async () => {
      const result = await run(UpgradePhase.Shadow, true);

      expect(persistedInput('FallbackDomainRoutingHook')).to.deep.include({
        address: result.shadowRoutingHook,
        constructorArguments: utils.defaultAbiCoder
          .encode(
            ['address', 'address', 'address'],
            [mailbox.address, signerAddress, merkleTreeHook],
          )
          .slice(2),
        isProxy: false,
      });
    });
  });

  describe('verification input persistence', () => {
    const factoryRecovery = `memory://recovery/${ORIGIN}.${Modules.PROXY_FACTORY}`;
    const hookRecovery = `memory://recovery/${ORIGIN}.${Modules.HOOK}`;

    function recoveredNames(module: Modules): string[] {
      return recoveryWrites
        .filter((write) => write.module === module)
        .flatMap((write) => write.inputs.map((input) => input.name));
    }

    it('writes the hook inputs and saves the factory inputs when the factory write fails', async () => {
      failingVerificationModules = new Set([Modules.PROXY_FACTORY]);

      const result = await run(UpgradePhase.Shadow, true);

      expect(result.outcome).to.equal(ChainOutcome.Error);
      expect(computeExitCode([result], undefined)).to.equal(1);
      expect(result.verificationRecoveryFiles).to.deep.equal([factoryRecovery]);
      expect(result.detail).to.include(factoryRecovery);
      expect(verificationWrites.map((write) => write.module)).to.deep.equal([
        Modules.HOOK,
      ]);
      expect(recoveredNames(Modules.PROXY_FACTORY)).to.have.members([
        'StaticAggregationHookFactory',
        'StaticAggregationHook',
      ]);
      expect(recoveredNames(Modules.HOOK)).to.deep.equal([]);
      expect((await exportStore.read(ORIGIN))?.shadowRoutingHook).to.equal(
        result.shadowRoutingHook,
      );
    });

    it('saves the inputs of every module whose write fails', async () => {
      failingVerificationModules = new Set([
        Modules.PROXY_FACTORY,
        Modules.HOOK,
      ]);

      const result = await run(UpgradePhase.Shadow, true);

      expect(result.outcome).to.equal(ChainOutcome.Error);
      expect(result.verificationRecoveryFiles).to.have.members([
        factoryRecovery,
        hookRecovery,
      ]);
      expect(verificationWrites).to.have.length(0);
      expect(recoveredNames(Modules.HOOK)).to.deep.equal([
        'FallbackDomainRoutingHook',
      ]);
    });

    it('fails the chain with the deployed address when the recovery file cannot be written', async () => {
      failingVerificationModules = new Set([Modules.PROXY_FACTORY]);
      failRecoveryWrite = true;

      const result = await run(UpgradePhase.Shadow, true);

      expect(result.outcome).to.equal(ChainOutcome.Error);
      const recorded = (await exportStore.read(ORIGIN))?.factory.address;
      assert(recorded, 'expected the deployed factory in the export');
      expect(result.detail).to.include(recorded);
      expect(result.detail).to.include('recovery file unavailable');
    });

    it('logs the recovery file even when the chain later fails', async () => {
      failingVerificationModules = new Set([Modules.PROXY_FACTORY]);
      failNextRegistryWrite = true;

      const result = await run(UpgradePhase.Shadow, true);

      expect(result.outcome).to.equal(ChainOutcome.Error);
      expect(result.detail).to.include('registry unavailable');
      expect(result.verificationRecoveryFiles).to.deep.equal([]);
      expect(
        logLines.filter((line) => line.includes(factoryRecovery)),
      ).to.have.length.greaterThan(0);
    });

    it('does not report a recovery when every write succeeds', async () => {
      const result = await run(UpgradePhase.Shadow, true);
      expect(result.outcome).to.equal(ChainOutcome.Applied);
      expect(result.verificationRecoveryFiles).to.deep.equal([]);
      expect(recoveryWrites).to.have.length(0);
    });
  });

  describe('recorded shadow reconciliation', () => {
    const SHADOW_ROUTE_UPDATE = 'update 1 route(s) on the shadow routing hook';

    async function recordedShadow(): Promise<FallbackDomainRoutingHook> {
      const shadow = (await exportStore.read(ORIGIN))?.shadowRoutingHook;
      assert(shadow, 'expected a recorded shadow routing hook');
      return FallbackDomainRoutingHook__factory.connect(shadow, signer);
    }

    async function clearProductionRoute(domain: number) {
      await (
        await routing.setHooks([
          { destination: domain, hook: constants.AddressZero },
        ])
      ).wait();
    }

    it('clears a shadow route when production no longer maps the domain', async () => {
      await run(UpgradePhase.Shadow, true);
      const shadow = await recordedShadow();
      expect(await shadow.hooks(test3Domain)).to.equal(merkleTreeHook);
      await clearProductionRoute(test3Domain);

      const rerun = await run(UpgradePhase.Shadow, true);

      expect(rerun.outcome).to.equal(ChainOutcome.Applied);
      expect(await shadow.hooks(test3Domain)).to.equal(constants.AddressZero);
      expect(await shadow.domains()).to.not.include(test3Domain);
      expect(await shadow.hooks(FIXED_DOMAIN)).to.equal(fixedAggregator);
    });

    it('reconciles the recorded shadow once production has converged', async () => {
      await run(UpgradePhase.Shadow, true);
      await run(UpgradePhase.Prod, true);
      const shadow = await recordedShadow();
      const exportedBefore = await exportStore.read(ORIGIN);
      await clearProductionRoute(test3Domain);
      const sentBefore = await sentTxCount();

      const planned = await run(UpgradePhase.Shadow, false);
      expect(planned.outcome).to.equal(ChainOutcome.Planned);
      expect(planned.pending).to.deep.equal([SHADOW_ROUTE_UPDATE]);
      expect(await sentTxCount()).to.equal(sentBefore);
      expect(await shadow.hooks(test3Domain)).to.equal(merkleTreeHook);

      const applied = await run(UpgradePhase.Shadow, true);
      expect(applied.outcome).to.equal(ChainOutcome.Applied);
      expect(applied.aggregators).to.deep.equal([]);
      expect(await shadow.hooks(test3Domain)).to.equal(constants.AddressZero);
      expect(await sentTxCount()).to.equal(sentBefore + 1);
      expect(await exportStore.read(ORIGIN)).to.deep.equal(exportedBefore);

      const settled = await run(UpgradePhase.Shadow, true);
      expect(settled.outcome).to.equal(ChainOutcome.UpToDate);
      expect(await sentTxCount()).to.equal(sentBefore + 1);
    });

    it('does not count unmapped domains as pending routes on a new shadow', async () => {
      const recorded = await new StaticAggregationHookFactory__factory(
        signer,
      ).deploy();
      useSeededExport(
        seededExport({
          factory: { address: recorded.address, version: '12.2.0' },
        }),
      );

      const planned = await run(UpgradePhase.Shadow, false);

      expect(planned.outcome).to.equal(ChainOutcome.Planned);
      expect(planned.pending).to.include(
        'update 3 route(s) on the shadow routing hook',
      );
    });
  });

  describe('recorded shadow routing hook guards', () => {
    function recordShadow(shadow: Address) {
      useSeededExport(
        seededExport({
          factory: { address: legacyFactoryAddress, version: '9.0.10' },
          shadowRoutingHook: shadow,
        }),
      );
    }

    it('rejects the production routing hook', async () => {
      recordShadow(routing.address);
      const result = await run(UpgradePhase.Shadow, true);
      expect(result.outcome).to.equal(ChainOutcome.Error);
      expect(result.detail).to.include('is the production routing hook');
      expect(await routing.hooks(test2Domain)).to.equal(legacyAggregator);
    });

    it('rejects a hook with a different fallback', async () => {
      const mismatched = await new FallbackDomainRoutingHook__factory(
        signer,
      ).deploy(mailbox.address, signerAddress, otherAddress);
      recordShadow(mismatched.address);
      const result = await run(UpgradePhase.Shadow, true);
      expect(result.outcome).to.equal(ChainOutcome.Error);
      expect(result.detail).to.include(
        'does not match the production routing hook',
      );
    });

    it('rejects pending route updates when the signer is not the owner', async () => {
      const foreign = await new FallbackDomainRoutingHook__factory(
        signer,
      ).deploy(mailbox.address, otherAddress, merkleTreeHook);
      recordShadow(foreign.address);
      const result = await run(UpgradePhase.Shadow, true);
      expect(result.outcome).to.equal(ChainOutcome.Error);
      expect(result.detail).to.include(
        `Cannot update shadow routing hook ${foreign.address}`,
      );
      expect(result.detail).to.include(`is not owner ${otherAddress}`);
      expect(await foreign.hooks(test2Domain)).to.equal(constants.AddressZero);
    });
  });
});
