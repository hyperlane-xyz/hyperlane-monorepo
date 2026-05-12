import { secp256k1 } from '@noble/curves/secp256k1';
import {
  type AccountMeta,
  address,
  type Address,
  generateKeyPairSigner,
  getAddressCodec,
  type Instruction,
} from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { sleep } from '@hyperlane-xyz/utils';
import {
  FeeParamsType,
  FeeStrategyType,
  FeeType,
} from '@hyperlane-xyz/provider-sdk/fee';
import type { IgpHookConfig } from '@hyperlane-xyz/provider-sdk/hook';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';

import { SvmAddressLookupTableWriter } from '../alt/address-lookup-table.js';
import { SvmSigner } from '../clients/signer.js';
import {
  SPL_NOOP_PROGRAM_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import { SvmCrossCollateralRoutingFeeWriter } from '../fee/cross-collateral-routing-fee.js';
import { SvmRoutingFeeWriter } from '../fee/routing-fee.js';
import { DEFAULT_FEE_SALT } from '../fee/types.js';
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
import type { SvmSignedQuote } from '../codecs/fee.js';
import { readonlyAccount, writableAccount } from '../instructions/utils.js';
import {
  deriveAssociatedTokenAddress,
  deriveCrossCollateralStatePda,
  deriveEscrowPda,
  deriveFeeAccountPda,
  deriveFeeTransientQuotePda,
  deriveHyperlaneTokenPda,
  deriveIgpAccountPda,
  deriveIgpGasPaymentPda,
  deriveIgpProgramDataPda,
  deriveIgpTransientQuotePda,
  deriveMailboxDispatchAuthorityPda,
  deriveMailboxDispatchedMessagePda,
  deriveMailboxOutboxPda,
  deriveNativeCollateralPda,
  deriveOverheadIgpAccountPda,
} from '../pda.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import {
  computeScopedSalt,
  ethAddressHexFromPrivateKey,
  signSvmQuote,
} from '../testing/quote-signer.js';
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

function u48BE(seconds: bigint): Uint8Array {
  const out = new Uint8Array(6);
  for (let i = 5; i >= 0; i -= 1) {
    out[i] = Number(seconds & 0xffn);
    seconds >>= 8n;
  }
  return out;
}

function u128LE(value: bigint): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function u32LE(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

const addrCodec = getAddressCodec();

/**
 * Builds the 68-byte IGP quote context:
 *   [0:32] fee_token_mint (Pubkey, all-zeros for SOL)
 *   [32:36] destination_domain (u32 LE)
 *   [36:68] sender (warp program id)
 */
function buildIgpQuoteContext(
  destinationDomain: number,
  sender: Address,
): Uint8Array {
  const out = new Uint8Array(68);
  // fee_token_mint = Pubkey::default() = zero bytes (SOL)
  out.set(u32LE(destinationDomain), 32);
  out.set(addrCodec.encode(sender), 36);
  return out;
}

/**
 * Builds the 33-byte IGP quote data:
 *   [0:16] token_exchange_rate (u128 LE)
 *   [16:32] gas_price (u128 LE)
 *   [32:33] token_decimals (u8)
 */
function buildIgpQuoteData(
  tokenExchangeRate: bigint,
  gasPrice: bigint,
  tokenDecimals: number,
): Uint8Array {
  const out = new Uint8Array(33);
  out.set(u128LE(tokenExchangeRate), 0);
  out.set(u128LE(gasPrice), 16);
  out[32] = tokenDecimals;
  return out;
}

function u64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

/**
 * Builds the 44-byte FeeQuoteContext (Leaf/Routing):
 *   [0:4]   destination_domain (u32 LE)
 *   [4:36]  recipient (H256)
 *   [36:44] amount (u64 LE)
 */
function buildFeeQuoteContext(
  destinationDomain: number,
  recipient: Uint8Array,
  amount: bigint,
): Uint8Array {
  const out = new Uint8Array(44);
  out.set(u32LE(destinationDomain), 0);
  out.set(recipient, 4);
  out.set(u64LE(amount), 36);
  return out;
}

/**
 * Builds the 17-byte FeeDataStrategy for an offchain-quoted linear strategy:
 *   [0:1]   kind (u8, 0=Linear)
 *   [1:9]   max_fee (u64 LE)
 *   [9:17]  half_amount (u64 LE)
 */
function buildFeeQuoteData(maxFee: bigint, halfAmount: bigint): Uint8Array {
  const out = new Uint8Array(17);
  out[0] = 0; // FeeStrategyKind.Linear
  out.set(u64LE(maxFee), 1);
  out.set(u64LE(halfAmount), 9);
  return out;
}

/**
 * Builds the 76-byte CcFeeQuoteContext (Cross-Collateral Routing):
 *   [0:4]    destination_domain (u32 LE)
 *   [4:36]   recipient (H256)
 *   [36:44]  amount (u64 LE)
 *   [44:76]  target_router (H256)
 */
function buildCcFeeQuoteContext(
  destinationDomain: number,
  recipient: Uint8Array,
  amount: bigint,
  targetRouter: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(76);
  out.set(u32LE(destinationDomain), 0);
  out.set(recipient, 4);
  out.set(u64LE(amount), 36);
  out.set(targetRouter, 44);
  return out;
}

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

  const issuedAt = u48BE(BigInt(Math.floor(Date.now() / 1000)) + 60n);
  const signedQuote = signSvmQuote({
    privateKey: args.quoteSignerPrivateKey,
    feeAccount: args.igpAccount,
    domainId: args.localDomain,
    payer: args.senderWallet,
    context: buildIgpQuoteContext(args.destinationDomain, args.warpProgramId),
    data: buildIgpQuoteData(
      QUOTE_TOKEN_EXCHANGE_RATE,
      QUOTE_GAS_PRICE,
      QUOTE_TOKEN_DECIMALS,
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
  targetRouter: Uint8Array;
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

  const issuedAt = u48BE(BigInt(Math.floor(Date.now() / 1000)) + 60n);
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
      targetRouter: args.targetRouter,
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
      targetRouter: args.targetRouter,
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

describe('SVM Warp Transfer-Remote With Fees E2E', function () {
  this.timeout(300_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let quoteSignerPrivateKey: Uint8Array;
  let igpAccount: Address;
  let overheadIgpAccount: Address;
  let igpProgramData: Address;

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

    const igpConfig: IgpHookConfig = {
      type: 'interchainGasPaymaster',
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
            params: rawParams('5000', '2500'),
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
      context: buildFeeQuoteContext(DOMAIN_REMOTE, RECIPIENT, TRANSFER_AMOUNT),
      data: buildFeeQuoteData(5000n, 2500n),
      destinationDomain: DOMAIN_REMOTE,
      targetRouter: ZERO_TARGET_ROUTER,
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

    // ---- ALT: only addresses deterministic from the warp/fee/IGP config ----
    // See the matching note in the CC test below — the transient PDA at slot
    // 0 of each cascade is the only per-tx entry, so it stays inline.
    const deterministicIgpCascade = igpQuote.cascadeQuotePdas
      .map((m) => m.address)
      .filter((a) => a !== igpQuote.transientQuotePda);
    const deterministicFeeCascade = feeQuote.passThroughAccounts
      .map((m) => m.address)
      .filter((a) => a !== feeQuote.feeTransientQuotePda);

    const altWriter = new SvmAddressLookupTableWriter(rpc, signer);
    const [altDeployed] = await altWriter.create({
      config: {
        frozen: false,
        addresses: [
          SYSTEM_PROGRAM_ADDRESS,
          SPL_NOOP_PROGRAM_ADDRESS,
          TEST_PROGRAM_IDS.mailbox,
          (await deriveMailboxOutboxPda(TEST_PROGRAM_IDS.mailbox)).address,
          (await deriveHyperlaneTokenPda(warpProgramId)).address,
          warpDispatchAuthority,
          TEST_PROGRAM_IDS.igp,
          igpProgramData,
          igpAccount,
          overheadIgpAccount,
          warpProgramId,
          feeProgramId,
          feeAccountPda,
          feeBeneficiary,
          ...deterministicIgpCascade,
          ...deterministicFeeCascade,
        ],
      },
    });
    await sleep(2000);

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
      addressLookupTables: {
        [altDeployed.deployed.address]: altDeployed.config.addresses,
      },
    });
    expect(receipt.signature, 'tx signature').to.be.a('string');

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

    // Fee beneficiary's lamport balance grew by the exact linear-formula fee:
    //   fee = min(max_fee, amount * max_fee / (2 * half_amount))
    //       = min(5000, 100000 * 5000 / (2 * 2500))
    //       = min(5000, 100000) = 5000
    const EXPECTED_FEE = 5000n;
    const beneficiaryBalanceAfter = BigInt(
      (await rpc.getBalance(feeBeneficiary).send()).value,
    );
    expect(beneficiaryBalanceAfter - beneficiaryBalanceBefore).to.equal(
      EXPECTED_FEE,
      'fee beneficiary delta must match the linear-formula fee exactly',
    );
  });

  it('transfer_remote_to: cross-collateral warp + CC-routing fee + quoted IGP under ALT compression', async () => {
    const senderWallet = address(signer.getSignerAddress());

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
    const routerKey = `0x${Array.from(REMOTE_ROUTER)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')}`;
    const ccFeeWriter = new SvmCrossCollateralRoutingFeeWriter(
      { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee } },
      rpc,
      DOMAIN_LOCAL,
      signer,
      { knownRoutersPerDomain: { [DOMAIN_REMOTE]: new Set([routerKey]) } },
      DEFAULT_FEE_SALT,
    );
    const [feeDeployed] = await ccFeeWriter.create({
      config: {
        type: FeeType.crossCollateralRouting,
        owner: signer.getSignerAddress(),
        beneficiary: feeBeneficiaryOwner,
        routes: {
          [DOMAIN_REMOTE]: {
            [routerKey]: {
              type: FeeStrategyType.offchainQuotedLinear,
              params: rawParams('5000', '2500'),
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

    const feeQuote = await setupFeeTransientQuote({
      rpc,
      signer,
      senderWallet,
      feeProgramId,
      feeAccountPda,
      feeQuoteSignerPrivateKey,
      context: buildCcFeeQuoteContext(
        DOMAIN_REMOTE,
        RECIPIENT,
        TRANSFER_AMOUNT,
        REMOTE_ROUTER,
      ),
      data: buildFeeQuoteData(5000n, 2500n),
      destinationDomain: DOMAIN_REMOTE,
      targetRouter: REMOTE_ROUTER,
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

    // ---- ALT: only addresses deterministic from the warp/fee/IGP config ----
    // The cascade returned by each sim is `[transient, ...standing/route]`.
    // The transient PDA depends on the per-tx `scoped_salt` and must stay
    // inline; the standing / route PDAs only depend on (program, account,
    // domain, target_router) and are stable across transfers — same shape
    // a production route ALT would store.
    const deterministicIgpCascade = igpQuote.cascadeQuotePdas
      .map((m) => m.address)
      .filter((a) => a !== igpQuote.transientQuotePda);
    const deterministicFeeCascade = feeQuote.passThroughAccounts
      .map((m) => m.address)
      .filter((a) => a !== feeQuote.feeTransientQuotePda);

    const altWriter = new SvmAddressLookupTableWriter(rpc, signer);
    const [altDeployed] = await altWriter.create({
      config: {
        frozen: false,
        addresses: [
          SYSTEM_PROGRAM_ADDRESS,
          SPL_NOOP_PROGRAM_ADDRESS,
          SPL_TOKEN_PROGRAM_ADDRESS,
          TEST_PROGRAM_IDS.mailbox,
          (await deriveMailboxOutboxPda(TEST_PROGRAM_IDS.mailbox)).address,
          (await deriveHyperlaneTokenPda(warpProgramId)).address,
          (await deriveCrossCollateralStatePda(warpProgramId)).address,
          warpDispatchAuthority,
          TEST_PROGRAM_IDS.igp,
          igpProgramData,
          igpAccount,
          overheadIgpAccount,
          warpProgramId,
          feeProgramId,
          feeAccountPda,
          feeBeneficiaryAta,
          mint,
          escrowPda,
          ...deterministicIgpCascade,
          ...deterministicFeeCascade,
        ],
      },
    });
    await sleep(2000);

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
      addressLookupTables: {
        [altDeployed.deployed.address]: altDeployed.config.addresses,
      },
    });
    expect(receipt.signature, 'tx signature').to.be.a('string');

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
    expect(escrowAccount.value, 'escrow account exists').to.exist;
    const escrowAmount = Buffer.from(
      escrowAccount.value!.data[0],
      'base64',
    ).readBigUInt64LE(64);
    expect(escrowAmount).to.equal(
      TRANSFER_AMOUNT,
      'escrow token balance must equal the transferred amount',
    );

    // Fee beneficiary ATA's token balance = linear-formula fee (5000).
    const beneficiaryAtaAccount = await rpc
      .getAccountInfo(feeBeneficiaryAta, { encoding: 'base64' })
      .send();
    expect(beneficiaryAtaAccount.value, 'beneficiary ATA exists').to.exist;
    const beneficiaryAtaAmount = Buffer.from(
      beneficiaryAtaAccount.value!.data[0],
      'base64',
    ).readBigUInt64LE(64);
    expect(beneficiaryAtaAmount).to.equal(
      5000n,
      'fee beneficiary ATA balance must equal the linear-formula fee (5000)',
    );
  });
});
