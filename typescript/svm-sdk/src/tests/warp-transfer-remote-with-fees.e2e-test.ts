import { secp256k1 } from '@noble/curves/secp256k1';
import {
  type AccountMeta,
  address,
  type Address,
  assertIsSignature,
  generateKeyPairSigner,
  getAddressDecoder,
  type Instruction,
} from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  ArtifactComposition,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { assert, pollAsync, toHexString } from '@hyperlane-xyz/utils';
import {
  FeeParamsType,
  FeeStrategyType,
  FeeType,
} from '@hyperlane-xyz/provider-sdk/fee';
import type { IgpHookConfig } from '@hyperlane-xyz/provider-sdk/hook';
import {
  type CrossCollateralWarpArtifactConfig,
  type DeployedWarpAddress,
  type NativeWarpArtifactConfig,
  TokenType,
} from '@hyperlane-xyz/provider-sdk/warp';

import { createWarpAltManager } from '../alt/warp-alt-manager.js';
import { SvmSigner } from '../clients/signer.js';
import {
  SPL_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import { SvmCrossCollateralRoutingFeeWriter } from '../fee/cross-collateral-routing-fee.js';
import { SvmRoutingFeeWriter } from '../fee/routing-fee.js';
import { DEFAULT_FEE_SALT, FeeStrategyKind } from '../fee/types.js';
import { DEFAULT_IGP_SALT, SvmIgpHookWriter } from '../hook/igp-hook.js';
import { SvmMailboxWriter } from '../core/mailbox.js';
import { SvmTestIsmWriter } from '../ism/test-ism.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import {
  getSubmitQuoteInstruction,
  simulateFeeQuoteAccountMetas,
  simulateSubmitQuoteAccountMetas,
} from '../instructions/fee.js';
import {
  getSubmitIgpQuoteInstruction,
  simulateIgpQuoteAccountMetas,
} from '../instructions/igp.js';
import { getCrossCollateralTransferRemoteToInstruction } from '../instructions/cross-collateral-token.js';
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getMintToInstruction,
} from '../instructions/spl-token.js';
import {
  getTokenEnrollRemoteRoutersInstruction,
  getTokenSetDestinationGasConfigsInstruction,
  getTokenTransferRemoteInstruction,
} from '../instructions/token.js';
import {
  DEFAULT_ROUTER,
  encodeSvmFeeQuoteContext,
  encodeFeeDataStrategy,
  type SvmSignedQuote,
} from '../codecs/fee.js';
import {
  encodeSvmIgpQuoteContext,
  encodeSvmIgpQuoteData,
} from '../codecs/igp.js';
import { readonlyAccount, writableAccount } from '../instructions/utils.js';
import {
  deriveAssociatedTokenAddress,
  deriveEscrowPda,
  deriveFeeAccountPda,
  deriveFeeTransientQuotePda,
  deriveIgpAccountPda,
  deriveIgpGasPaymentPda,
  deriveIgpProgramDataPda,
  deriveIgpTransientQuotePda,
  deriveMailboxDispatchAuthorityPda,
  deriveMailboxDispatchedMessagePda,
  deriveNativeCollateralPda,
  deriveOverheadIgpAccountPda,
} from '../pda.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import {
  computeScopedSalt,
  ethAddressHexFromPrivateKey,
  signSvmQuote,
} from '../quote-signing.js';
import {
  TEST_ATA_PAYER_FUNDING_AMOUNT,
  TEST_PROGRAM_IDS,
  airdropSol,
  createSplMint,
} from '../testing/setup.js';
import { SvmCrossCollateralTokenWriter } from '../warp/cross-collateral-token.js';
import { SvmNativeTokenWriter } from '../warp/native-token.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const DOMAIN_LOCAL = 1;
const DOMAIN_REMOTE = 99;
const REMOTE_ROUTER = new Uint8Array(32).fill(0xab);
const RECIPIENT = new Uint8Array(32).fill(0xcd);
const REMOTE_GAS = 50_000n;
const TRANSFER_AMOUNT = 100_000n;
const ZERO_TARGET_ROUTER = new Uint8Array(32);

const linearFeeData = (maxFee: bigint, halfAmount: bigint) =>
  Uint8Array.from(
    encodeFeeDataStrategy({
      kind: FeeStrategyKind.Linear,
      params: { maxFee, halfAmount },
    }),
  );

// On-chain `fee_token_mint` for SOL-native warp is `Pubkey::default()`.
const SOL_FEE_TOKEN_MINT = getAddressDecoder().decode(new Uint8Array(32));

const rawParams = (maxFee: string, halfAmount: string) =>
  ({ type: FeeParamsType.raw, maxFee, halfAmount }) as const;

// Quote-vs-oracle distinguisher: setting the IGP quote's gas_price 10x the
// on-chain oracle's gas_price makes the post-tx IGP-balance delta 10x what
// the legacy oracle path would charge. Lets every test prove the Quoted
// flow ran by checking the exact balance delta.
const QUOTE_GAS_PRICE = 10n;
const QUOTE_TOKEN_EXCHANGE_RATE = 1_000_000_000_000_000_000n; // 1e18
const QUOTE_TOKEN_DECIMALS = 9;
const TOKEN_EXCHANGE_RATE_SCALE = 10_000_000_000_000_000_000n; // 1e19
const IGP_OVERHEAD_GAS = 50_000n; // configured per-domain overhead

// Quote-vs-config distinguisher for the fee program: the route config is
// pinned at (5000, 2500) so the legacy-config path would charge 5000 on a
// 100k transfer. The signed fee quotes pin (1000, 500) instead, so the
// post-tx beneficiary delta is 1000 iff the offchain-quoted path drove
// pricing — same flavor as the 10x IGP gas-price differential above.
const ROUTE_MAX_FEE_PARAM = '5000';
const ROUTE_HALF_AMOUNT_PARAM = '2500';
const QUOTE_MAX_FEE = 1000n;
const QUOTE_HALF_AMOUNT = 500n;
// fee = min(QUOTE_MAX_FEE, TRANSFER_AMOUNT * QUOTE_MAX_FEE / (2 * QUOTE_HALF_AMOUNT))
//     = min(1000, 100000 * 1000 / 1000) = 1000
const EXPECTED_QUOTE_DRIVEN_FEE = 1000n;

interface IgpQuoteSetup {
  signedQuote: SvmSignedQuote;
  transientQuotePda: Address;
  cascadeQuotePdas: AccountMeta[];
  scopedSalt: Uint8Array;
}

/**
 * Signs an IGP transient quote (10x oracle gas_price), derives its PDA,
 * and simulates the IGP cascade to pluck out the writable transient-quote
 * meta that goes into `igp.quoted.cascadeQuotePdas` for transfer_remote.
 */
async function setupIgpTransientQuote(args: {
  rpc: ReturnType<typeof createRpc>;
  igpAccount: Address;
  igpProgramId: Address;
  quoteSignerPrivateKey: Uint8Array;
  senderWallet: Address;
  warpProgramId: Address;
  destinationDomain: number;
  localDomain: number;
}): Promise<IgpQuoteSetup> {
  const clientSalt = secp256k1.utils.randomSecretKey();
  const scopedSalt = computeScopedSalt(args.senderWallet, clientSalt);
  const transientQuotePda = (
    await deriveIgpTransientQuotePda(
      args.igpProgramId,
      args.igpAccount,
      scopedSalt,
    )
  ).address;

  const issuedAt = BigInt(Math.floor(Date.now() / 1000)) + 60n;
  const signedQuote = signSvmQuote({
    privateKey: args.quoteSignerPrivateKey,
    feeAccount: args.igpAccount,
    domainId: args.localDomain,
    payer: args.senderWallet,
    context: Uint8Array.from(
      encodeSvmIgpQuoteContext({
        feeTokenMint: SOL_FEE_TOKEN_MINT,
        destinationDomain: args.destinationDomain,
        sender: args.warpProgramId,
      }),
    ),
    data: Uint8Array.from(
      encodeSvmIgpQuoteData({
        tokenExchangeRate: QUOTE_TOKEN_EXCHANGE_RATE,
        gasPrice: QUOTE_GAS_PRICE,
        tokenDecimals: QUOTE_TOKEN_DECIMALS,
      }),
    ),
    issuedAt,
    expiry: issuedAt, // transient
    clientSalt,
  });

  // Sim returns [system, payer_placeholder, program_data, unique_gas_payment,
  // gas_payment_pda, configured_igp, sender_authority, quoted_sender, cascade...].
  // D1 already knows / derives slots [0..7]; the only thing we need is the
  // cascade tail at [8..].
  const igpMetas = await simulateIgpQuoteAccountMetas({
    rpc: args.rpc,
    programId: args.igpProgramId,
    igpAccount: args.igpAccount,
    payer: args.senderWallet,
    input: {
      destinationDomain: args.destinationDomain,
      sender: args.warpProgramId,
      scopedSalt,
    },
  });
  const cascadeQuotePdas = igpMetas.slice(8);

  return { signedQuote, transientQuotePda, cascadeQuotePdas, scopedSalt };
}

interface FeeQuoteSetup {
  feeTransientQuotePda: Address;
  submitInstruction: Instruction;
  passThroughAccounts: AccountMeta[];
  scopedSalt: Uint8Array;
}

/**
 * Signs a fee transient quote, derives its PDA, builds the SubmitQuote
 * instruction (with the payer placeholder replaced), and simulates the fee
 * cascade to pluck the pass-through accounts the transfer_remote fee
 * section consumes.
 *
 * Context bytes are caller-supplied so the same helper works for Leaf /
 * Routing (44-byte FeeQuoteContext) and CrossCollateralRouting (76-byte
 * CcFeeQuoteContext).
 */
async function setupFeeTransientQuote(args: {
  rpc: ReturnType<typeof createRpc>;
  signer: SvmSigner;
  senderWallet: Address;
  feeProgramId: Address;
  feeAccountPda: Address;
  feeQuoteSignerPrivateKey: Uint8Array;
  context: Uint8Array;
  data: Uint8Array;
  destinationDomain: number;
  /**
   * `target_router` baked into the signed quote, used at submit time for
   * the route-PDA signer lookup at `(fee_account, dest, signedTargetRouter)`.
   */
  signedTargetRouter: Uint8Array;
  /**
   * `target_router` the runtime `QuoteFee` CPI passes — drives the
   * consume-time `resolve_cc_routing` cascade `[(dest, runtimeTargetRouter),
   * (dest, DEFAULT_ROUTER)]`. Equals `signedTargetRouter` for the
   * specific-scope path; differs (runtime = real remote router, signed =
   * DEFAULT_ROUTER) for the cascade-fallback path.
   */
  runtimeTargetRouter: Uint8Array;
  localDomain: number;
}): Promise<FeeQuoteSetup> {
  const clientSalt = secp256k1.utils.randomSecretKey();
  const scopedSalt = computeScopedSalt(args.senderWallet, clientSalt);
  const feeTransientQuotePda = (
    await deriveFeeTransientQuotePda(
      args.feeProgramId,
      args.feeAccountPda,
      scopedSalt,
    )
  ).address;

  const issuedAt = BigInt(Math.floor(Date.now() / 1000)) + 60n;
  const signedQuote = signSvmQuote({
    privateKey: args.feeQuoteSignerPrivateKey,
    feeAccount: args.feeAccountPda,
    domainId: args.localDomain,
    payer: args.senderWallet,
    context: args.context,
    data: args.data,
    issuedAt,
    expiry: issuedAt,
    clientSalt,
  });

  const submitAccounts = await simulateSubmitQuoteAccountMetas({
    rpc: args.rpc,
    programId: args.feeProgramId,
    feeAccount: args.feeAccountPda,
    payer: args.senderWallet,
    payerSubstitution: args.senderWallet,
    input: {
      destinationDomain: args.destinationDomain,
      targetRouter: args.signedTargetRouter,
      scopedSalt,
    },
  });
  const submitInstruction = getSubmitQuoteInstruction(
    args.feeProgramId,
    submitAccounts,
    signedQuote,
  );

  // Sim layout: [fee_account, payer_placeholder, ...pass_through]. Drop the
  // first two: fee_account is already in D1's FeeTransferRemoteSection and
  // the payer is the warp tx's sender_wallet (in the static prefix).
  const passMetas = await simulateFeeQuoteAccountMetas({
    rpc: args.rpc,
    programId: args.feeProgramId,
    feeAccount: args.feeAccountPda,
    payer: args.senderWallet,
    input: {
      destinationDomain: args.destinationDomain,
      targetRouter: args.runtimeTargetRouter,
      scopedSalt,
    },
  });
  const passThroughAccounts = passMetas.slice(2);

  return {
    feeTransientQuotePda,
    submitInstruction,
    passThroughAccounts,
    scopedSalt,
  };
}

/**
 * Common post-transfer assertions shared by all transfer_remote variants:
 * both transient PDAs closed (Quoted flow ran on both programs), the
 * dispatched-message + gas-payment PDAs exist, and the IGP balance grew
 * by the QUOTE-derived gas payment (10x oracle, proving Quoted was used).
 */
async function assertCommonPostConditions(args: {
  rpc: ReturnType<typeof createRpc>;
  igpTransientPda: Address;
  feeTransientPda: Address;
  mailbox: Address;
  uniqueMessageAccount: Address;
  gasPaymentPda: Address;
  igpAccount: Address;
  igpBalanceBefore: bigint;
}): Promise<void> {
  const igpTransient = await args.rpc
    .getAccountInfo(args.igpTransientPda, { encoding: 'base64' })
    .send();
  expect(igpTransient.value, 'IGP transient quote PDA consumed').to.be.null;

  const feeTransient = await args.rpc
    .getAccountInfo(args.feeTransientPda, { encoding: 'base64' })
    .send();
  expect(feeTransient.value, 'fee transient quote PDA consumed').to.be.null;

  const dispatchedMessagePda = (
    await deriveMailboxDispatchedMessagePda(
      args.mailbox,
      args.uniqueMessageAccount,
    )
  ).address;
  const dispatched = await args.rpc
    .getAccountInfo(dispatchedMessagePda, { encoding: 'base64' })
    .send();
  expect(dispatched.value, 'dispatched message PDA').to.exist;

  const gasPayment = await args.rpc
    .getAccountInfo(args.gasPaymentPda, { encoding: 'base64' })
    .send();
  expect(gasPayment.value, 'gas payment PDA').to.exist;

  // IGP balance must have grown by the QUOTE-derived payment (10x oracle).
  //   total_gas = destination_gas + overhead
  //   dest_cost = total_gas * quote_gas_price
  //   origin_cost = dest_cost * exchange_rate / 10^19  (token_decimals = SOL)
  const totalGasAmount = REMOTE_GAS + IGP_OVERHEAD_GAS;
  const expectedGasPayment =
    (totalGasAmount * QUOTE_GAS_PRICE * QUOTE_TOKEN_EXCHANGE_RATE) /
    TOKEN_EXCHANGE_RATE_SCALE;
  const igpBalanceAfter = BigInt(
    (await args.rpc.getBalance(args.igpAccount).send()).value,
  );
  expect(igpBalanceAfter - args.igpBalanceBefore).to.equal(
    expectedGasPayment,
    'IGP balance delta must match the QUOTE-computed gas payment exactly (proving the Quoted flow drove pricing)',
  );
}

/**
 * Fetches the landed tx, asserts it was compiled as v0 with at least
 * one ALT lookup, and that the lookup references our route ALT.
 * Without this, a regression that silently inlined accounts (skipping
 * ALT compression) would land a fat-but-valid tx and pass the test —
 * the assertion on `receipt.signature` alone is too weak.
 */
async function assertTxUsedAlt(args: {
  rpc: ReturnType<typeof createRpc>;
  signature: string;
  expectedAltAddress: Address;
}): Promise<void> {
  // receipt.signature is `string`; narrow to kit's branded `Signature` via
  // the type guard so `getTransaction` accepts it without an `as` cast.
  const sig = args.signature;
  assertIsSignature(sig);
  // `getTransaction` reads the RPC's tx index, which is populated
  // asynchronously after `signer.send` returns confirmed. Poll a few
  // times before giving up — the indexer typically catches up within a
  // slot or two on a healthy validator.
  const fetched = await pollAsync(
    async () => {
      const result = await args.rpc
        .getTransaction(sig, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
          encoding: 'json',
        })
        .send();
      if (result == null) {
        throw new Error(`tx ${sig} not yet indexed`);
      }
      return result;
    },
    500,
    5,
  );
  const message = fetched.transaction.message;
  const lookups =
    'addressTableLookups' in message ? message.addressTableLookups : [];
  expect(
    lookups.length,
    'tx emitted at least one ALT lookup',
  ).to.be.greaterThan(0);
  expect(
    lookups.some((l) => l.accountKey === args.expectedAltAddress),
    `tx referenced expected ALT ${args.expectedAltAddress}`,
  ).to.be.true;
  const totalAltResolved = lookups.reduce(
    (sum, l) =>
      sum + (l.writableIndexes?.length ?? 0) + (l.readonlyIndexes?.length ?? 0),
    0,
  );
  expect(
    totalAltResolved,
    'ALT lookups resolved at least one account',
  ).to.be.greaterThan(0);
}

describe('SVM Warp Transfer-Remote With Fees E2E', function () {
  this.timeout(300_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let quoteSignerPrivateKey: Uint8Array;
  let igpAccount: Address;
  let overheadIgpAccount: Address;
  let igpProgramData: Address;
  let igpConfig: IgpHookConfig;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 100_000_000_000n);

    // Init the Test ISM + Mailbox so the outbox PDA exists for warp dispatch.
    await new SvmTestIsmWriter(
      { program: { programId: TEST_PROGRAM_IDS.testIsm } },
      rpc,
      signer,
    ).create({
      artifactState: ArtifactState.NEW,
      config: { type: 'testIsm' },
    });

    await new SvmMailboxWriter(
      {
        program: { programId: TEST_PROGRAM_IDS.mailbox },
        domainId: DOMAIN_LOCAL,
      },
      rpc,
      signer,
    ).create({
      artifactState: ArtifactState.NEW,
      config: {
        composition: ArtifactComposition.ORCHESTRATED,
        owner: signer.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_PROGRAM_IDS.testIsm },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_PROGRAM_IDS.mailbox },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_PROGRAM_IDS.mailbox },
        },
      },
    });

    quoteSignerPrivateKey = secp256k1.utils.randomSecretKey();
    const quoteSignerHex = ethAddressHexFromPrivateKey(quoteSignerPrivateKey);

    igpConfig = {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      owner: signer.getSignerAddress(),
      beneficiary: signer.getSignerAddress(),
      oracleKey: signer.getSignerAddress(),
      overhead: { [DOMAIN_REMOTE]: 50000 },
      oracleConfig: {
        [DOMAIN_REMOTE]: {
          gasPrice: '1',
          tokenExchangeRate: '1000000000000000000',
        },
      },
      contractVersion: '1.0.0',
      quoteSigners: [quoteSignerHex],
    };
    await new SvmIgpHookWriter(
      { program: { programId: TEST_PROGRAM_IDS.igp }, domainId: DOMAIN_LOCAL },
      rpc,
      DEFAULT_IGP_SALT,
      signer,
    ).create({ artifactState: ArtifactState.NEW, config: igpConfig });

    igpAccount = (
      await deriveIgpAccountPda(TEST_PROGRAM_IDS.igp, DEFAULT_IGP_SALT)
    ).address;
    overheadIgpAccount = (
      await deriveOverheadIgpAccountPda(TEST_PROGRAM_IDS.igp, DEFAULT_IGP_SALT)
    ).address;
    igpProgramData = (await deriveIgpProgramDataPda(TEST_PROGRAM_IDS.igp))
      .address;
  });

  it('transfer_remote: native warp + offchain-quoted routing fee + quoted IGP under ALT compression', async () => {
    // Fee quote signer — separate keypair from the IGP quote signer so the
    // test exercises two independent offchain signing paths in the same tx.
    const feeQuoteSignerPrivateKey = secp256k1.utils.randomSecretKey();
    const feeQuoteSignerHex = ethAddressHexFromPrivateKey(
      feeQuoteSignerPrivateKey,
    );

    // Separate beneficiary keypair so the fee transfer isn't a self-transfer
    // — lets us assert beneficiary actually received the fee post-tx.
    // Pre-fund the account to rent-exempt so it can receive a small fee
    // without tripping the rent check.
    const feeBeneficiarySigner = await generateKeyPairSigner();
    const feeBeneficiary = feeBeneficiarySigner.address;
    await airdropSol(rpc, feeBeneficiary, 1_000_000_000n);
    const beneficiaryBalanceBefore = BigInt(
      (await rpc.getBalance(feeBeneficiary).send()).value,
    );

    // Deploy routing fee with one OFFCHAIN-QUOTED-LINEAR route for DOMAIN_REMOTE.
    // This forces the fee section to consume a signed transient quote.
    const feeWriter = new SvmRoutingFeeWriter(
      { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee } },
      rpc,
      DOMAIN_LOCAL,
      signer,
      { knownRoutersPerDomain: { [DOMAIN_REMOTE]: new Set<string>() } },
      DEFAULT_FEE_SALT,
    );
    const [feeDeployed] = await feeWriter.create({
      config: {
        type: FeeType.routing,
        owner: signer.getSignerAddress(),
        beneficiary: feeBeneficiary,
        routes: {
          [DOMAIN_REMOTE]: {
            type: FeeStrategyType.offchainQuotedLinear,
            params: rawParams(ROUTE_MAX_FEE_PARAM, ROUTE_HALF_AMOUNT_PARAM),
            quoteSigners: [feeQuoteSignerHex],
          },
        },
      },
    });
    const feeProgramId = address(feeDeployed.deployed.programId);
    const feeAccountPda = (
      await deriveFeeAccountPda(feeProgramId, DEFAULT_FEE_SALT)
    ).address;

    // Deploy native warp with fee_config and IGP hook wired up.
    const warpWriter = new SvmNativeTokenWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenNative },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
      },
      rpc,
      signer,
    );
    const [warpDeployed] = await warpWriter.create({
      config: {
        composition: ArtifactComposition.ORCHESTRATED,
        type: TokenType.native,
        owner: signer.getSignerAddress(),
        mailbox: TEST_PROGRAM_IDS.mailbox,
        remoteRouters: {},
        destinationGas: {},
        hook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_PROGRAM_IDS.igp },
        },
        fee: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: feeProgramId },
        },
      },
    });
    const warpProgramId = address(warpDeployed.deployed.address);

    const senderWallet = address(signer.getSignerAddress());
    await signer.send({
      instructions: [
        await getTokenEnrollRemoteRoutersInstruction(
          warpProgramId,
          senderWallet,
          [{ domain: DOMAIN_REMOTE, router: REMOTE_ROUTER }],
        ),
        await getTokenSetDestinationGasConfigsInstruction(
          warpProgramId,
          senderWallet,
          [{ domain: DOMAIN_REMOTE, gas: REMOTE_GAS }],
        ),
      ],
    });

    // ---- Sign + prepare IGP and fee transient quotes ----
    const igpQuote = await setupIgpTransientQuote({
      rpc,
      igpAccount,
      igpProgramId: TEST_PROGRAM_IDS.igp,
      quoteSignerPrivateKey,
      senderWallet,
      warpProgramId,
      destinationDomain: DOMAIN_REMOTE,
      localDomain: DOMAIN_LOCAL,
    });

    const feeQuote = await setupFeeTransientQuote({
      rpc,
      signer,
      senderWallet,
      feeProgramId,
      feeAccountPda,
      feeQuoteSignerPrivateKey,
      context: Uint8Array.from(
        encodeSvmFeeQuoteContext({
          destinationDomain: DOMAIN_REMOTE,
          recipient: RECIPIENT,
          amount: TRANSFER_AMOUNT,
        }),
      ),
      data: linearFeeData(QUOTE_MAX_FEE, QUOTE_HALF_AMOUNT),
      destinationDomain: DOMAIN_REMOTE,
      // Routing/Leaf modes have no `target_router` slot — both signed and
      // runtime use the zero sentinel.
      signedTargetRouter: ZERO_TARGET_ROUTER,
      runtimeTargetRouter: ZERO_TARGET_ROUTER,
      localDomain: DOMAIN_LOCAL,
    });

    // ---- Compose [SubmitFeeQuote, SubmitIgpQuote, TransferRemote] ----
    const uniqueMessageAccount = await generateKeyPairSigner();
    const warpDispatchAuthority = (
      await deriveMailboxDispatchAuthorityPda(warpProgramId)
    ).address;
    const gasPaymentPda = (
      await deriveIgpGasPaymentPda(
        TEST_PROGRAM_IDS.igp,
        uniqueMessageAccount.address,
      )
    ).address;

    const submitIgpQuoteIx = await getSubmitIgpQuoteInstruction(
      TEST_PROGRAM_IDS.igp,
      signer.signer,
      igpAccount,
      igpQuote.transientQuotePda,
      igpQuote.signedQuote,
    );

    const transferRemoteIx = await getTokenTransferRemoteInstruction({
      programAddress: warpProgramId,
      sender: signer.signer,
      uniqueMessageAccount,
      mailbox: TEST_PROGRAM_IDS.mailbox,
      data: {
        destinationDomain: DOMAIN_REMOTE,
        recipient: RECIPIENT,
        amountOrId: TRANSFER_AMOUNT,
      },
      fee: {
        feeProgram: feeProgramId,
        feeAccount: feeAccountPda,
        passThroughAccounts: feeQuote.passThroughAccounts,
        // Native warp's fee_beneficiary_pubkey is just the beneficiary wallet
        // (no ATA, since native moves SOL directly).
        feeBeneficiary: feeBeneficiary,
      },
      igp: {
        programId: TEST_PROGRAM_IDS.igp,
        programData: igpProgramData,
        paymentPda: gasPaymentPda,
        igpAccount: overheadIgpAccount,
        innerIgp: igpAccount,
        quoted: {
          senderAuthority: warpDispatchAuthority,
          senderProgramId: warpProgramId,
          cascadeQuotePdas: igpQuote.cascadeQuotePdas,
        },
      },
      pluginAccounts: [
        readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
        writableAccount(
          (await deriveNativeCollateralPda(warpProgramId)).address,
        ),
      ],
    });

    // ---- ALT: drive the per-token-type alt writer through SvmWarpAltManager.
    // Proves the manager's derived address set is sufficient for an actual
    // on-chain transfer — if any cascade entry were missing the tx would
    // fail trying to resolve the dropped account.
    const expandedNativeWarp: ArtifactDeployed<
      NativeWarpArtifactConfig,
      DeployedWarpAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        composition: ArtifactComposition.ORCHESTRATED,
        type: TokenType.native,
        owner: signer.getSignerAddress(),
        mailbox: TEST_PROGRAM_IDS.mailbox,
        remoteRouters: {
          [DOMAIN_REMOTE]: { address: toHexString(Buffer.from(REMOTE_ROUTER)) },
        },
        destinationGas: { [DOMAIN_REMOTE]: REMOTE_GAS.toString() },
        fee: {
          artifactState: ArtifactState.DEPLOYED,
          config: {
            type: FeeType.routing,
            owner: signer.getSignerAddress(),
            beneficiary: feeBeneficiary,
            routes: {
              [DOMAIN_REMOTE]: {
                type: FeeStrategyType.offchainQuotedLinear,
                params: rawParams(ROUTE_MAX_FEE_PARAM, ROUTE_HALF_AMOUNT_PARAM),
                quoteSigners: [feeQuoteSignerHex],
              },
            },
          },
          deployed: { address: feeProgramId },
        },
        hook: {
          artifactState: ArtifactState.DEPLOYED,
          config: igpConfig,
          deployed: { address: TEST_PROGRAM_IDS.igp },
        },
      },
      deployed: { address: warpProgramId },
    };

    const altManager = createWarpAltManager(TEST_SVM_CHAIN_METADATA, signer);
    const altResult = await altManager
      .createWriter(TokenType.native)
      .create(expandedNativeWarp);

    const igpBalanceBefore = BigInt(
      (await rpc.getBalance(igpAccount).send()).value,
    );
    const receipt = await signer.send({
      instructions: [
        feeQuote.submitInstruction,
        submitIgpQuoteIx,
        transferRemoteIx,
      ],
      additionalSigners: [uniqueMessageAccount],
      addressLookupTables: [altResult.core, ...altResult.warpSpecific],
    });
    expect(receipt.signature, 'tx signature').to.be.a('string');
    for (const altAddress of [altResult.core, ...altResult.warpSpecific]) {
      await assertTxUsedAlt({
        rpc,
        signature: receipt.signature,
        expectedAltAddress: altAddress,
      });
    }

    // ---- Common post-conditions ----
    await assertCommonPostConditions({
      rpc,
      igpTransientPda: igpQuote.transientQuotePda,
      feeTransientPda: feeQuote.feeTransientQuotePda,
      mailbox: TEST_PROGRAM_IDS.mailbox,
      uniqueMessageAccount: uniqueMessageAccount.address,
      gasPaymentPda,
      igpAccount,
      igpBalanceBefore,
    });

    // ---- Plugin-specific post-conditions (native) ----

    // Native collateral PDA holds at least the transferred amount.
    const nativeBalance = await rpc
      .getBalance((await deriveNativeCollateralPda(warpProgramId)).address)
      .send();
    expect(
      BigInt(nativeBalance.value) >= TRANSFER_AMOUNT,
      `native collateral balance ${nativeBalance.value} < ${TRANSFER_AMOUNT}`,
    ).to.be.true;

    // Fee beneficiary's lamport balance grew by the QUOTE-derived fee
    // (1000), not the route-derived fee (5000). Exact equality proves the
    // offchain-quoted path drove pricing — if the warp ever fell back to
    // the route's configured params, the delta would be 5000.
    const beneficiaryBalanceAfter = BigInt(
      (await rpc.getBalance(feeBeneficiary).send()).value,
    );
    expect(beneficiaryBalanceAfter - beneficiaryBalanceBefore).to.equal(
      EXPECTED_QUOTE_DRIVEN_FEE,
      'fee beneficiary delta must match the QUOTE-computed fee exactly (not the route-config fee)',
    );
  });

  interface CcTransferCase {
    /** Mocha test title appended to the shared `transfer_remote_to: …` prefix. */
    description: string;
    /**
     * Bytes the offchain quoter signs into the transient's
     * `ctx.target_router` AND the route key the fee leaf is configured
     * under (both must match, since submit's signer lookup pins to the
     * same key the consume-time scope resolves to).
     */
    signedTargetRouter: Uint8Array;
    /** `FeeDataStrategy.maxFee` baked into the signed transient. */
    quoteMaxFee: bigint;
    /** `FeeDataStrategy.halfAmount` baked into the signed transient. */
    quoteHalfAmount: bigint;
    /**
     * Expected beneficiary delta, computed off-chain to mirror on-chain
     * `min(quoteMaxFee, TRANSFER_AMOUNT * quoteMaxFee / (2 * quoteHalfAmount))`.
     * Distinct per case so the assertion proves *this* case's quote was the
     * one consumed (not a stale or wrong-scope quote).
     */
    expectedFee: bigint;
  }

  // Both cases drive the runtime `quote_fee.target_router = REMOTE_ROUTER`;
  // the only thing that varies is which scope branch the on-chain consumer
  // takes — Specific (exact match) vs Default (cascade fallback). Different
  // `quoteMaxFee` / `quoteHalfAmount` per case → different beneficiary
  // balance → assertion catches a misrouted consume.
  const ccTransferCases: CcTransferCase[] = [
    {
      // Specific-scope: fee leaf at (dest, REMOTE_ROUTER); transient signed
      // with that router. Consume's `cc_specific_route_active = true` →
      // `CcQuoteFeeValidation::Specific` matches `ctx == quote_fee`.
      description: 'CC-routing fee + quoted IGP under ALT compression',
      signedTargetRouter: REMOTE_ROUTER,
      quoteMaxFee: 1000n,
      quoteHalfAmount: 500n,
      // raw = 100_000 * 1000 / 1000 = 100_000 → capped at maxFee = 1000.
      expectedFee: 1000n,
    },
    {
      // Default-scope cascade: fee leaf at (dest, DEFAULT_ROUTER) only;
      // transient signed with DEFAULT_ROUTER. On-chain `resolve_cc_routing`
      // finds (dest, REMOTE_ROUTER) uninitialized → falls back to
      // (dest, DEFAULT_ROUTER) → `cc_specific_route_active = false` →
      // `CcQuoteFeeValidation::Default` accepts the DEFAULT-signed ctx.
      // EVM-parity for `feeContracts[dest][router] ?? DEFAULT_ROUTER`.
      description: 'DEFAULT_ROUTER cascade + quoted IGP under ALT compression',
      signedTargetRouter: DEFAULT_ROUTER,
      quoteMaxFee: 2000n,
      quoteHalfAmount: 1000n,
      // raw = 100_000 * 2000 / 2000 = 100_000 → capped at maxFee = 2000.
      expectedFee: 2000n,
    },
  ];

  for (const {
    description,
    signedTargetRouter,
    quoteMaxFee,
    quoteHalfAmount,
    expectedFee,
  } of ccTransferCases) {
    it(`transfer_remote_to: cross-collateral warp + ${description}`, async () => {
      const senderWallet = address(signer.getSignerAddress());
      const routerKey = `0x${Array.from(REMOTE_ROUTER)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')}`;
      const feeScopeKey = `0x${Array.from(signedTargetRouter)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')}`;

      // ---- SPL mint + sender ATA funded with enough tokens for amount + fee ----
      const mint = await createSplMint(rpc, signer, 9);
      const senderAta = (
        await deriveAssociatedTokenAddress({ wallet: senderWallet, mint })
      ).address;
      await signer.send({
        instructions: [
          getCreateAssociatedTokenIdempotentInstruction({
            payer: senderWallet,
            ata: senderAta,
            wallet: senderWallet,
            mint,
          }),
          getMintToInstruction({
            mint,
            destination: senderAta,
            authority: senderWallet,
            amount: 1_000_000n, // > TRANSFER_AMOUNT + fee
          }),
        ],
      });

      // ---- Fee + beneficiary keypair + beneficiary ATA ----
      // CC fee_beneficiary_pubkey = ATA(beneficiary_owner, mint, SPL_Token).
      // The ATA must exist pre-tx so the fee SPL transfer has a destination.
      const feeQuoteSignerPrivateKey = secp256k1.utils.randomSecretKey();
      const feeQuoteSignerHex = ethAddressHexFromPrivateKey(
        feeQuoteSignerPrivateKey,
      );
      const feeBeneficiarySigner = await generateKeyPairSigner();
      const feeBeneficiaryOwner = feeBeneficiarySigner.address;
      await airdropSol(rpc, feeBeneficiaryOwner, 1_000_000_000n);
      const feeBeneficiaryAta = (
        await deriveAssociatedTokenAddress({
          wallet: feeBeneficiaryOwner,
          mint,
        })
      ).address;
      await signer.send({
        instructions: [
          getCreateAssociatedTokenIdempotentInstruction({
            payer: senderWallet,
            ata: feeBeneficiaryAta,
            wallet: feeBeneficiaryOwner,
            mint,
          }),
        ],
      });

      // ---- Deploy CC routing fee program ----
      // Fee leaf is configured under `feeScopeKey`. Submit-time signer lookup
      // and consume-time scope determination both pin to this key.
      const ccFeeWriter = new SvmCrossCollateralRoutingFeeWriter(
        { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee } },
        rpc,
        DOMAIN_LOCAL,
        signer,
        { knownRoutersPerDomain: { [DOMAIN_REMOTE]: new Set([feeScopeKey]) } },
        DEFAULT_FEE_SALT,
      );
      const [feeDeployed] = await ccFeeWriter.create({
        config: {
          type: FeeType.crossCollateralRouting,
          owner: signer.getSignerAddress(),
          beneficiary: feeBeneficiaryOwner,
          routes: {
            [DOMAIN_REMOTE]: {
              [feeScopeKey]: {
                type: FeeStrategyType.offchainQuotedLinear,
                params: rawParams(ROUTE_MAX_FEE_PARAM, ROUTE_HALF_AMOUNT_PARAM),
                quoteSigners: [feeQuoteSignerHex],
              },
            },
          },
        },
      });
      const feeProgramId = address(feeDeployed.deployed.programId);
      const feeAccountPda = (
        await deriveFeeAccountPda(feeProgramId, DEFAULT_FEE_SALT)
      ).address;

      // ---- Deploy cross-collateral warp wired to mint + fee + IGP ----
      // The warp's `crossCollateralRouters` / `remoteRouters` always use
      // `routerKey` (REMOTE_ROUTER) — that's the real remote-side warp
      // contract address, independent of the fee scope.
      const warpWriter = new SvmCrossCollateralTokenWriter(
        {
          program: {
            programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenCrossCollateral,
          },
          ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
        },
        rpc,
        signer,
      );
      const [warpDeployed] = await warpWriter.create({
        config: {
          composition: ArtifactComposition.ORCHESTRATED,
          type: TokenType.crossCollateral,
          owner: signer.getSignerAddress(),
          mailbox: TEST_PROGRAM_IDS.mailbox,
          token: mint,
          remoteRouters: {},
          destinationGas: {},
          crossCollateralRouters: {},
          hook: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: TEST_PROGRAM_IDS.igp },
          },
          fee: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: feeProgramId },
          },
        },
      });
      const warpProgramId = address(warpDeployed.deployed.address);

      await signer.send({
        instructions: [
          await getTokenEnrollRemoteRoutersInstruction(
            warpProgramId,
            senderWallet,
            [{ domain: DOMAIN_REMOTE, router: REMOTE_ROUTER }],
          ),
          await getTokenSetDestinationGasConfigsInstruction(
            warpProgramId,
            senderWallet,
            [{ domain: DOMAIN_REMOTE, gas: REMOTE_GAS }],
          ),
        ],
      });

      // ---- Sign + prepare IGP and CC-fee transient quotes ----
      const igpQuote = await setupIgpTransientQuote({
        rpc,
        igpAccount,
        igpProgramId: TEST_PROGRAM_IDS.igp,
        quoteSignerPrivateKey,
        senderWallet,
        warpProgramId,
        destinationDomain: DOMAIN_REMOTE,
        localDomain: DOMAIN_LOCAL,
      });

      // Transient `ctx.target_router` = `signedTargetRouter`. Consume-time
      // `unwrap_for_router` rejects a mismatched ctx for the active scope —
      // see `CcQuoteFeeValidation` in `accounts.rs`.
      const feeQuote = await setupFeeTransientQuote({
        rpc,
        signer,
        senderWallet,
        feeProgramId,
        feeAccountPda,
        feeQuoteSignerPrivateKey,
        context: Uint8Array.from(
          encodeSvmFeeQuoteContext({
            destinationDomain: DOMAIN_REMOTE,
            recipient: RECIPIENT,
            amount: TRANSFER_AMOUNT,
            targetRouter: signedTargetRouter,
          }),
        ),
        data: linearFeeData(quoteMaxFee, quoteHalfAmount),
        destinationDomain: DOMAIN_REMOTE,
        // Submit-side route-PDA lookup uses the SIGNED router (where the
        // signer's leaf lives); the consume-side cascade always queries
        // the RUNTIME router (REMOTE_ROUTER — what transfer_remote_to
        // passes to QuoteFee).
        signedTargetRouter,
        runtimeTargetRouter: REMOTE_ROUTER,
        localDomain: DOMAIN_LOCAL,
      });

      // ---- Compose [SubmitFeeQuote, SubmitIgpQuote, TransferRemoteTo] ----
      const uniqueMessageAccount = await generateKeyPairSigner();
      // CC transfer_remote_to_remote uses the mailbox dispatch authority PDA
      // (the same one used by the regular transfer_remote), NOT the CC dispatch
      // authority — that one is only consumed on the local HandleLocal path.
      const warpDispatchAuthority = (
        await deriveMailboxDispatchAuthorityPda(warpProgramId)
      ).address;
      const gasPaymentPda = (
        await deriveIgpGasPaymentPda(
          TEST_PROGRAM_IDS.igp,
          uniqueMessageAccount.address,
        )
      ).address;
      const escrowPda = (await deriveEscrowPda(warpProgramId)).address;

      const submitIgpQuoteIx = await getSubmitIgpQuoteInstruction(
        TEST_PROGRAM_IDS.igp,
        signer.signer,
        igpAccount,
        igpQuote.transientQuotePda,
        igpQuote.signedQuote,
      );

      // `data.targetRouter = REMOTE_ROUTER` always — this is the runtime
      // `quote_fee.target_router` that drives the cascade decision on-chain.
      const transferRemoteToIx =
        await getCrossCollateralTransferRemoteToInstruction({
          programAddress: warpProgramId,
          sender: signer.signer,
          uniqueMessageAccount,
          mailbox: TEST_PROGRAM_IDS.mailbox,
          data: {
            destinationDomain: DOMAIN_REMOTE,
            recipient: RECIPIENT,
            amountOrId: TRANSFER_AMOUNT,
            targetRouter: REMOTE_ROUTER,
          },
          fee: {
            feeProgram: feeProgramId,
            feeAccount: feeAccountPda,
            passThroughAccounts: feeQuote.passThroughAccounts,
            // CC plugin: fee_beneficiary_pubkey = ATA(beneficiary_owner, mint).
            feeBeneficiary: feeBeneficiaryAta,
          },
          igp: {
            programId: TEST_PROGRAM_IDS.igp,
            programData: igpProgramData,
            paymentPda: gasPaymentPda,
            igpAccount: overheadIgpAccount,
            innerIgp: igpAccount,
            quoted: {
              senderAuthority: warpDispatchAuthority,
              senderProgramId: warpProgramId,
              cascadeQuotePdas: igpQuote.cascadeQuotePdas,
            },
          },
          pluginAccounts: [
            readonlyAccount(SPL_TOKEN_PROGRAM_ADDRESS),
            writableAccount(mint),
            writableAccount(senderAta),
            writableAccount(escrowPda),
          ],
        });

      // ---- ALT: drive the per-token-type alt writer through SvmWarpAltManager.
      // The expanded warp config mirrors the on-chain state: warp routes the
      // real remote router under `routerKey`, fee leaf lives at `feeScopeKey`.
      const expandedCcWarp: ArtifactDeployed<
        CrossCollateralWarpArtifactConfig,
        DeployedWarpAddress
      > = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          composition: ArtifactComposition.ORCHESTRATED,
          type: TokenType.crossCollateral,
          owner: signer.getSignerAddress(),
          mailbox: TEST_PROGRAM_IDS.mailbox,
          token: mint,
          crossCollateralRouters: {
            [DOMAIN_REMOTE]: new Set([routerKey]),
          },
          remoteRouters: {
            [DOMAIN_REMOTE]: { address: routerKey },
          },
          destinationGas: { [DOMAIN_REMOTE]: REMOTE_GAS.toString() },
          fee: {
            artifactState: ArtifactState.DEPLOYED,
            config: {
              type: FeeType.crossCollateralRouting,
              owner: signer.getSignerAddress(),
              beneficiary: feeBeneficiaryOwner,
              routes: {
                [DOMAIN_REMOTE]: {
                  [feeScopeKey]: {
                    type: FeeStrategyType.offchainQuotedLinear,
                    params: rawParams(
                      ROUTE_MAX_FEE_PARAM,
                      ROUTE_HALF_AMOUNT_PARAM,
                    ),
                    quoteSigners: [feeQuoteSignerHex],
                  },
                },
              },
            },
            deployed: { address: feeProgramId },
          },
          hook: {
            artifactState: ArtifactState.DEPLOYED,
            config: igpConfig,
            deployed: { address: TEST_PROGRAM_IDS.igp },
          },
        },
        deployed: { address: warpProgramId },
      };

      const altManager = createWarpAltManager(TEST_SVM_CHAIN_METADATA, signer);
      const altResult = await altManager
        .createWriter(TokenType.crossCollateral)
        .create(expandedCcWarp);

      const igpBalanceBefore = BigInt(
        (await rpc.getBalance(igpAccount).send()).value,
      );
      const receipt = await signer.send({
        instructions: [
          feeQuote.submitInstruction,
          submitIgpQuoteIx,
          transferRemoteToIx,
        ],
        additionalSigners: [uniqueMessageAccount],
        addressLookupTables: [altResult.core, ...altResult.warpSpecific],
      });
      expect(receipt.signature, 'tx signature').to.be.a('string');
      for (const altAddress of [altResult.core, ...altResult.warpSpecific]) {
        await assertTxUsedAlt({
          rpc,
          signature: receipt.signature,
          expectedAltAddress: altAddress,
        });
      }

      // ---- Common post-conditions ----
      await assertCommonPostConditions({
        rpc,
        igpTransientPda: igpQuote.transientQuotePda,
        feeTransientPda: feeQuote.feeTransientQuotePda,
        mailbox: TEST_PROGRAM_IDS.mailbox,
        uniqueMessageAccount: uniqueMessageAccount.address,
        gasPaymentPda,
        igpAccount,
        igpBalanceBefore,
      });

      // ---- Plugin-specific post-conditions (cross-collateral) ----
      // SPL Token v2 account data: bytes [64..72] = u64 LE amount.

      // Escrow PDA's token balance must equal the transferred amount.
      const escrowAccount = await rpc
        .getAccountInfo(escrowPda, { encoding: 'base64' })
        .send();
      assert(escrowAccount.value, 'escrow account exists');
      const escrowAmount = Buffer.from(
        escrowAccount.value.data[0],
        'base64',
      ).readBigUInt64LE(64);
      expect(escrowAmount).to.equal(
        TRANSFER_AMOUNT,
        'escrow token balance must equal the transferred amount',
      );

      // Fee beneficiary ATA balance = QUOTE-derived fee (1000), not the
      // route-derived fee (5000). Exact equality proves the offchain-quoted
      // path drove pricing.
      const beneficiaryAtaAccount = await rpc
        .getAccountInfo(feeBeneficiaryAta, { encoding: 'base64' })
        .send();
      assert(beneficiaryAtaAccount.value, 'beneficiary ATA exists');
      const beneficiaryAtaAmount = Buffer.from(
        beneficiaryAtaAccount.value.data[0],
        'base64',
      ).readBigUInt64LE(64);
      expect(beneficiaryAtaAmount).to.equal(
        expectedFee,
        `fee beneficiary ATA balance must match this case's QUOTE-computed fee exactly (proves the (${description}) quote was consumed, not a stale or wrong-scope one)`,
      );
    });
  }
});
