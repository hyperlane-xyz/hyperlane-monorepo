import { expect } from 'chai';
import { BigNumber, Wallet, constants, providers } from 'ethers';
import hre from 'hardhat';
import sinon from 'sinon';

import type { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  CONTRACTS_PACKAGE_VERSION,
  DomainRoutingHook__factory,
  ERC20Test,
  ERC20Test__factory,
  FallbackDomainRoutingHook__factory,
  InterchainAccountRouter__factory,
  InterchainGasPaymaster__factory,
  Mailbox__factory,
  QuotedCalls__factory,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';
import {
  ChainMap,
  ContractVerificationInput,
  ContractVerifier,
  MultiProvider,
  OnchainHookType,
  PERMIT2_ADDRESS,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  addBufferToGasLimit,
  addressToBytes32,
  assert,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { DEFAULT_OFFCHAIN_LOOKUP_ISM_URLS } from '../config/environments/utils.js';
import { createMemoryChainStore } from '../src/aggregation-hook-upgrade/address-export.js';
import {
  IcaChainExport,
  IcaChainExportUpdate,
  mergeIcaExport,
} from '../src/ica-quoted-calls-deploy/export.js';
import { POST_DEPLOY_GAS } from '../src/ica-quoted-calls-deploy/plan.js';
import { runIcaDeploy } from '../src/ica-quoted-calls-deploy/run.js';
import {
  REDACTED_KEY,
  createKeyRedactor,
  loadWalletFromEnv,
} from '../src/ica-quoted-calls-deploy/signer.js';
import { computeExitCode } from '../src/ica-quoted-calls-deploy/summary.js';
import {
  Adoption,
  COMMIT_TX_GAS_USAGE,
  ContractKind,
  FeeToken,
  IcaContext,
  IcaOutcome,
} from '../src/ica-quoted-calls-deploy/types.js';

const CHAINS = ['test1', 'test2', 'test3'];
const FEE_SUPPLY = 1_000_000;
const HARDHAT_MNEMONIC =
  'test test test test test test test test test test test junk';
const KEY_ENV = 'ICA_TEST_DEPLOYER_KEY';
// An address no transaction of the test creates a contract at.
const NEVER_DEPLOYED = '0x0000000000000000000000000000000000000700';

interface ContextFields {
  apply?: boolean;
  multiProvider?: MultiProvider;
  planningSigner?: Address;
  owner?: Address;
  chains?: string[];
  contractVerifier?: ContractVerifier;
  writeRegistry?: boolean;
  redact?: (text: string) => string;
  // The test chains share one network and one signer, so a deploy's predicted
  // address (from the signer's nonce) is only right when chains run one at a time.
  concurrency?: number;
}

describe('ICA router and QuotedCalls pair deploy', () => {
  let signer: providers.JsonRpcSigner;
  let signerAddress: Address;
  let otherAddress: Address;
  let provider: providers.Web3Provider;
  let unsigned: MultiProvider;
  let signed: MultiProvider;
  let token: ERC20Test;
  let mailboxes: ChainMap<Address>;
  let registry: ChainMap<ChainAddresses>;
  let baseShadowHooks: ChainMap<Address>;
  let shadowHooks: ChainMap<Address>;
  let feeTokens: ChainMap<FeeToken[]>;
  let igp: string;
  let snapshotId: string;
  let store: ReturnType<typeof createStore>;
  let verificationWrites: Array<{
    chain: string;
    inputs: ContractVerificationInput[];
  }>;
  let failVerificationWrite: boolean;
  let registryWrites: Array<{ chain: string; addresses: ChainAddresses }>;

  function createStore() {
    return createMemoryChainStore<IcaChainExport, IcaChainExportUpdate>(
      mergeIcaExport,
    );
  }

  function buildContext(fields: ContextFields = {}): IcaContext {
    return {
      apply: fields.apply ?? false,
      multiProvider: fields.multiProvider ?? unsigned,
      chains: fields.chains ?? CHAINS,
      chainAddresses: registry,
      planningSigner: fields.planningSigner ?? signerAddress,
      owner: fields.owner,
      feeTokens,
      persist: {
        exportStore: store,
        writeRegistryAddresses: (chain, addresses) => {
          registryWrites.push({ chain, addresses });
          registry[chain] = addresses;
        },
        writeVerificationInputs: async (chain, inputs) => {
          if (failVerificationWrite) {
            throw new Error('verification file unavailable');
          }
          verificationWrites.push({ chain, inputs });
        },
      },
      writeRegistry: fields.writeRegistry ?? false,
      contractVerifier: fields.contractVerifier,
      readShadowHook: async (chain) => shadowHooks[chain],
      redact: fields.redact ?? ((text) => text),
      concurrency: fields.concurrency ?? 1,
      logger: rootLogger.child({ module: 'ica-quoted-calls-deploy-test' }),
      now: () => '2026-10-08T00:00:00.000Z',
    };
  }

  before(async () => {
    provider = new providers.Web3Provider((method, params) =>
      hre.network.provider.send(method, params),
    );
    signer = provider.getSigner(0);
    signerAddress = await signer.getAddress();
    otherAddress = await provider.getSigner(1).getAddress();
    unsigned = MultiProvider.createTestMultiProvider({ provider });
    signed = MultiProvider.createTestMultiProvider({ signer });

    token = await new ERC20Test__factory(signer).deploy(
      'Fee',
      'FEE',
      FEE_SUPPLY,
      18,
    );
    const gasPaymaster = await new InterchainGasPaymaster__factory(
      signer,
    ).deploy();
    await gasPaymaster.initialize(signerAddress, signerAddress);
    const oracle = await new StorageGasOracle__factory(signer).deploy();
    igp = gasPaymaster.address;
    // The IGP only prices a token for a domain that already has a native oracle.
    await gasPaymaster.setTokenGasOracles(
      CHAINS.flatMap((chain) => [
        {
          feeToken: constants.AddressZero,
          remoteDomain: unsigned.getDomainId(chain),
          gasOracle: oracle.address,
        },
        {
          feeToken: token.address,
          remoteDomain: unsigned.getDomainId(chain),
          gasOracle: oracle.address,
        },
      ]),
    );

    mailboxes = {};
    baseShadowHooks = {};
    for (const chain of CHAINS) {
      const mailbox = await new Mailbox__factory(signer).deploy(
        unsigned.getDomainId(chain),
      );
      mailboxes[chain] = mailbox.address;
      if (chain !== 'test3') {
        const shadow = await new FallbackDomainRoutingHook__factory(
          signer,
        ).deploy(mailbox.address, signerAddress, mailbox.address);
        baseShadowHooks[chain] = shadow.address;
      }
    }
    feeTokens = {
      test1: [{ symbol: 'FEE', address: token.address }],
      test2: [{ symbol: 'FEE', address: token.address }],
      test3: [],
    };
  });

  beforeEach(async () => {
    snapshotId = await hre.network.provider.send('evm_snapshot');
    registry = {};
    for (const chain of CHAINS) {
      registry[chain] = {
        mailbox: mailboxes[chain],
        interchainGasPaymaster: igp,
      };
    }
    shadowHooks = {};
    for (const chain of Object.keys(baseShadowHooks)) {
      shadowHooks[chain] = baseShadowHooks[chain];
    }
    store = createStore();
    verificationWrites = [];
    registryWrites = [];
    failVerificationWrite = false;
  });

  afterEach(async () => {
    sinon.restore();
    await hre.network.provider.send('evm_revert', [snapshotId]);
  });

  async function deployRouter(chain: string, owner: Address) {
    return new InterchainAccountRouter__factory(signer).deploy(
      mailboxes[chain],
      constants.AddressZero,
      owner,
      COMMIT_TX_GAS_USAGE,
      DEFAULT_OFFCHAIN_LOOKUP_ISM_URLS,
    );
  }

  function routerAt(address: Address) {
    return InterchainAccountRouter__factory.connect(address, signer);
  }

  async function sentTxCount() {
    return signer.getTransactionCount();
  }

  async function exported(chain: string) {
    const entry = await store.read(chain);
    assert(entry, `expected an export for ${chain}`);
    return entry;
  }

  async function exportedRouter(chain: string) {
    const address = (await exported(chain)).router?.address;
    assert(address, `expected a router in the export for ${chain}`);
    return routerAt(address);
  }

  function addressOf(result: { router?: { address?: Address } }): Address {
    assert(result.router?.address, 'expected a router address');
    return result.router.address;
  }

  const routerInterface = InterchainAccountRouter__factory.createInterface();

  function failTxWithSelector(multiProvider: MultiProvider, fragment: string) {
    const selector = routerInterface.getSighash(fragment);
    const handleTx = multiProvider.handleTx.bind(multiProvider);
    sinon
      .stub(multiProvider, 'handleTx')
      .callsFake(async (chain, tx, options) => {
        const response = await tx;
        if (response.data.startsWith(selector)) {
          throw new Error('rpc dropped');
        }
        return handleTx(chain, response, options);
      });
  }

  describe('planning', () => {
    it('plans a fresh pair on every chain without a signer', async () => {
      const before = await sentTxCount();
      const results = await runIcaDeploy(buildContext());

      expect(unsigned.tryGetSigner('test1')).to.equal(null);
      expect(await sentTxCount()).to.equal(before);
      expect(results.map((result) => result.outcome)).to.deep.equal([
        IcaOutcome.Planned,
        IcaOutcome.Planned,
        IcaOutcome.Planned,
      ]);
      for (const result of results) {
        expect(result.router?.action).to.equal(Adoption.Deploy);
        expect(result.quotedCalls?.action).to.equal(Adoption.Deploy);
        expect(result.pending).to.include('deploy an InterchainAccountRouter');
        expect(result.pending).to.include('deploy QuotedCalls');
        expect(result.funds?.shortfall.toNumber()).to.equal(0);
        expect(result.funds?.steps.map((step) => step.name)).to.include.members(
          ['deploy InterchainAccountRouter', 'deploy QuotedCalls'],
        );
      }
      const [test1, , test3] = results;
      expect(test1.pending).to.include(`set the hook to ${shadowHooks.test1}`);
      expect(test1.pending).to.include(`approve FEE for ${igp}`);
      expect(test1.pending).to.include(
        'enroll test2, test3 once their routers exist',
      );
      expect(test1.funds?.steps.map((step) => step.name)).to.include.members([
        'setHook',
        'approve FEE',
        'enroll 2 peer(s)',
      ]);
      expect(
        test3.pending.some((item) => item.startsWith('set the hook')),
      ).to.equal(false);
      expect(test3.pending.some((item) => item.startsWith('approve'))).to.equal(
        false,
      );
      expect(test3.notes.join(' ')).to.include('only native fees work');
      expect(await store.read('test1')).to.equal(undefined);
    });

    it('adopts a current pair and plans only the missing wiring', async () => {
      const router = await deployRouter('test1', signerAddress);
      const quotedCalls = await new QuotedCalls__factory(signer).deploy(
        PERMIT2_ADDRESS,
      );
      registry.test1.interchainAccountRouterV3 = router.address;
      registry.test1.quotedCallsV3 = quotedCalls.address;

      const [test1] = await runIcaDeploy(buildContext());

      expect(test1.router).to.deep.include({
        action: Adoption.Adopt,
        address: router.address,
      });
      expect(test1.quotedCalls).to.deep.include({
        action: Adoption.Adopt,
        address: quotedCalls.address,
      });
      expect(test1.pending).to.not.include('deploy an InterchainAccountRouter');
      expect(test1.pending).to.not.include('deploy QuotedCalls');
      expect(test1.pending).to.include(`set the hook to ${shadowHooks.test1}`);
      expect(test1.funds?.steps.map((step) => step.name)).to.not.include(
        'deploy InterchainAccountRouter',
      );
    });

    it('does not adopt a pair stored under the v2 registry keys', async () => {
      const router = await deployRouter('test1', signerAddress);
      const quotedCalls = await new QuotedCalls__factory(signer).deploy(
        PERMIT2_ADDRESS,
      );
      registry.test1.interchainAccountRouter = router.address;
      registry.test1.quotedCalls = quotedCalls.address;

      const [result] = await runIcaDeploy(buildContext());

      expect(result.router?.action).to.equal(Adoption.Deploy);
      expect(result.quotedCalls?.action).to.equal(Adoption.Deploy);
      expect(registry.test1.interchainAccountRouter).to.equal(router.address);
      expect(registry.test1.quotedCalls).to.equal(quotedCalls.address);
      expect(registryWrites).to.deep.equal([]);
    });

    it('does not adopt a current router owned by someone else', async () => {
      const router = await deployRouter('test1', otherAddress);
      registry.test1.interchainAccountRouterV3 = router.address;

      const [test1] = await runIcaDeploy(buildContext());

      expect(test1.router?.action).to.equal(Adoption.Deploy);
      expect(test1.rejected).to.have.length(1);
      expect(test1.rejected[0].reason).to.equal(
        `owner ${otherAddress} is neither the signer nor the target owner`,
      );
    });

    it('adopts a current router that already has the target owner', async () => {
      const router = await deployRouter('test1', otherAddress);
      registry.test1.interchainAccountRouterV3 = router.address;

      const [test1] = await runIcaDeploy(buildContext({ owner: otherAddress }));

      expect(test1.router?.action).to.equal(Adoption.Adopt);
    });

    it('skips a chain without a mailbox in the registry', async () => {
      registry.test2 = {};

      const results = await runIcaDeploy(buildContext());

      expect(results[1].outcome).to.equal(IcaOutcome.Skipped);
      expect(results[1].detail).to.equal(
        'no mailbox for test2 in the registry',
      );
      expect(results[0].outcome).to.equal(IcaOutcome.Planned);
    });
  });

  describe('the recorded shadow hook', () => {
    function expectKept(
      result: { pending: string[]; notes: string[] },
      hook: Address,
      problem: string,
    ) {
      expect(
        result.pending.some((item) => item.startsWith('set the hook')),
      ).to.equal(false);
      expect(result.notes).to.include(
        `shadow routing hook ${hook} ${problem}: keeping the current hook`,
      );
    }

    it('is not wired when it is not a fallback routing hook', async () => {
      const wrongType = await new DomainRoutingHook__factory(signer).deploy(
        mailboxes.test1,
        signerAddress,
      );
      shadowHooks.test1 = wrongType.address;

      const [test1] = await runIcaDeploy(buildContext());

      expectKept(
        test1,
        wrongType.address,
        `has hook type ${OnchainHookType.ROUTING}`,
      );
    });

    it('is not wired when it belongs to another chain', async () => {
      const foreign = await new FallbackDomainRoutingHook__factory(
        signer,
      ).deploy(mailboxes.test2, signerAddress, mailboxes.test2);
      shadowHooks.test1 = foreign.address;

      const [test1] = await runIcaDeploy(buildContext());

      expectKept(
        test1,
        foreign.address,
        `belongs to mailbox ${mailboxes.test2}`,
      );
    });

    it('is not wired when the address has no code', async () => {
      shadowHooks.test1 = otherAddress;

      const [test1] = await runIcaDeploy(buildContext());

      expectKept(test1, otherAddress, 'has no code');
    });

    it('leaves the hook of a deployed router unset when it is not usable', async () => {
      const wrongType = await new DomainRoutingHook__factory(signer).deploy(
        mailboxes.test1,
        signerAddress,
      );
      shadowHooks.test1 = wrongType.address;

      const results = await runIcaDeploy(
        buildContext({ apply: true, multiProvider: signed }),
      );

      expect(await routerAt(addressOf(results[0])).hook()).to.equal(
        constants.AddressZero,
      );
      expect(await routerAt(addressOf(results[1])).hook()).to.equal(
        shadowHooks.test2,
      );
    });
  });

  describe('candidates without code', () => {
    it('reports a registry address that has no code and plans a fresh deploy', async () => {
      registry.test1.interchainAccountRouterV3 = otherAddress;
      registry.test1.quotedCallsV3 = otherAddress;

      const [test1] = await runIcaDeploy(buildContext());

      expect(test1.router?.action).to.equal(Adoption.Deploy);
      expect(test1.rejected).to.deep.equal([
        { address: otherAddress, source: 'registry', reason: 'has no code' },
        { address: otherAddress, source: 'registry', reason: 'has no code' },
      ]);
    });

    it('reports a recorded address that has no code', async () => {
      await store.update(
        'test1',
        {
          signer: signerAddress,
          owner: signerAddress,
          registryBefore: {},
          router: { address: otherAddress, version: CONTRACTS_PACKAGE_VERSION },
        },
        '2026-10-08T00:00:00.000Z',
      );

      const [test1] = await runIcaDeploy(buildContext());

      expect(test1.router?.action).to.equal(Adoption.Deploy);
      expect(test1.rejected).to.deep.include({
        address: otherAddress,
        source: 'export',
        reason: 'has no code',
      });
    });
  });

  describe('fees the chain metadata pins', () => {
    it('prices the funds with the pinned max fee', async () => {
      const PINNED_MAX_FEE = 7;
      const pinned = unsigned.extendChainMetadata({
        test1: { transactionOverrides: { maxFeePerGas: PINNED_MAX_FEE } },
      });
      pinned.setProviders({
        test1: provider,
        test2: provider,
        test3: provider,
      });

      const [test1, test2] = await runIcaDeploy(
        buildContext({ multiProvider: pinned }),
      );

      const worstCase = (steps: { gas: BigNumber }[]) =>
        steps.reduce(
          (total, step) =>
            total.add(addBufferToGasLimit(step.gas).mul(PINNED_MAX_FEE)),
          BigNumber.from(0),
        );
      assert(test1.funds && test2.funds, 'expected funds reports');
      expect(test1.funds.worstCase.toString()).to.equal(
        worstCase(test1.funds.steps).toString(),
      );
      expect(test2.funds.worstCase.gt(test1.funds.worstCase)).to.equal(true);
    });
  });

  describe('funds check', () => {
    it('reports insufficient funds in a plan for a signer that cannot pay', async () => {
      const poor = Wallet.createRandom().address;

      const results = await runIcaDeploy(
        buildContext({ planningSigner: poor }),
      );

      for (const result of results) {
        expect(result.outcome).to.equal(IcaOutcome.InsufficientFunds);
        expect(result.funds?.balance.toNumber()).to.equal(0);
        expect(result.funds?.shortfall.gt(0)).to.equal(true);
        expect(result.detail).to.include(`${poor} needs`);
      }
    });

    it('sends nothing on a chain the signer cannot finish', async () => {
      const poor = MultiProvider.createTestMultiProvider({
        signer: Wallet.createRandom().connect(provider),
      });
      const handleDeploy = sinon.spy(poor, 'handleDeploy');
      const handleTx = sinon.spy(poor, 'handleTx');

      const results = await runIcaDeploy(
        buildContext({ apply: true, multiProvider: poor }),
      );

      expect(handleDeploy.callCount).to.equal(0);
      expect(handleTx.callCount).to.equal(0);
      for (const result of results) {
        expect(result.outcome).to.equal(IcaOutcome.InsufficientFunds);
      }
      expect(computeExitCode(results, { apply: true })).to.equal(1);
      expect(await store.read('test1')).to.equal(undefined);
    });
  });

  describe('deploying', () => {
    function deployAll(fields: ContextFields = {}) {
      return runIcaDeploy(
        buildContext({
          apply: true,
          multiProvider: fields.multiProvider ?? signed,
          owner: fields.owner,
          chains: fields.chains,
          contractVerifier: fields.contractVerifier,
          writeRegistry: fields.writeRegistry,
        }),
      );
    }

    it('deploys a deployer-owned pair, wires every pair of chains and records it', async () => {
      const results = await deployAll();

      expect(results.map((result) => result.outcome)).to.deep.equal([
        IcaOutcome.Applied,
        IcaOutcome.Applied,
        IcaOutcome.Applied,
      ]);
      const routers = Object.fromEntries(
        results.map((result) => [result.chain, addressOf(result)]),
      );
      for (const result of results) {
        const router = routerAt(addressOf(result));
        expect(await router.owner()).to.equal(signerAddress);
        expect(await router.mailbox()).to.equal(mailboxes[result.chain]);
        expect(await router.PACKAGE_VERSION()).to.equal(
          CONTRACTS_PACKAGE_VERSION,
        );
        for (const peer of CHAINS.filter((chain) => chain !== result.chain)) {
          expect(await router.routers(signed.getDomainId(peer))).to.equal(
            addressToBytes32(routers[peer]),
          );
        }
        const quotedCalls = QuotedCalls__factory.connect(
          result.quotedCalls?.address ?? constants.AddressZero,
          signer,
        );
        expect(await quotedCalls.PERMIT2()).to.equal(PERMIT2_ADDRESS);
        expect(await quotedCalls.PACKAGE_VERSION()).to.equal(
          CONTRACTS_PACKAGE_VERSION,
        );
      }

      // The hook and the standing fee token approval exist where a shadow hook
      // and a priced token do, and nowhere else.
      for (const chain of ['test1', 'test2']) {
        expect(await routerAt(routers[chain]).hook()).to.equal(
          shadowHooks[chain],
        );
        expect(await token.allowance(routers[chain], igp)).to.equal(
          constants.MaxUint256,
        );
      }
      expect(await routerAt(routers.test3).hook()).to.equal(
        constants.AddressZero,
      );
      expect(await token.allowance(routers.test3, igp)).to.equal(0);

      const entry = await exported('test1');
      expect(entry.router?.address).to.equal(routers.test1);
      expect(entry.quotedCalls?.address).to.equal(
        results[0].quotedCalls?.address,
      );
      expect(entry.hook).to.equal(shadowHooks.test1);
      expect(entry.enrolledPeers).to.deep.equal(['test2', 'test3']);
      expect(entry.approvals).to.deep.equal([
        { feeToken: token.address, spender: igp },
      ]);
      expect(entry.registryBefore).to.deep.equal({});
      expect(registry.test1.interchainAccountRouterV3).to.equal(undefined);

      expect(
        verificationWrites
          .filter((write) => write.chain === 'test1')
          .flatMap((write) => write.inputs.map((input) => input.name))
          .sort(),
      ).to.deep.equal(['InterchainAccountRouter', 'QuotedCalls']);
    });

    it('keeps the post-deploy gas allowances above what the calls really use', async () => {
      const used: Record<string, BigNumber> = {};
      const handleTx = signed.handleTx.bind(signed);
      sinon.stub(signed, 'handleTx').callsFake(async (chain, tx, options) => {
        const response = await tx;
        const receipt = await handleTx(chain, response, options);
        used[response.data.slice(0, 10)] = receipt.gasUsed;
        return receipt;
      });

      await deployAll({ owner: otherAddress });

      const gasOf = (fragment: string) => {
        const gas = used[routerInterface.getSighash(fragment)];
        assert(gas, `expected a ${fragment} transaction`);
        return gas.toNumber();
      };
      expect(gasOf('setHook')).to.be.lessThan(
        POST_DEPLOY_GAS.setHook.toNumber(),
      );
      expect(gasOf('approveFeeTokenForHook')).to.be.lessThan(
        POST_DEPLOY_GAS.approve.toNumber(),
      );
      expect(gasOf('enrollRemoteRouters')).to.be.lessThan(
        POST_DEPLOY_GAS.enrollPerPeer.toNumber() * 2,
      );
      expect(gasOf('transferOwnership')).to.be.lessThan(
        POST_DEPLOY_GAS.transferOwnership.toNumber(),
      );
    });

    it('is a no-op once converged, even though the registry still holds the old addresses', async () => {
      await deployAll();
      const before = await sentTxCount();
      const writesBefore = verificationWrites.length;

      const results = await deployAll();

      expect(results.map((result) => result.outcome)).to.deep.equal([
        IcaOutcome.UpToDate,
        IcaOutcome.UpToDate,
        IcaOutcome.UpToDate,
      ]);
      expect(await sentTxCount()).to.equal(before);
      expect(verificationWrites).to.have.length(writesBefore);
      for (const result of results) {
        expect(result.router?.action).to.equal(Adoption.Adopt);
        expect(result.pending).to.deep.equal([]);
      }
    });

    it('hands ownership to the target owner as the last step and converges there', async () => {
      const results = await deployAll({ owner: otherAddress });

      for (const result of results) {
        expect(result.outcome).to.equal(IcaOutcome.Applied);
        const router = routerAt(addressOf(result));
        expect(await router.owner()).to.equal(otherAddress);
        for (const peer of CHAINS.filter((chain) => chain !== result.chain)) {
          expect(await router.routers(signed.getDomainId(peer))).to.not.equal(
            constants.HashZero,
          );
        }
      }
      expect((await exported('test1')).owner).to.equal(otherAddress);
      expect(results[0].notes.join(' ')).to.include(
        `commitment ISM (CCIP_READ_ISM) stays owned by ${signerAddress}`,
      );

      const before = await sentTxCount();
      const rerun = await deployAll({ owner: otherAddress });
      expect(rerun.map((result) => result.outcome)).to.deep.equal([
        IcaOutcome.UpToDate,
        IcaOutcome.UpToDate,
        IcaOutcome.UpToDate,
      ]);
      expect(await sentTxCount()).to.equal(before);
    });

    it('keeps the signer as owner when a wiring step fails', async () => {
      failTxWithSelector(signed, 'enrollRemoteRouters');

      const results = await deployAll({ owner: otherAddress });

      for (const result of results) {
        expect(result.outcome).to.equal(IcaOutcome.Error);
        expect(result.detail).to.include('rpc dropped');
        expect(await (await exportedRouter(result.chain)).owner()).to.equal(
          signerAddress,
        );
      }
    });

    it('adopts the router recorded before a crash instead of deploying another', async () => {
      const handleDeploy = signed.handleDeploy.bind(signed);
      let deploys = 0;
      sinon.stub(signed, 'handleDeploy').callsFake(async (...args) => {
        deploys++;
        if (deploys === 2) throw new Error('rpc dropped');
        return handleDeploy(...args);
      });
      const failed = await deployAll({ chains: ['test1'] });
      expect(failed[0].outcome).to.equal(IcaOutcome.Error);
      const recorded = (await exported('test1')).router?.address;
      assert(recorded, 'expected the router in the export');
      expect((await exported('test1')).quotedCalls).to.equal(undefined);
      sinon.restore();

      const rerun = await deployAll({ chains: ['test1'] });

      expect(rerun[0].outcome).to.equal(IcaOutcome.Applied);
      expect(rerun[0].router).to.deep.include({
        action: Adoption.Adopt,
        address: recorded,
      });
      expect(rerun[0].quotedCalls?.deployed).to.equal(true);
    });

    it('records each address before the explorer is asked to verify it', async () => {
      const verifier = sinon.createStubInstance(ContractVerifier);
      const seen: Array<{ hasRouter: boolean; hasQuotedCalls: boolean }> = [];
      verifier.verifyContract.callsFake(async (chain) => {
        const entry = await store.read(chain);
        seen.push({
          hasRouter: entry?.router !== undefined,
          hasQuotedCalls: entry?.quotedCalls !== undefined,
        });
      });

      await deployAll({ contractVerifier: verifier });

      expect(seen).to.have.length(6);
      for (const observed of seen) {
        expect(observed).to.deep.equal({
          hasRouter: true,
          hasQuotedCalls: true,
        });
      }
    });

    it('still reports the deployment when explorer verification fails', async () => {
      const verifier = sinon.createStubInstance(ContractVerifier);
      verifier.verifyContract.rejects(new Error('explorer unavailable'));

      const results = await deployAll({ contractVerifier: verifier });

      for (const result of results) {
        expect(result.outcome).to.equal(IcaOutcome.Applied);
      }
    });

    it('surfaces verification inputs that could not be persisted', async () => {
      failVerificationWrite = true;

      const results = await deployAll();

      for (const result of results) {
        expect(result.outcome).to.equal(IcaOutcome.Error);
        expect(result.detail).to.include(
          'verification inputs were not persisted',
        );
        expect((await exported(result.chain)).router).to.not.equal(undefined);
      }
    });

    it('leaves the other chains wired and the failed peer pending when one chain fails', async () => {
      const handleDeploy = signed.handleDeploy.bind(signed);
      sinon.stub(signed, 'handleDeploy').callsFake(async (chain, ...rest) => {
        if (chain === 'test3') throw new Error('rpc dropped');
        return handleDeploy(chain, ...rest);
      });

      const results = await deployAll();

      expect(results[2].outcome).to.equal(IcaOutcome.Error);
      expect(results[0].outcome).to.equal(IcaOutcome.Applied);
      expect(results[0].pending).to.include(
        'enroll test3 once their routers exist',
      );
      expect(
        await routerAt(addressOf(results[0])).routers(
          signed.getDomainId('test2'),
        ),
      ).to.equal(addressToBytes32(addressOf(results[1])));
      expect(
        await routerAt(addressOf(results[1])).routers(
          signed.getDomainId('test1'),
        ),
      ).to.equal(addressToBytes32(addressOf(results[0])));
      expect(computeExitCode(results, { apply: true })).to.equal(1);
    });

    it('keeps the deploy transaction hashes when a rerun adopts the pair', async () => {
      await deployAll({ chains: ['test1'] });
      const first = await exported('test1');
      expect(first.router?.deployTxHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(first.quotedCalls?.deployTxHash).to.match(/^0x[0-9a-f]{64}$/);

      await deployAll({ chains: ['test1'] });

      expect(await exported('test1')).to.deep.equal(first);
    });

    it('keeps the router a new signer replaces on the superseded list', async () => {
      const [first] = await deployAll({ chains: ['test1'] });
      const replacement = MultiProvider.createTestMultiProvider({
        signer: provider.getSigner(1),
      });

      const [second] = await deployAll({
        chains: ['test1'],
        multiProvider: replacement,
      });

      expect(second.router?.address).to.not.equal(first.router?.address);
      expect(second.rejected.map((rejected) => rejected.address)).to.include(
        first.router?.address,
      );
      const entry = await exported('test1');
      expect(entry.router?.address).to.equal(second.router?.address);
      expect(entry.superseded).to.have.length(1);
      expect(entry.superseded[0]).to.deep.include({
        contract: ContractKind.Router,
        address: first.router?.address,
      });
    });

    it('reports an unfinished apply when a peer was skipped', async () => {
      registry.test2 = {};

      const results = await deployAll({ chains: ['test1', 'test2'] });

      expect(results[0].outcome).to.equal(IcaOutcome.Applied);
      expect(results[0].wiring?.awaiting).to.deep.equal(['test2']);
      expect(computeExitCode(results, { apply: true })).to.equal(1);
      expect(computeExitCode(results, { apply: false })).to.equal(0);
    });

    it('keeps the signing key out of the error of a failed chain', async () => {
      const key = Wallet.fromMnemonic(HARDHAT_MNEMONIC, "m/44'/60'/0'/0/3");
      const keyed = MultiProvider.createTestMultiProvider({ provider });
      keyed.setSharedSigner(key);
      sinon
        .stub(keyed, 'handleDeploy')
        .rejects(new Error(`could not send, signed with ${key.privateKey}`));

      const results = await runIcaDeploy(
        buildContext({
          apply: true,
          multiProvider: keyed,
          planningSigner: key.address,
          concurrency: 1,
          redact: createKeyRedactor(key),
        }),
      );

      for (const result of results) {
        expect(result.outcome).to.equal(IcaOutcome.Error);
        expect(result.detail).to.include(REDACTED_KEY);
        expect(result.detail).to.not.include(key.privateKey);
        expect(result.detail).to.not.include(key.privateKey.slice(2));
      }
    });
  });

  describe('deploys that were not confirmed', () => {
    const NOW = '2026-10-08T00:00:00.000Z';

    function deployTest1(multiProvider: MultiProvider = signed) {
      return runIcaDeploy(
        buildContext({ apply: true, multiProvider, chains: ['test1'] }),
      );
    }

    async function recordPending(nonce: number, address: Address) {
      await store.update(
        'test1',
        {
          signer: signerAddress,
          owner: signerAddress,
          registryBefore: {},
          pending: {
            contract: ContractKind.Router,
            address,
            signer: signerAddress,
            nonce,
          },
        },
        NOW,
      );
    }

    it('adopts a contract that mined while its confirmation timed out', async () => {
      const handleDeploy = signed.handleDeploy.bind(signed);
      let calls = 0;
      sinon.stub(signed, 'handleDeploy').callsFake(async (...args) => {
        calls++;
        const deployed = await handleDeploy(...args);
        if (calls === 1) throw new Error('confirmation timed out');
        return deployed;
      });
      const [failed] = await deployTest1();
      expect(failed.outcome).to.equal(IcaOutcome.Error);
      expect(failed.detail).to.include('confirmation timed out');
      const [pending] = (await exported('test1')).pending;
      expect(pending.contract).to.equal(ContractKind.Router);
      expect(await provider.getCode(pending.address)).to.not.equal('0x');
      expect((await exported('test1')).router).to.equal(undefined);
      sinon.restore();

      const [rerun] = await deployTest1();

      expect(rerun.router).to.deep.include({
        action: Adoption.Adopt,
        address: pending.address,
      });
      expect((await exported('test1')).router?.address).to.equal(
        pending.address,
      );
      expect((await exported('test1')).pending).to.deep.equal([]);
    });

    it('forgets a deploy that never reached the node', async () => {
      sinon.stub(signed, 'handleDeploy').rejects(new Error('rpc dropped'));

      const [failed] = await deployTest1();

      expect(failed.outcome).to.equal(IcaOutcome.Error);
      expect((await exported('test1')).pending).to.deep.equal([]);
      sinon.restore();

      const [rerun] = await deployTest1();
      expect(rerun.router?.deployed).to.equal(true);
    });

    it('does not deploy a second copy while the first is not mined', async () => {
      await recordPending(await sentTxCount(), NEVER_DEPLOYED);
      const handleDeploy = sinon.spy(signed, 'handleDeploy');

      const [blocked] = await deployTest1();

      expect(blocked.outcome).to.equal(IcaOutcome.Error);
      expect(blocked.detail).to.include('is not mined yet');
      expect(blocked.detail).to.include(NEVER_DEPLOYED);
      expect(handleDeploy.callCount).to.equal(0);
      expect((await exported('test1')).pending).to.have.length(1);
    });

    it('reports the same block in a plan', async () => {
      await recordPending(await sentTxCount(), NEVER_DEPLOYED);

      const [blocked] = await runIcaDeploy(buildContext({ chains: ['test1'] }));

      expect(blocked.outcome).to.equal(IcaOutcome.Error);
      expect(blocked.detail).to.include('is not mined yet');
    });

    it('deploys again once the nonce moved on without creating the contract', async () => {
      const nonce = await sentTxCount();
      await recordPending(nonce, NEVER_DEPLOYED);
      await (
        await signer.sendTransaction({ to: otherAddress, value: 1 })
      ).wait();
      expect(await sentTxCount()).to.be.greaterThan(nonce);

      const [rerun] = await deployTest1();

      expect(rerun.outcome).to.equal(IcaOutcome.Applied);
      expect(rerun.router?.deployed).to.equal(true);
      expect(rerun.notes.join(' ')).to.include('never happened');
      const entry = await exported('test1');
      expect(entry.pending).to.deep.equal([]);
      expect(entry.router?.address).to.equal(rerun.router?.address);
    });
  });

  describe('registry migration', () => {
    function deployAll(fields: ContextFields = {}) {
      return runIcaDeploy(
        buildContext({
          apply: true,
          multiProvider: signed,
          chains: fields.chains,
          writeRegistry: fields.writeRegistry,
        }),
      );
    }

    it('leaves the registry alone unless asked', async () => {
      await deployAll();
      expect(registryWrites).to.deep.equal([]);
      expect(registry.test1.interchainAccountRouterV3).to.equal(undefined);
    });

    it('adds v3 keys for fully wired chains and preserves the v2 pair', async () => {
      for (const chain of CHAINS) {
        registry[chain].interchainAccountRouter = otherAddress;
        registry[chain].quotedCalls = otherAddress;
      }
      const results = await deployAll({ writeRegistry: true });

      expect(registryWrites.map((write) => write.chain).sort()).to.deep.equal(
        CHAINS,
      );
      for (const result of results) {
        const written = registryWrites.find(
          (write) => write.chain === result.chain,
        );
        expect(written?.addresses).to.deep.equal({
          mailbox: mailboxes[result.chain],
          interchainGasPaymaster: igp,
          interchainAccountRouter: otherAddress,
          quotedCalls: otherAddress,
          interchainAccountRouterV3: result.router?.address,
          quotedCallsV3: result.quotedCalls?.address,
        });
        expect(result.registryKeysWritten).to.deep.equal([
          'interchainAccountRouterV3',
          'quotedCallsV3',
        ]);
      }
    });

    it('does not write a chain that still has a peer to enroll', async () => {
      const handleDeploy = signed.handleDeploy.bind(signed);
      sinon.stub(signed, 'handleDeploy').callsFake(async (chain, ...rest) => {
        if (chain === 'test3') throw new Error('rpc dropped');
        return handleDeploy(chain, ...rest);
      });

      const results = await deployAll({ writeRegistry: true });

      expect(registryWrites).to.deep.equal([]);
      expect(results[0].notes.join(' ')).to.include('registry not updated');
    });

    it('remembers the registry as it was and is a no-op once migrated', async () => {
      const foreign = await deployRouter('test1', otherAddress);
      registry.test1.interchainAccountRouterV3 = foreign.address;

      const first = await deployAll({ writeRegistry: true });

      expect(first[0].registryBefore).to.deep.equal({
        interchainAccountRouterV3: foreign.address,
      });
      expect((await exported('test1')).registryBefore).to.deep.equal({
        interchainAccountRouterV3: foreign.address,
      });
      const writes = registryWrites.length;
      const before = await sentTxCount();

      const rerun = await deployAll({ writeRegistry: true });

      expect(rerun.map((result) => result.outcome)).to.deep.equal([
        IcaOutcome.UpToDate,
        IcaOutcome.UpToDate,
        IcaOutcome.UpToDate,
      ]);
      expect(registryWrites).to.have.length(writes);
      expect(await sentTxCount()).to.equal(before);
      expect(rerun[0].router).to.deep.include({
        action: Adoption.Adopt,
        address: first[0].router?.address,
      });
    });

    it('migrates a chain that converged before the registry was written', async () => {
      await deployAll();
      expect(registryWrites).to.deep.equal([]);

      const rerun = await deployAll({ writeRegistry: true });

      expect(rerun.map((result) => result.outcome)).to.deep.equal([
        IcaOutcome.UpToDate,
        IcaOutcome.UpToDate,
        IcaOutcome.UpToDate,
      ]);
      expect(registryWrites).to.have.length(3);
    });
  });

  describe('existing routers', () => {
    it('reports an enrollment that conflicts without wiring the router', async () => {
      const router = await deployRouter('test1', signerAddress);
      await router.enrollRemoteRouters(
        [signed.getDomainId('test2')],
        [addressToBytes32(otherAddress)],
      );
      registry.test1.interchainAccountRouterV3 = router.address;
      const quotedCalls = await new QuotedCalls__factory(signer).deploy(
        PERMIT2_ADDRESS,
      );
      registry.test1.quotedCallsV3 = quotedCalls.address;

      const [test1] = await runIcaDeploy(
        buildContext({
          apply: true,
          multiProvider: signed,
          chains: ['test1', 'test2'],
        }),
      );

      expect(test1.outcome).to.equal(IcaOutcome.Error);
      expect(test1.detail).to.include('enrollment is immutable');
      expect(await router.hook()).to.equal(constants.AddressZero);
      expect(await token.allowance(router.address, igp)).to.equal(0);
      expect(test1.enrolledPeers).to.deep.equal([]);
    });

    it('refuses to wire a router the signer does not own', async () => {
      const router = await deployRouter('test1', otherAddress);
      registry.test1.interchainAccountRouterV3 = router.address;

      const [test1] = await runIcaDeploy(
        buildContext({
          apply: true,
          multiProvider: signed,
          owner: otherAddress,
          chains: ['test1', 'test2'],
        }),
      );

      expect(test1.outcome).to.equal(IcaOutcome.Error);
      expect(test1.detail).to.include(
        `Signer ${signerAddress} is not the owner`,
      );
      expect(await router.hook()).to.equal(constants.AddressZero);
    });
  });

  describe('signing with a key from the environment', () => {
    let wallet: Wallet;
    let previous: string | undefined;

    beforeEach(() => {
      wallet = Wallet.fromMnemonic(HARDHAT_MNEMONIC, "m/44'/60'/0'/0/2");
      previous = process.env[KEY_ENV];
      process.env[KEY_ENV] = wallet.privateKey;
    });

    afterEach(() => {
      if (previous === undefined) delete process.env[KEY_ENV];
      else process.env[KEY_ENV] = previous;
    });

    it('deploys, owns and wires everything with that key and no other signer', async () => {
      const loaded = loadWalletFromEnv(KEY_ENV);
      const keyed = MultiProvider.createTestMultiProvider({ provider });
      keyed.setSharedSigner(loaded);

      const results = await runIcaDeploy(
        buildContext({
          apply: true,
          multiProvider: keyed,
          planningSigner: loaded.address,
          concurrency: 1,
        }),
      );

      expect(loaded.address).to.equal(wallet.address);
      for (const result of results) {
        expect(result.outcome, result.detail).to.equal(IcaOutcome.Applied);
        expect(result.signer).to.equal(wallet.address);
        expect(result.owner).to.equal(wallet.address);
        expect(await routerAt(addressOf(result)).owner()).to.equal(
          wallet.address,
        );
      }
      expect((await exported('test1')).signer).to.equal(wallet.address);
    });

    it('plans with the address derived from the key and signs nothing', async () => {
      const loaded = loadWalletFromEnv(KEY_ENV);
      const before = await sentTxCount();

      const results = await runIcaDeploy(
        buildContext({ planningSigner: loaded.address }),
      );

      for (const result of results) {
        expect(result.signer).to.equal(wallet.address);
        expect(result.funds?.balance.gt(0)).to.equal(true);
      }
      expect(unsigned.tryGetSigner('test1')).to.equal(null);
      expect(await sentTxCount()).to.equal(before);
    });
  });
});
