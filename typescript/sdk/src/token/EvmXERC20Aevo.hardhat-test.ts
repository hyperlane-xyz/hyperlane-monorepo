import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Contract, ethers } from 'ethers';
import hre from 'hardhat';
import sinon from 'sinon';

import {
  ERC20Test__factory,
  Mailbox,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import {
  HyperlaneAddresses,
  HyperlaneContractsMap,
  RouterConfig,
  TestChainName,
  serializeContracts,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  assert,
  eqAddress,
  isNullish,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

import { UIN256_MAX_VALUE } from '../consts/numbers.js';
import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import {
  AEVO_ACCOUNTS,
  AEVO_ACCOUNTS_STAND_IN_CODE,
  AEVO_L2_BRIDGE,
  AEVO_OWNER_SELECTORS,
  AEVO_SELECTORS,
  AEVO_USDC_PROXY,
  abiWord,
  aevoRaw,
  aevoUnauthorized,
  aevoUnlimited,
} from '../test/aevoTokenFixture.js';
import { deployAevoXERC20Token } from '../test/aevoToken.js';
import { randomAddress } from '../test/testUtils.js';
import { ChainMap } from '../types.js';
import { revertToSnapshot, snapshot } from '../utils/fork.js';

import { EvmHypAevoXERC20Adapter } from './adapters/EvmTokenAdapter.js';
import { EvmWarpModule } from './EvmWarpModule.js';
import { EvmWarpRouteReader } from './EvmWarpRouteReader.js';
import { EvmXERC20Module, XERC20ModuleConfig } from './EvmXERC20Module.js';
import { AevoXERC20Limits } from './EvmXERC20Reader.js';
import { TokenStandard } from './TokenStandard.js';
import { TokenType } from './config.js';
import {
  HypTokenRouterConfig,
  HypTokenRouterConfigSchema,
  XERC20AevoCapType,
  XERC20TokenMetadata,
  XERC20Type,
} from './types.js';
import { AEVO_OUTSTANDING_SELECTOR } from './xerc20-abi.js';
import { deriveEvmXERC20Standard, deriveXERC20TokenType } from './xerc20.js';
import { checkWarpRouteDeployConfig } from './warpCheck.js';

chai.use(chaiAsPromised);
const { expect } = chai;

// `Unauthorized()`, which the real token reverts with for anyone but its owner.
const UNAUTHORIZED_SELECTOR = '0x82b42900';
// `NotAuthority()`, which it reverts a mint of a minter that is not authorized
// with, and `0x09113c3a(address)`, which it reverts a mint beyond the cap with.
const NOT_AUTHORITY_SELECTOR = '0x31212686';
const CAP_EXCEEDED_SELECTOR = '0x09113c3a';
// `0x40f0c8f6(address)`, which it reverts a burn beyond what the minter has
// minted and not burned with.
const BURN_BEYOND_MINTED_SELECTOR = '0x40f0c8f6';
// The mapping of the balances of the token, and the one of what each minter has
// minted and not burned, the slots of the recorded token.
const BALANCES_SLOT = 8;
const OUTSTANDING_SLOT = 11;
// What it reverts setOwner of the zero address with.
const TOKEN_ZERO_ADDRESS_ERROR_SELECTOR = '0xd92e233d';

// The real Aevo USDC token, its bytecode recorded from the aevo chain and
// etched at the addresses it has there. Nothing of it is mocked: deployed
// without constructor, it is initialized through its proxy as on the chain.
describe('Aevo xERC20 token', async () => {
  const chain = TestChainName.test4;
  let signer: SignerWithAddress;
  let stranger: SignerWithAddress;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let routerConfigMap: ChainMap<RouterConfig>;
  let baseConfig: RouterConfig;
  let mailbox: Mailbox;
  let factories: HyperlaneContractsMap<ProxyFactoryFactories>;
  let ismFactoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>;
  let aevoToken: Contract;
  async function authorize(minter: Address, cap?: number) {
    await (await aevoToken.updateAuthority(minter, true)).wait();
    if (!isNullish(cap)) await (await aevoToken.setCap(minter, cap)).wait();
  }

  async function sendTxs(txs: AnnotatedEV5Transaction[]) {
    for (const tx of txs) {
      await multiProvider.sendTransaction(chain, tx);
    }
  }

  // What the token itself holds for the minter, as it keeps it.
  async function mintAuthority(minter: Address) {
    const [authorized, cap] = await Promise.all([
      aevoToken.authorities(minter),
      aevoToken.caps(minter),
    ]);
    return { authorized, cap: cap.toString() };
  }

  // A mint credits no wallet, so the one that burns is credited in the storage
  // of the token.
  async function fund(holder: Address, amount: bigint) {
    await hre.network.provider.send('hardhat_setStorageAt', [
      AEVO_USDC_PROXY,
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['address', 'uint256'],
          [holder, BALANCES_SLOT],
        ),
      ),
      ethers.utils.hexZeroPad(ethers.BigNumber.from(amount).toHexString(), 32),
    ]);
    expect((await aevoToken.balanceOf(holder)).toBigInt()).to.equal(amount);
  }

  // A minter the test can mint as: an address that signs.
  async function impersonate(address: Address): Promise<Contract> {
    await hre.network.provider.send('hardhat_impersonateAccount', [address]);
    await hre.network.provider.send('hardhat_setBalance', [
      address,
      '0x56bc75e2d63100000',
    ]);
    return aevoToken.connect(await hre.ethers.getSigner(address));
  }

  before(async () => {
    [signer, stranger] = await hre.ethers.getSigners();

    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const proxyFactoryDeployer = new HyperlaneProxyFactoryDeployer(
      multiProvider,
    );
    factories = await proxyFactoryDeployer.deploy(
      multiProvider.mapKnownChains(() => ({})),
    );
    ismFactoryAddresses = serializeContracts(factories[chain]);
    coreApp = await new TestCoreDeployer(
      multiProvider,
      new HyperlaneIsmFactory(factories, multiProvider),
    ).deployApp();
    routerConfigMap = coreApp.getRouterConfig(signer.address);
    baseConfig = routerConfigMap[chain];
    mailbox = Mailbox__factory.connect(baseConfig.mailbox, signer);

    const deployedToken = await deployAevoXERC20Token({ deployer: signer });
    aevoToken = new Contract(
      deployedToken.address,
      [
        'function owner() view returns (address)',
        'function authorities(address minter) view returns (bool)',
        'function caps(address minter) view returns (uint256)',
        'function updateAuthority(address minter, bool authorized)',
        'function setCap(address minter, uint256 cap)',
        'function mint(address to, uint256 amount)',
        'function setOwner(address newOwner)',
        'function burn(address from, uint256 amount)',
        'function totalSupply() view returns (uint256)',
        'function balanceOf(address account) view returns (uint256)',
      ],
      signer,
    );
    assert(
      (await aevoToken.owner()) === signer.address,
      'Expected the signer to own the etched Aevo token',
    );
  });

  // The tests authorize minters, set caps and hand the token over, so each of
  // them starts from the state the setup left, whichever tests ran before it and
  // however often it runs. A revert consumes its snapshot, so each test takes
  // its own.
  let snapshotId: string | undefined;
  beforeEach(async () => {
    snapshotId = undefined;
    snapshotId = await snapshot(hre.ethers.provider);
  });
  afterEach(async () => {
    // No snapshot is held when this test's own could not be taken, and the id of
    // an earlier test is consumed.
    const id = snapshotId;
    snapshotId = undefined;
    if (isNullish(id)) return;

    assert(
      await revertToSnapshot(hre.ethers.provider, id),
      `Failed to revert to the snapshot ${id} of the setup`,
    );
  });

  describe('deployAevoXERC20Token', () => {
    const setAccountsCode = (code: string) =>
      hre.network.provider.send('hardhat_setCode', [AEVO_ACCOUNTS, code]);

    // A mint deposits to the Accounts contract, which reverts it where there is
    // no code at its address.
    it('lets an authorized minter mint on a node that had no code at the Accounts address', async () => {
      await setAccountsCode('0x');
      await deployAevoXERC20Token({ deployer: signer });
      const address = randomAddress();
      await authorize(address);

      await (
        await (await impersonate(address)).mint(randomAddress(), 1)
      ).wait();

      expect(await hre.ethers.provider.getCode(AEVO_ACCOUNTS)).to.equal(
        AEVO_ACCOUNTS_STAND_IN_CODE,
      );
    });

    it('leaves the code it finds at the Accounts address alone, however often it runs', async () => {
      const found = '0x600060005260206000f3';
      await setAccountsCode(found);

      for (let run = 0; run < 2; run++) {
        await deployAevoXERC20Token({ deployer: signer });

        expect(await hre.ethers.provider.getCode(AEVO_ACCOUNTS)).to.equal(
          found,
        );
      }

      await setAccountsCode(AEVO_ACCOUNTS_STAND_IN_CODE);
    });

    interface BalanceCase {
      name: string;
      balance: bigint;
      // Whether the owner is funded to pay for the hand-over, which it is only
      // where it holds less than it needs.
      funded: boolean;
    }

    const FUNDS = 2n * 10n ** 18n;

    // What the transactions that the address sent in the latest block cost it.
    // The hand-over of the token is the last block that is mined, and an owner
    // that is not given funds pays for it with what it holds.
    async function gasPaidBy(address: string): Promise<bigint> {
      const block =
        await hre.ethers.provider.getBlockWithTransactions('latest');
      let paid = 0n;
      for (const tx of block.transactions) {
        if (!eqAddress(tx.from, address)) continue;
        const receipt = await hre.ethers.provider.getTransactionReceipt(
          tx.hash,
        );
        paid += receipt.gasUsed.mul(receipt.effectiveGasPrice).toBigInt();
      }
      return paid;
    }

    // Taking the token back is done as its owner, which is impersonated for it,
    // gets the funds to pay for it only when it holds too little, and has its
    // balance set back only then: it is left with the balance it had, as a node
    // that keeps its state, or a fork, has it as it left it. An owner that holds
    // enough is not touched, and keeps what it holds after paying for the
    // hand-over.
    const balanceCases: BalanceCase[] = [
      { name: 'more than it needs', balance: 10n * 10n ** 18n, funded: false },
      { name: 'exactly what it needs', balance: FUNDS, funded: false },
      { name: 'less than it needs', balance: 10n ** 15n, funded: true },
      { name: 'nothing', balance: 0n, funded: true },
    ];

    for (const c of balanceCases) {
      it(`takes the token back from an owner with ${c.name}, and leaves its balance ${c.funded ? 'as it found it' : 'as the hand-over left it'}`, async () => {
        const previousOwner = randomAddress();
        await (await aevoToken.setOwner(previousOwner)).wait();
        await hre.network.provider.send('hardhat_setBalance', [
          previousOwner,
          ethers.utils.hexValue(c.balance),
        ]);

        // A provider of its own, on the same node, whose requests can be read.
        const provider = new ethers.providers.Web3Provider((method, params) =>
          hre.network.provider.send(method, params),
        );
        const send = sinon.spy(provider, 'send');

        await deployAevoXERC20Token({
          deployer: provider.getSigner(signer.address),
        });

        expect(await aevoToken.owner()).to.equal(signer.address);
        expect(
          (await hre.ethers.provider.getBalance(previousOwner)).toBigInt(),
        ).to.equal(
          c.funded ? c.balance : c.balance - (await gasPaidBy(previousOwner)),
        );
        // What it asked of the node for the previous owner, in order.
        expect(
          send.args
            .filter(
              ([method, [address]]) =>
                method.startsWith('hardhat_') &&
                eqAddress(address, previousOwner),
            )
            .map(([method, [, balance]]) => [method, balance]),
        ).to.deep.equal([
          ['hardhat_impersonateAccount', undefined],
          ...(c.funded
            ? [
                ['hardhat_setBalance', ethers.utils.hexValue(FUNDS)],
                ['hardhat_setBalance', ethers.utils.hexValue(c.balance)],
              ]
            : []),
          ['hardhat_stopImpersonatingAccount', undefined],
        ]);
      });
    }

    it('sends no balance change for an owner that already holds enough', async () => {
      const previousOwner = randomAddress();
      await (await aevoToken.setOwner(previousOwner)).wait();
      await hre.network.provider.send('hardhat_setBalance', [
        previousOwner,
        ethers.utils.hexValue(FUNDS),
      ]);
      const provider = new ethers.providers.Web3Provider((method, params) =>
        hre.network.provider.send(method, params),
      );
      const send = sinon.spy(provider, 'send');

      await deployAevoXERC20Token({
        deployer: provider.getSigner(signer.address),
      });

      expect(
        send.args.filter(
          ([method, [address]]) =>
            method === 'hardhat_setBalance' &&
            eqAddress(address, previousOwner),
        ),
      ).to.deep.equal([]);
      expect(await aevoToken.owner()).to.equal(signer.address);
    });

    interface FailureCase {
      name: string;
      // What the previous owner holds, which decides whether it is funded for
      // the hand-over and so has a balance to restore.
      balance: bigint;
      // The requests for the previous owner that the node fails. Of the
      // balance changes, the one that fails is the restoring of the balance.
      failing: string[];
    }

    const HOLDS_TOO_LITTLE = 10n ** 15n;
    const HOLDS_ENOUGH = 10n * 10n ** 18n;

    // The hand-over, the restoring of the balance and the end of the
    // impersonation each run whichever of the others failed, and every one that
    // failed is reported.
    const failureCases: FailureCase[] = [
      {
        name: 'the balance cannot be restored',
        balance: HOLDS_TOO_LITTLE,
        failing: ['hardhat_setBalance'],
      },
      {
        name: 'the impersonation cannot be ended',
        balance: HOLDS_TOO_LITTLE,
        failing: ['hardhat_stopImpersonatingAccount'],
      },
      {
        name: 'neither the balance can be restored nor the impersonation ended',
        balance: HOLDS_TOO_LITTLE,
        failing: ['hardhat_setBalance', 'hardhat_stopImpersonatingAccount'],
      },
      {
        name: 'the hand-over fails',
        balance: HOLDS_TOO_LITTLE,
        failing: ['eth_sendTransaction'],
      },
      {
        name: 'the hand-over fails and the balance cannot be restored',
        balance: HOLDS_TOO_LITTLE,
        failing: ['eth_sendTransaction', 'hardhat_setBalance'],
      },
      {
        name: 'nothing succeeds after the impersonation starts',
        balance: HOLDS_TOO_LITTLE,
        failing: [
          'eth_sendTransaction',
          'hardhat_setBalance',
          'hardhat_stopImpersonatingAccount',
        ],
      },
      {
        name: 'the impersonation cannot be ended, for an owner that holds enough',
        balance: HOLDS_ENOUGH,
        failing: ['hardhat_stopImpersonatingAccount'],
      },
      {
        name: 'the hand-over fails, for an owner that holds enough',
        balance: HOLDS_ENOUGH,
        failing: ['eth_sendTransaction'],
      },
    ];

    for (const c of failureCases) {
      it(`ends the impersonation and restores the balance of the previous owner, as far as the node lets it, when ${c.name}`, async () => {
        const previousOwner = randomAddress();
        const balance = c.balance;
        const funded = balance < FUNDS;
        await (await aevoToken.setOwner(previousOwner)).wait();
        await hre.network.provider.send('hardhat_setBalance', [
          previousOwner,
          ethers.utils.hexValue(balance),
        ]);

        const provider = new ethers.providers.Web3Provider((method, params) =>
          hre.network.provider.send(method, params),
        );
        const send = sinon
          .stub(provider, 'send')
          .callsFake(async (method, params) => {
            const [first, value] = params;
            const address = typeof first === 'string' ? first : first?.from;
            if (
              c.failing.includes(method) &&
              eqAddress(address, previousOwner) &&
              (method !== 'hardhat_setBalance' ||
                value === ethers.utils.hexValue(balance))
            ) {
              throw new Error(`injected ${method} failure`);
            }
            return hre.network.provider.send(method, params);
          });

        let thrown: unknown;
        try {
          await deployAevoXERC20Token({
            deployer: provider.getSigner(signer.address),
          });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).to.be.instanceOf(Error);
        for (const method of c.failing) {
          expect(thrown)
            .to.have.property('message')
            .that.includes(`injected ${method} failure`);
        }
        expect(
          send.args
            .filter(
              ([method, [address]]) =>
                method.startsWith('hardhat_') &&
                eqAddress(address, previousOwner),
            )
            .map(([method]) => method),
        ).to.deep.equal([
          'hardhat_impersonateAccount',
          ...(funded ? ['hardhat_setBalance', 'hardhat_setBalance'] : []),
          'hardhat_stopImpersonatingAccount',
        ]);
        if (!(funded && c.failing.includes('hardhat_setBalance'))) {
          expect(
            (await hre.ethers.provider.getBalance(previousOwner)).toBigInt(),
          ).to.equal(
            funded ? balance : balance - (await gasPaidBy(previousOwner)),
          );
        }
      });
    }

    // The node it puts the token on is the one the deployer is connected to,
    // so that what it checks is the owner of the token it put there.
    it('rejects a deployer that is not connected to a JSON-RPC provider', async () => {
      await expect(
        deployAevoXERC20Token({ deployer: ethers.Wallet.createRandom() }),
      ).to.be.rejectedWith(
        'Expected the deployer to be connected to the JSON-RPC provider',
      );
    });
  });

  it('is identified as an Aevo token through its proxy', async () => {
    expect(
      await deriveXERC20TokenType(multiProvider, chain, AEVO_USDC_PROXY),
    ).to.equal(XERC20Type.Aevo);
  });

  it('is exported with the standard of an Aevo router', async () => {
    expect(
      await deriveEvmXERC20Standard(multiProvider, chain, AEVO_USDC_PROXY),
    ).to.equal(TokenStandard.EvmHypAevoXERC20);
  });

  // The reading of the config rests on what the token does on a mint, which
  // is shown here on the real code instead of assumed.
  describe('what the token enforces on a mint', () => {
    it('refuses a minter that is not authorized', async () => {
      const minter = await impersonate(randomAddress());

      await expect(minter.mint(randomAddress(), 1)).to.be.rejectedWith(
        NOT_AUTHORITY_SELECTOR,
      );
    });

    it('does not bound an authorized minter whose cap is zero', async () => {
      const address = randomAddress();
      const minter = await impersonate(address);
      await authorize(address);
      expect((await mintAuthority(address)).cap).to.equal('0');

      for (const amount of [1n, 10n ** 12n, 10n ** 30n]) {
        await (await minter.mint(randomAddress(), amount)).wait();
      }
    });

    it('bounds an authorized minter by its cap, counting what it has minted and not burned', async () => {
      const address = randomAddress();
      const minter = await impersonate(address);
      await authorize(address, 105);

      await (await minter.mint(randomAddress(), 100)).wait();
      await expect(minter.mint(randomAddress(), 6)).to.be.rejectedWith(
        CAP_EXCEEDED_SELECTOR,
      );
      await (await minter.mint(randomAddress(), 5)).wait();
      await expect(minter.mint(randomAddress(), 1)).to.be.rejectedWith(
        CAP_EXCEEDED_SELECTOR,
      );
    });

    it('keeps the cap of a minter whose authority is revoked, and applies it again once authorized', async () => {
      const address = randomAddress();
      const minter = await impersonate(address);
      await authorize(address, 105);

      await (await aevoToken.updateAuthority(address, false)).wait();
      expect(await mintAuthority(address)).to.deep.equal({
        authorized: false,
        cap: '105',
      });
      await expect(minter.mint(randomAddress(), 1)).to.be.rejectedWith(
        NOT_AUTHORITY_SELECTOR,
      );

      // Without a cap set, it is the one that was kept that bounds the minter.
      await (await aevoToken.updateAuthority(address, true)).wait();
      expect(await mintAuthority(address)).to.deep.equal({
        authorized: true,
        cap: '105',
      });
      await expect(minter.mint(randomAddress(), 106)).to.be.rejectedWith(
        CAP_EXCEEDED_SELECTOR,
      );
    });

    it('lowers what a minter has outstanding with a burn, which makes room under its cap', async () => {
      const address = randomAddress();
      const minter = await impersonate(address);
      const holder = randomAddress();
      await authorize(address, 105);
      await fund(holder, 1000n);

      await (await minter.mint(randomAddress(), 100)).wait();
      await (await minter.burn(holder, 60)).wait();
      await (await minter.mint(randomAddress(), 65)).wait();

      await expect(minter.mint(randomAddress(), 1)).to.be.rejectedWith(
        CAP_EXCEEDED_SELECTOR,
      );
    });

    it('refuses a burn beyond what the minter has minted and not burned, whatever its cap', async () => {
      for (const cap of [105, 0]) {
        const address = randomAddress();
        const minter = await impersonate(address);
        const holder = randomAddress();
        await authorize(address, cap);
        await fund(holder, 1000n);
        await (await minter.mint(randomAddress(), 50)).wait();

        await expect(minter.burn(holder, 51)).to.be.rejectedWith(
          BURN_BEYOND_MINTED_SELECTOR,
        );
        await (await minter.burn(holder, 50)).wait();
        await expect(minter.burn(holder, 1)).to.be.rejectedWith(
          BURN_BEYOND_MINTED_SELECTOR,
        );
      }
    });

    it('refuses a burn of a minter that is not authorized', async () => {
      const minter = await impersonate(randomAddress());
      const holder = randomAddress();
      await fund(holder, 1000n);

      await expect(minter.burn(holder, 1)).to.be.rejectedWith(
        NOT_AUTHORITY_SELECTOR,
      );
    });
  });

  describe('EvmXERC20Module', () => {
    const router = randomAddress();
    const createModule = (limits: AevoXERC20Limits, owner?: Address) => {
      const config: XERC20ModuleConfig = {
        type: XERC20Type.Aevo,
        limits: { [router]: limits },
        owner,
      };
      return {
        config,
        module: new EvmXERC20Module(multiProvider, {
          addresses: { xERC20: AEVO_USDC_PROXY, warpRoute: router },
          chain,
          config,
        }),
      };
    };

    it('reads a minter the token holds nothing for as one that is not authorized', async () => {
      const { module } = createModule(aevoRaw('5000000'));

      const config = await module.read();

      expect(config.type).to.equal(XERC20Type.Aevo);
      expect(config.limits).to.deep.equal({ [router]: aevoUnauthorized() });
      expect(config.owner).to.equal(signer.address);
    });

    interface Step {
      name: string;
      limits: AevoXERC20Limits;
      // What the token itself holds once it is applied.
      onChain: { authorized: boolean; cap: string };
      txCount: number;
    }

    // The cap the token kept for a minter whose authority is revoked is not
    // read, so authorizing the minter again sets the cap again.
    const steps: Step[] = [
      {
        name: 'authorizes a minter with a cap',
        limits: aevoRaw('5000000'),
        onChain: { authorized: true, cap: '5000000' },
        txCount: 2,
      },
      {
        name: 'changes its cap',
        limits: aevoRaw('7000000'),
        onChain: { authorized: true, cap: '7000000' },
        txCount: 1,
      },
      {
        name: 'revokes it and leaves its cap',
        limits: aevoUnauthorized(),
        onChain: { authorized: false, cap: '7000000' },
        txCount: 1,
      },
      {
        name: 'authorizes it again, setting its cap along with it',
        limits: aevoRaw('5000000'),
        onChain: { authorized: true, cap: '5000000' },
        txCount: 2,
      },
      {
        name: 'leaves it without a bound, which is a cap of zero',
        limits: aevoUnlimited(),
        onChain: { authorized: true, cap: '0' },
        txCount: 1,
      },
      {
        name: 'binds it again',
        limits: aevoRaw('3000000'),
        onChain: { authorized: true, cap: '3000000' },
        txCount: 1,
      },
      {
        name: 'revokes it from a cap',
        limits: aevoUnauthorized(),
        onChain: { authorized: false, cap: '3000000' },
        txCount: 1,
      },
      {
        name: 'authorizes it without a bound after it was revoked with a cap',
        limits: aevoUnlimited(),
        onChain: { authorized: true, cap: '0' },
        txCount: 2,
      },
    ];

    it('applies each state to the token and converges after each', async () => {
      for (const step of steps) {
        const { module, config } = createModule(step.limits);

        const txs = await module.update(config);
        expect(txs, step.name).to.have.lengthOf(step.txCount);
        await sendTxs(txs);

        expect(await mintAuthority(router), step.name).to.deep.equal(
          step.onChain,
        );
        expect((await module.read()).limits[router], step.name).to.deep.equal(
          step.limits,
        );
        expect(await module.update(config), step.name).to.have.lengthOf(0);
      }
    });

    // Applies limits to the router and returns the module that did.
    async function apply(limits: AevoXERC20Limits) {
      const { module, config } = createModule(limits);
      await sendTxs(await module.update(config));
      return { module, config };
    }

    it('leaves the owner of the token alone when none is expected', async () => {
      const { module, config } = await apply(aevoUnlimited());

      const txs = await module.update(config, { includeOwnership: true });

      expect(txs).to.have.lengthOf(0);
      expect(await aevoToken.owner()).to.equal(signer.address);
    });

    it('is refused by the token for anyone but its owner', async () => {
      await apply(aevoUnlimited());
      const { module, config } = createModule(aevoRaw('9000000'));
      const txs = await module.update(config);
      expect(txs).to.have.lengthOf(1);

      for (const tx of txs) {
        await expect(
          stranger.sendTransaction({ to: tx.to, data: tx.data }),
        ).to.be.rejectedWith(UNAUTHORIZED_SELECTOR);
      }
      expect(await mintAuthority(router)).to.deep.equal({
        authorized: true,
        cap: '0',
      });
    });

    // setOwner takes effect at once and the new owner accepts nothing.
    describe('its owner', () => {
      const setOwnerData = (owner: Address) =>
        `${AEVO_OWNER_SELECTORS.setOwner}${abiWord(owner)}`;

      it('is read as the owner of the token', async () => {
        const { module } = createModule(aevoUnlimited());

        expect(await module.reader.readOwner(AEVO_USDC_PROXY)).to.equal(
          signer.address,
        );
      });

      // The errors a node answers with are what tell a token without an
      // owner() from a failure to read it.
      it('is read as none for a token that has no owner()', async () => {
        const { module } = createModule(aevoUnlimited());
        const token = await new ERC20Test__factory(signer).deploy(
          'Token',
          'TKN',
          1000,
          18,
        );

        expect(await module.reader.readOwner(token.address)).to.equal(
          undefined,
        );
      });

      it('is handed over by setOwner, after which the module converges', async () => {
        await apply(aevoUnlimited());
        const newOwner = randomAddress();
        const { module, config } = createModule(aevoUnlimited(), newOwner);

        const txs = await module.update(config, { includeOwnership: true });

        expect(txs.map(({ to, data }) => ({ to, data }))).to.deep.equal([
          { to: AEVO_USDC_PROXY, data: setOwnerData(newOwner) },
        ]);
        await sendTxs(txs);
        expect(await aevoToken.owner()).to.equal(normalizeAddressEvm(newOwner));
        expect((await module.read()).owner).to.equal(
          normalizeAddressEvm(newOwner),
        );
        expect(
          await module.update(config, { includeOwnership: true }),
        ).to.have.lengthOf(0);
      });

      it('refuses setOwner from anyone but its owner', async () => {
        await apply(aevoUnlimited());
        const newOwner = randomAddress();
        const { module, config } = createModule(aevoUnlimited(), newOwner);
        const txs = await module.update(config, { includeOwnership: true });
        expect(txs).to.have.lengthOf(1);

        await expect(
          stranger.sendTransaction({ to: txs[0].to, data: txs[0].data }),
        ).to.be.rejectedWith(UNAUTHORIZED_SELECTOR);
        expect(await aevoToken.owner()).to.equal(signer.address);
      });

      it('leaves the previous owner unable to manage the token', async () => {
        await apply(aevoUnlimited());
        const newOwner = randomAddress();
        const { module, config } = createModule(aevoUnlimited(), newOwner);
        await sendTxs(await module.update(config, { includeOwnership: true }));
        const minter = randomAddress();

        await expect(
          aevoToken.updateAuthority(minter, true),
        ).to.be.rejectedWith(UNAUTHORIZED_SELECTOR);
        await expect(aevoToken.setCap(minter, 1)).to.be.rejectedWith(
          UNAUTHORIZED_SELECTOR,
        );

        const asNewOwner = await impersonate(newOwner);
        await (await asNewOwner.updateAuthority(minter, true)).wait();
        expect((await mintAuthority(minter)).authorized).to.equal(true);
      });

      it('is handed over after the limits, in the order the module emits them', async () => {
        await apply(aevoUnlimited());
        const newOwner = randomAddress();
        const { module, config } = createModule(aevoRaw('2000'), newOwner);

        const txs = await module.update(config, { includeOwnership: true });

        expect(
          txs.map(({ to, data }) => ({ to, data: data?.slice(0, 10) })),
        ).to.deep.equal([
          { to: AEVO_USDC_PROXY, data: AEVO_SELECTORS.setCap },
          { to: AEVO_USDC_PROXY, data: AEVO_OWNER_SELECTORS.setOwner },
        ]);
        await sendTxs(txs);
        expect(await mintAuthority(router)).to.deep.equal({
          authorized: true,
          cap: '2000',
        });
        expect(await aevoToken.owner()).to.equal(normalizeAddressEvm(newOwner));
        expect(
          await module.update(config, { includeOwnership: true }),
        ).to.have.lengthOf(0);
      });

      it('cannot be renounced, as the token reverts a transfer to the zero address', async () => {
        const { module, config } = createModule(
          aevoUnlimited(),
          ethers.constants.AddressZero,
        );

        await expect(
          module.update(config, { includeOwnership: true }),
        ).to.be.rejectedWith('whose ownership cannot be renounced');
        await expect(
          aevoToken.setOwner(ethers.constants.AddressZero),
        ).to.be.rejectedWith(TOKEN_ZERO_ADDRESS_ERROR_SELECTOR);
        expect(await aevoToken.owner()).to.equal(signer.address);
      });
    });
  });

  describe('a HypXERC20 router over it', () => {
    let module: EvmWarpModule;
    let routerAddress: Address;
    let reader: EvmWarpRouteReader;
    let defaultHook: Address;
    let defaultIsm: Address;

    // What a deploy config declares for the xERC20: the limits of the router.
    const declared = (
      warpRouteLimits: AevoXERC20Limits,
    ): XERC20TokenMetadata['xERC20'] => ({ warpRouteLimits });

    const expectedConfig = (
      xERC20?: XERC20TokenMetadata['xERC20'],
    ): HypTokenRouterConfig => ({
      type: TokenType.XERC20,
      token: AEVO_USDC_PROXY,
      mailbox: baseConfig.mailbox,
      owner: signer.address,
      hook: defaultHook,
      interchainSecurityModule: defaultIsm,
      xERC20,
    });

    const check = (warpDeployConfig: HypTokenRouterConfig) =>
      checkWarpRouteDeployConfig({
        multiProvider,
        warpCoreConfig: {
          tokens: [
            {
              addressOrDenom: routerAddress,
              chainName: chain,
              standard: TokenStandard.EvmHypAevoXERC20,
              decimals: 6,
              symbol: 'USDC',
              name: 'USDC',
            },
          ],
        },
        warpDeployConfig: { [chain]: warpDeployConfig },
      });

    const tokenTxs = (txs: AnnotatedEV5Transaction[]) =>
      txs.filter(
        (tx) => !isNullish(tx.to) && eqAddress(tx.to, AEVO_USDC_PROXY),
      );

    before(async () => {
      defaultHook = await mailbox.defaultHook();
      defaultIsm = await mailbox.defaultIsm();
      module = await EvmWarpModule.create({
        chain,
        config: expectedConfig(),
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });
      routerAddress = module.serialize().deployedTokenRoute;
      reader = new EvmWarpRouteReader(multiProvider, chain);
    });

    it('is read as an xERC20, not as collateral or fiat', async () => {
      expect(await reader.deriveTokenType(routerAddress)).to.equal(
        TokenType.XERC20,
      );
    });

    // The token authorizes the L2 bridge when it is initialized, so it holds a
    // minter other than the router. Which other contracts may mint it is not
    // modelled, so none is derived.
    it('derives what the token holds for the router alone', async () => {
      expect((await mintAuthority(AEVO_L2_BRIDGE)).authorized).to.equal(true);

      const config = await reader.deriveWarpRouteConfig(routerAddress);

      assert(config.type === TokenType.XERC20, 'Expected an xERC20 config');
      expect(config.token).to.equal(AEVO_USDC_PROXY);
      expect(config.xERC20).to.deep.equal({
        warpRouteLimits: aevoUnauthorized(),
        extraBridges: undefined,
      });
    });

    it('checks a deploy config that declares what the token holds', async () => {
      const result = await check(expectedConfig(declared(aevoUnauthorized())));

      expect(result.violations).to.deep.equal([]);
      expect(result.isValid).to.equal(true);
    });

    it('reports a deploy config that declares a minter the token does not hold', async () => {
      const result = await check(expectedConfig(declared(aevoRaw('5000000'))));

      expect(result.isValid).to.equal(false);
      expect(result.diff).to.deep.equal({
        [chain]: {
          type: TokenType.XERC20,
          xERC20: {
            warpRouteLimits: {
              type: XERC20Type.Aevo,
              authorized: { actual: false, expected: true },
              cap: {
                actual: '',
                expected: { type: XERC20AevoCapType.Raw, value: '5000000' },
              },
            },
          },
        },
      });
    });

    it('applies the declared authority and cap, then checks clean', async () => {
      const config = expectedConfig(declared(aevoRaw('5000000')));

      const txs = await module.update(config);
      expect(tokenTxs(txs)).to.have.lengthOf(2);
      await sendTxs(txs);

      expect(await mintAuthority(routerAddress)).to.deep.equal({
        authorized: true,
        cap: '5000000',
      });
      expect((await check(config)).violations).to.deep.equal([]);
      expect(tokenTxs(await module.update(config))).to.have.lengthOf(0);
    });

    // Through the schema, as a registry file is read: the nested cap has to
    // survive the read, the normalization and the diff.
    it('applies an unbounded cap, then checks clean', async () => {
      const config = HypTokenRouterConfigSchema.parse(
        expectedConfig(declared(aevoUnlimited())),
      );

      await sendTxs(await module.update(config));

      expect(await mintAuthority(routerAddress)).to.deep.equal({
        authorized: true,
        cap: '0',
      });
      expect((await check(config)).violations).to.deep.equal([]);
      expect(tokenTxs(await module.update(config))).to.have.lengthOf(0);
    });

    // Which other contracts may mint the token is not modelled: the L2 bridge
    // it authorizes when it is initialized and the minters authorized beside
    // the router are neither derived, checked nor applied.
    it('reports no drift for the other minters of the token, and never applies to them', async () => {
      const bounded = randomAddress();
      await authorize(bounded, 777);
      const unbound = randomAddress();
      await authorize(unbound);
      const otherMinters = [AEVO_L2_BRIDGE, bounded, unbound];
      const held = await Promise.all(otherMinters.map(mintAuthority));
      expect(held).to.deep.equal([
        { authorized: true, cap: '0' },
        { authorized: true, cap: '777' },
        { authorized: true, cap: '0' },
      ]);
      await (await aevoToken.updateAuthority(routerAddress, false)).wait();

      interface Step {
        name: string;
        limits: AevoXERC20Limits;
        calls: string[];
        onChain: { authorized: boolean; cap: string };
      }

      const steps: Step[] = [
        {
          name: 'authorizes the router with a cap',
          limits: aevoRaw('5000000'),
          calls: ['setCap', 'updateAuthority'],
          onChain: { authorized: true, cap: '5000000' },
        },
        {
          name: 'changes the cap of the router',
          limits: aevoRaw('6000000'),
          calls: ['setCap'],
          onChain: { authorized: true, cap: '6000000' },
        },
        {
          name: 'revokes the router',
          limits: aevoUnauthorized(),
          calls: ['updateAuthority'],
          onChain: { authorized: false, cap: '6000000' },
        },
      ];

      for (const step of steps) {
        const config = HypTokenRouterConfigSchema.parse(
          expectedConfig(declared(step.limits)),
        );
        expect((await check(config)).isValid, step.name).to.equal(false);

        const txs = tokenTxs(await module.update(config));
        expect(
          txs.map((tx) => {
            assert(tx.data, `Expected data of a transaction: ${step.name}`);
            const call = aevoToken.interface.parseTransaction({
              data: tx.data,
            });
            return [call.name, call.args[0]];
          }),
          step.name,
        ).to.deep.equal(
          step.calls.map((name) => [name, normalizeAddressEvm(routerAddress)]),
        );
        await sendTxs(txs);

        expect(await mintAuthority(routerAddress), step.name).to.deep.equal(
          step.onChain,
        );
        expect(
          await Promise.all(otherMinters.map(mintAuthority)),
          step.name,
        ).to.deep.equal(held);
        const result = await check(config);
        expect(result.violations, step.name).to.deep.equal([]);
        expect(result.isValid, step.name).to.equal(true);
        expect(
          tokenTxs(await module.update(config)),
          step.name,
        ).to.have.lengthOf(0);
      }
    });

    it('reports a deploy config that declares no limits for a minter the token holds', async () => {
      await sendTxs(
        await module.update(expectedConfig(declared(aevoRaw('5000000')))),
      );

      const result = await check(expectedConfig());

      expect(result.isValid).to.equal(false);
      expect(result.diff).to.deep.equal({
        [chain]: {
          type: TokenType.XERC20,
          xERC20: {
            actual: {
              warpRouteLimits: {
                type: XERC20Type.Aevo,
                authorized: true,
                cap: { type: XERC20AevoCapType.Raw, value: '5000000' },
              },
            },
            expected: '',
          },
        },
      });
    });

    // The owner of a deploy config is the owner of the router: the warp apply
    // path leaves the owner of its token to the xerc20 command.
    it('leaves the owner of the token alone when the owner of the deploy config differs from it', async () => {
      await sendTxs(
        await module.update(expectedConfig(declared(aevoRaw('5000000')))),
      );
      const config = expectedConfig(declared(aevoUnlimited()));
      config.owner = randomAddress();

      const txs = tokenTxs(await module.update(config));

      // The one tx for the token is the cap, which differs: not an owner tx.
      expect(txs.map((tx) => tx.data)).to.deep.equal([
        `${AEVO_SELECTORS.setCap}${abiWord(routerAddress)}${abiWord(0)}`,
      ]);
      await sendTxs(txs);
      expect(await mintAuthority(routerAddress)).to.deep.equal({
        authorized: true,
        cap: '0',
      });
      expect(await aevoToken.owner()).to.equal(signer.address);
    });

    it('leaves the token alone when the deploy config declares no limits', async () => {
      await sendTxs(
        await module.update(expectedConfig(declared(aevoRaw('5000000')))),
      );
      const held = await mintAuthority(routerAddress);
      expect(held).to.deep.equal({ authorized: true, cap: '5000000' });

      const txs = await module.update(expectedConfig());

      expect(tokenTxs(txs)).to.have.lengthOf(0);
      expect(await mintAuthority(routerAddress)).to.deep.equal(held);
    });

    // These come last: each one sets the state of the router it reads.
    describe('its adapter', () => {
      let adapter: EvmHypAevoXERC20Adapter;
      const holder = randomAddress();

      before(() => {
        adapter = new EvmHypAevoXERC20Adapter(
          chain,
          MultiProtocolProvider.fromMultiProvider(multiProvider),
          { token: routerAddress },
        );
      });

      const outstandingOf = async (minter: Address) =>
        (
          await aevoToken.provider.call({
            to: AEVO_USDC_PROXY,
            data: `${AEVO_OUTSTANDING_SELECTOR}${abiWord(minter)}`,
          })
        ).toString();

      // Brings the router to the state: authorized or not, with a cap (zero for
      // none), and having minted and not burned `outstanding`.
      async function arrange({
        authorized,
        cap,
        outstanding,
      }: {
        authorized: boolean;
        cap: bigint;
        outstanding: bigint;
      }) {
        const router = await impersonate(routerAddress);
        await (await aevoToken.updateAuthority(routerAddress, true)).wait();
        await (await aevoToken.setCap(routerAddress, 0)).wait();
        const current = await adapter.getBridgedSupply();
        if (outstanding > current) {
          await (
            await router.mint(randomAddress(), outstanding - current)
          ).wait();
        } else if (outstanding < current) {
          await fund(holder, current - outstanding);
          await (await router.burn(holder, current - outstanding)).wait();
        }
        await (await aevoToken.setCap(routerAddress, cap)).wait();
        await (
          await aevoToken.updateAuthority(routerAddress, authorized)
        ).wait();
      }

      const limitsOf = async () => ({
        mint: await adapter.getMintLimit(),
        mintMax: await adapter.getMintMaxLimit(),
        burn: await adapter.getBurnLimit(),
        burnMax: await adapter.getBurnMaxLimit(),
      });

      interface LimitsCase {
        name: string;
        state: { authorized: boolean; cap: bigint; outstanding: bigint };
        expected: {
          mint: bigint;
          mintMax: bigint;
          burn: bigint;
          burnMax: bigint;
        };
      }

      const cases: LimitsCase[] = [
        {
          name: 'has none for a router that is not authorized, whatever it keeps',
          state: { authorized: false, cap: 105n, outstanding: 30n },
          expected: { mint: 0n, mintMax: 0n, burn: 0n, burnMax: 0n },
        },
        {
          name: 'has no cap to mint under, and nothing to burn, for a router without a cap that has minted nothing',
          state: { authorized: true, cap: 0n, outstanding: 0n },
          expected: {
            mint: UIN256_MAX_VALUE,
            mintMax: UIN256_MAX_VALUE,
            burn: 0n,
            burnMax: UIN256_MAX_VALUE,
          },
        },
        {
          name: 'can burn what a router without a cap has minted',
          state: { authorized: true, cap: 0n, outstanding: 30n },
          expected: {
            mint: UIN256_MAX_VALUE,
            mintMax: UIN256_MAX_VALUE,
            burn: 30n,
            burnMax: UIN256_MAX_VALUE,
          },
        },
        {
          name: 'can mint the whole cap of a router that has minted nothing',
          state: { authorized: true, cap: 105n, outstanding: 0n },
          expected: { mint: 105n, mintMax: 105n, burn: 0n, burnMax: 105n },
        },
        {
          name: 'can mint what is left of the cap, and burn what the router has minted',
          state: { authorized: true, cap: 105n, outstanding: 30n },
          expected: { mint: 75n, mintMax: 105n, burn: 30n, burnMax: 105n },
        },
        {
          name: 'can mint the one unit left under the cap',
          state: { authorized: true, cap: 31n, outstanding: 30n },
          expected: { mint: 1n, mintMax: 31n, burn: 30n, burnMax: 31n },
        },
        {
          name: 'can mint nothing once the router has minted the cap',
          state: { authorized: true, cap: 105n, outstanding: 105n },
          expected: { mint: 0n, mintMax: 105n, burn: 105n, burnMax: 105n },
        },
        {
          name: 'can mint nothing when the cap is lowered below what the router has minted',
          state: { authorized: true, cap: 20n, outstanding: 30n },
          expected: { mint: 0n, mintMax: 20n, burn: 30n, burnMax: 20n },
        },
        {
          name: 'has the largest uint256 for the cap, and what is left of it, of a router with the largest cap',
          state: {
            authorized: true,
            cap: UIN256_MAX_VALUE,
            outstanding: 30n,
          },
          expected: {
            mint: UIN256_MAX_VALUE - 30n,
            mintMax: UIN256_MAX_VALUE,
            burn: 30n,
            burnMax: UIN256_MAX_VALUE,
          },
        },
      ];

      for (const c of cases) {
        it(c.name, async () => {
          await arrange(c.state);

          expect(await limitsOf()).to.deep.equal(c.expected);
        });
      }

      interface AuthorityCase {
        name: string;
        authorized: boolean;
        // What the token keeps for the router.
        cap: number;
        expected: AevoXERC20Limits;
      }

      const authorityCases: AuthorityCase[] = [
        {
          name: 'reads a router that is not authorized without the cap the token keeps for it',
          authorized: false,
          cap: 105,
          expected: aevoUnauthorized(),
        },
        {
          name: 'reads an authorized router with a cap',
          authorized: true,
          cap: 5000000,
          expected: aevoRaw('5000000'),
        },
        {
          name: 'reads an authorized router whose cap is zero as one without a cap',
          authorized: true,
          cap: 0,
          expected: aevoUnlimited(),
        },
      ];

      for (const c of authorityCases) {
        it(c.name, async () => {
          await (await aevoToken.setCap(routerAddress, c.cap)).wait();
          await (
            await aevoToken.updateAuthority(routerAddress, c.authorized)
          ).wait();

          expect(await adapter.getAevoLimits()).to.deep.equal(c.expected);
        });
      }

      // What the token enforces is what the limits state: what the router may
      // mint and burn is accepted and one more is refused.
      it('states what the token accepts of a mint and of a burn', async () => {
        await arrange({ authorized: true, cap: 105n, outstanding: 30n });
        const router = await impersonate(routerAddress);
        await fund(holder, 1000n);

        const mint = await adapter.getMintLimit();
        await (await router.mint(randomAddress(), mint)).wait();
        await expect(router.mint(randomAddress(), 1)).to.be.rejectedWith(
          CAP_EXCEEDED_SELECTOR,
        );

        const burn = await adapter.getBurnLimit();
        expect(burn).to.equal(105n);
        await (await router.burn(holder, burn)).wait();
        await expect(router.burn(holder, 1)).to.be.rejectedWith(
          BURN_BEYOND_MINTED_SELECTOR,
        );
        expect(await limitsOf()).to.deep.equal({
          mint: 105n,
          mintMax: 105n,
          burn: 0n,
          burnMax: 105n,
        });
      });

      it('accepts a mint of the one unit left under the cap, and refuses the next', async () => {
        await arrange({ authorized: true, cap: 31n, outstanding: 30n });
        const router = await impersonate(routerAddress);
        expect(await adapter.getMintLimit()).to.equal(1n);

        await (await router.mint(randomAddress(), 1)).wait();

        await expect(router.mint(randomAddress(), 1)).to.be.rejectedWith(
          CAP_EXCEEDED_SELECTOR,
        );
        expect(await adapter.getMintLimit()).to.equal(0n);
      });

      it('makes room to mint again when the router burns', async () => {
        await arrange({ authorized: true, cap: 105n, outstanding: 100n });
        const router = await impersonate(routerAddress);
        await fund(holder, 1000n);
        expect(await adapter.getMintLimit()).to.equal(5n);

        await (await router.burn(holder, 60)).wait();

        expect(await adapter.getMintLimit()).to.equal(65n);
        await (await router.mint(randomAddress(), 65)).wait();
      });

      // The supply of the token is what every minter has minted: when the token
      // had been minted by another one before the router, which has nothing yet,
      // none of it is the router's to burn or to have bridged.
      it('states nothing of what another minter has minted', async () => {
        await arrange({ authorized: true, cap: 105n, outstanding: 0n });
        const other = randomAddress();
        await authorize(other);
        await (
          await (await impersonate(other)).mint(randomAddress(), 1000)
        ).wait();

        expect((await aevoToken.totalSupply()).toBigInt() > 1000n).to.equal(
          true,
        );
        expect(await adapter.getBurnLimit()).to.equal(0n);
        expect(await adapter.getBridgedSupply()).to.equal(0n);
      });

      it('reports what the router has bridged as what it has minted and not burned, at the block asked for', async () => {
        await arrange({ authorized: true, cap: 0n, outstanding: 20n });
        const router = await impersonate(routerAddress);
        const blockBefore = await hre.ethers.provider.getBlockNumber();

        await (await router.mint(randomAddress(), 700)).wait();

        expect(await adapter.getBridgedSupply()).to.equal(720n);
        expect(
          await adapter.getBridgedSupply({ blockTag: blockBefore }),
        ).to.equal(20n);
        // What the token keeps at its slot for the counts, which its getter
        // answers.
        expect(
          BigInt(
            await hre.ethers.provider.getStorageAt(
              AEVO_USDC_PROXY,
              ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                  ['address', 'uint256'],
                  [routerAddress, OUTSTANDING_SLOT],
                ),
              ),
            ),
          ),
        ).to.equal(720n);
        expect(BigInt(await outstandingOf(routerAddress))).to.equal(720n);
      });
    });
  });
});
