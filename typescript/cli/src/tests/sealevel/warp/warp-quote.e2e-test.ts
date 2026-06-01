import { expect } from 'chai';
import { Wallet } from 'ethers';

import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import { DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY } from '@hyperlane-xyz/provider-sdk/warp';
import { SealevelSigner, createRpc } from '@hyperlane-xyz/sealevel-sdk';
import { airdropSol, createSplMint } from '@hyperlane-xyz/sealevel-sdk/testing';
import {
  TokenFeeType,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_ADDRESSES_PATH_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
} from '../../constants.js';

const CHAIN_NAME = 'svmlocal1';
const REMOTE_CHAIN_NAME = 'anvil1';
const SVM_KEY = HYP_KEY_BY_PROTOCOL.sealevel;
const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/svm-quote-deploy.yaml`;
const QUOTE_READ_OUTPUT_PATH = `${TEMP_PATH}/svm-quote-read.yaml`;

const SVM_WARP_QUOTE_TIMEOUT = 600_000;
const MAX_FEE = '1000000000';
const HALF_AMOUNT = '500000000';

// Result-shape sentinel labels emitted by `runWarpQuoteRead`.
const WILDCARD_RECIPIENT = 'WILDCARD_RECIPIENT';
const TARGET_ROUTER_NONE = 'TARGET_ROUTER_NONE';
const DEFAULT_CROSS_COLLATERAL_ROUTER = 'DEFAULT_CROSS_COLLATERAL_ROUTER';

// Bytes32 stub for an EVM-side warp router on anvil1 — left-padded EVM address.
const REMOTE_ROUTER_BYTES32 =
  '0x0000000000000000000000001111111111111111111111111111111111111111';

interface QuoteEntry {
  amount: string;
  maxFee: string;
  halfAmount: string;
  issuedAt: string;
  expiry: string;
  expired: boolean;
}

type ReadResult = Record<
  string,
  Record<string, Record<string, Record<string, QuoteEntry>>>
>;

describe('hyperlane warp quote CLI e2e tests (Sealevel)', function () {
  this.timeout(SVM_WARP_QUOTE_TIMEOUT);

  let rpc: ReturnType<typeof createRpc>;
  let signer: Awaited<ReturnType<typeof SealevelSigner.connectWithSigner>>;
  let mailboxAddress: string;
  let quoteSignerWallet: Wallet;

  const warpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Sealevel,
    REGISTRY_PATH,
    `${TEMP_PATH}/svm-quote-warp-read.yaml`,
  );

  before(async function () {
    const rpcUrl = TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1.rpcUrl;
    rpc = createRpc(rpcUrl);
    signer = await SealevelSigner.connectWithSigner([rpcUrl], SVM_KEY);

    await airdropSol(rpc, signer.getSignerAddress(), 50_000_000_000n);

    const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
      ProtocolType.Sealevel,
      CHAIN_NAME,
      REGISTRY_PATH,
      CORE_CONFIG_PATH_BY_PROTOCOL.sealevel,
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );
    const coreConfig = readYamlOrJson(CORE_CONFIG_PATH_BY_PROTOCOL.sealevel);
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      coreConfig,
    );
    hyperlaneCore.setCoreInputPath(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );
    await hyperlaneCore.deploy(SVM_KEY);

    const coreAddresses: ChainAddresses = readYamlOrJson(
      CORE_ADDRESSES_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );
    mailboxAddress = coreAddresses.mailbox;

    quoteSignerWallet = Wallet.createRandom();
  });

  async function deployWarp(
    symbol: string,
    config: WarpRouteDeployConfig,
  ): Promise<string> {
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, config);
    const warpRouteId = createWarpRouteConfigId(symbol, CHAIN_NAME);
    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);
    return warpRouteId;
  }

  async function createStandingQuote(warpRouteId: string): Promise<void> {
    await warpCommands.quoteCreate({
      privateKey: SVM_KEY,
      warpRouteId,
      chain: CHAIN_NAME,
      destination: REMOTE_CHAIN_NAME,
      recipient: 'wildcard',
      amount: 'wildcard',
      maxFee: MAX_FEE,
      halfAmount: HALF_AMOUNT,
      ttl: 3600,
      quoteSignerKey: quoteSignerWallet.privateKey,
    });
  }

  async function readStandingQuotes(warpRouteId: string): Promise<ReadResult> {
    await warpCommands.quoteRead({ warpRouteId, out: QUOTE_READ_OUTPUT_PATH });
    return readYamlOrJson(QUOTE_READ_OUTPUT_PATH);
  }

  function offchainQuotedLeaf() {
    return {
      type: TokenFeeType.OffchainQuotedLinearFee,
      owner: signer.getSignerAddress(),
      bps: 50,
      quoteSigners: [quoteSignerWallet.address],
    };
  }

  describe('OffchainQuotedLinearFee (plain leaf)', () => {
    it('standing quote create then read roundtrips', async () => {
      const ownerAddress = signer.getSignerAddress();
      const SYMBOL = 'SVMOQ';
      const warpRouteId = await deployWarp(SYMBOL, {
        [CHAIN_NAME]: {
          type: TokenType.native,
          name: 'SVM Quote Token',
          symbol: SYMBOL,
          decimals: 9,
          mailbox: mailboxAddress,
          owner: ownerAddress,
          remoteRouters: {
            [REMOTE_CHAIN_NAME]: { address: REMOTE_ROUTER_BYTES32 },
          },
          tokenFee: offchainQuotedLeaf(),
        },
      });

      await createStandingQuote(warpRouteId);
      const result = await readStandingQuotes(warpRouteId);

      const entry =
        result[CHAIN_NAME]?.[REMOTE_CHAIN_NAME]?.[TARGET_ROUTER_NONE]?.[
          WILDCARD_RECIPIENT
        ];
      assert(
        entry,
        `expected an entry under ${REMOTE_CHAIN_NAME} / NONE / wildcard`,
      );
      expect(entry.amount).to.equal('wildcard');
      expect(entry.maxFee).to.equal(MAX_FEE);
      expect(entry.halfAmount).to.equal(HALF_AMOUNT);
      expect(Date.parse(entry.expiry)).to.be.greaterThan(
        Date.parse(entry.issuedAt),
      );
      expect(entry.expired).to.equal(false);
    });

    it('transient quote (ttl=0) does not appear in standing quote read', async () => {
      const ownerAddress = signer.getSignerAddress();
      const SYMBOL = 'SVMTRT';
      const warpRouteId = await deployWarp(SYMBOL, {
        [CHAIN_NAME]: {
          type: TokenType.native,
          name: 'SVM Transient Token',
          symbol: SYMBOL,
          decimals: 9,
          mailbox: mailboxAddress,
          owner: ownerAddress,
          remoteRouters: {
            [REMOTE_CHAIN_NAME]: { address: REMOTE_ROUTER_BYTES32 },
          },
          tokenFee: offchainQuotedLeaf(),
        },
      });

      await warpCommands.quoteCreate({
        privateKey: SVM_KEY,
        warpRouteId,
        chain: CHAIN_NAME,
        destination: REMOTE_CHAIN_NAME,
        recipient: 'wildcard',
        amount: 'wildcard',
        maxFee: MAX_FEE,
        halfAmount: HALF_AMOUNT,
        ttl: 0,
        quoteSignerKey: quoteSignerWallet.privateKey,
      });

      const result = await readStandingQuotes(warpRouteId);
      expect(result[CHAIN_NAME] ?? {}).to.deep.equal({});
    });
  });

  describe('RoutingFee with OffchainQuotedLinearFee leaf', () => {
    it('standing quote create then read roundtrips with target=NONE', async () => {
      const ownerAddress = signer.getSignerAddress();
      const SYMBOL = 'SVMRTQ';
      const warpRouteId = await deployWarp(SYMBOL, {
        [CHAIN_NAME]: {
          type: TokenType.native,
          name: 'SVM Routing Quote Token',
          symbol: SYMBOL,
          decimals: 9,
          mailbox: mailboxAddress,
          owner: ownerAddress,
          remoteRouters: {
            [REMOTE_CHAIN_NAME]: { address: REMOTE_ROUTER_BYTES32 },
          },
          tokenFee: {
            type: TokenFeeType.RoutingFee,
            owner: ownerAddress,
            feeContracts: {
              [REMOTE_CHAIN_NAME]: offchainQuotedLeaf(),
            },
          },
        },
      });

      await createStandingQuote(warpRouteId);
      const result = await readStandingQuotes(warpRouteId);

      const entry =
        result[CHAIN_NAME]?.[REMOTE_CHAIN_NAME]?.[TARGET_ROUTER_NONE]?.[
          WILDCARD_RECIPIENT
        ];
      assert(
        entry,
        `expected an entry under ${REMOTE_CHAIN_NAME} / NONE / wildcard`,
      );
      expect(entry.maxFee).to.equal(MAX_FEE);
    });
  });

  describe('CrossCollateralRoutingFee with OffchainQuotedLinearFee leaf', () => {
    it('standing quote create routes to default OQLF leaf and read returns the entry', async () => {
      const ownerAddress = signer.getSignerAddress();
      const mint = await createSplMint(rpc, signer, 9);
      const SYMBOL = 'SVMCCQ';
      const warpRouteId = await deployWarp(SYMBOL, {
        [CHAIN_NAME]: {
          type: TokenType.crossCollateral,
          token: String(mint),
          name: 'SVM CC Quote Token',
          symbol: SYMBOL,
          decimals: 9,
          mailbox: mailboxAddress,
          owner: ownerAddress,
          remoteRouters: {
            [REMOTE_CHAIN_NAME]: { address: REMOTE_ROUTER_BYTES32 },
          },
          tokenFee: {
            type: TokenFeeType.CrossCollateralRoutingFee,
            owner: ownerAddress,
            feeContracts: {
              [REMOTE_CHAIN_NAME]: {
                [DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY]: offchainQuotedLeaf(),
              },
            },
          },
        },
      });

      await createStandingQuote(warpRouteId);
      const result = await readStandingQuotes(warpRouteId);

      const entry =
        result[CHAIN_NAME]?.[REMOTE_CHAIN_NAME]?.[
          DEFAULT_CROSS_COLLATERAL_ROUTER
        ]?.[WILDCARD_RECIPIENT];
      assert(
        entry,
        `expected an entry under ${REMOTE_CHAIN_NAME} / DEFAULT_ROUTER / wildcard`,
      );
      expect(entry.maxFee).to.equal(MAX_FEE);
      expect(entry.halfAmount).to.equal(HALF_AMOUNT);
    });
  });
});
