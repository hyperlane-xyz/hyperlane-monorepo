import { secp256k1 } from '@noble/curves/secp256k1';
import {
  address,
  type Address,
  generateKeyPairSigner,
  getAddressCodec,
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
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
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
import {
  getTokenEnrollRemoteRoutersInstruction,
  getTokenSetDestinationGasConfigsInstruction,
  getTokenTransferRemoteInstruction,
} from '../instructions/token.js';
import {
  readonlyAccount,
  writableAccount,
  writableSigner,
} from '../instructions/utils.js';
import {
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
} from '../testing/setup.js';
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

const rawParams = (maxFee: string, halfAmount: string) =>
  ({ type: FeeParamsType.raw, maxFee, halfAmount }) as const;

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

    // Sign + prepare the IGP transient quote (won't submit yet — same tx).
    const clientSalt = secp256k1.utils.randomSecretKey();
    const scopedSalt = computeScopedSalt(senderWallet, clientSalt);
    const transientQuotePda = (
      await deriveIgpTransientQuotePda(
        TEST_PROGRAM_IDS.igp,
        igpAccount,
        scopedSalt,
      )
    ).address;
    // For a transient quote, expiry == issued_at. Shift issued_at slightly
    // into the future so tx processing time is < expiry.
    // MAX_QUOTE_ISSUED_AT_FUTURE_SKEW_SECS = 300 in the quote-verifier.
    // Quote's gas_price = 10x the on-chain oracle's gas_price (oracle = 1)
    // so the resulting fee is 10x what the legacy/oracle path would charge.
    // Lets the test distinguish Quoted-flow consumption from a legacy
    // fallback by asserting the exact IGP balance delta below.
    const QUOTE_GAS_PRICE = 10n;
    const QUOTE_TOKEN_EXCHANGE_RATE = 1_000_000_000_000_000_000n; // 1e18
    const QUOTE_TOKEN_DECIMALS = 9;

    const issuedAt = u48BE(BigInt(Math.floor(Date.now() / 1000)) + 60n);
    const signedQuote = signSvmQuote({
      privateKey: quoteSignerPrivateKey,
      feeAccount: igpAccount,
      domainId: DOMAIN_LOCAL,
      payer: senderWallet,
      context: buildIgpQuoteContext(DOMAIN_REMOTE, warpProgramId),
      data: buildIgpQuoteData(
        QUOTE_TOKEN_EXCHANGE_RATE,
        QUOTE_GAS_PRICE,
        QUOTE_TOKEN_DECIMALS,
      ),
      issuedAt,
      expiry: issuedAt, // transient quote
      clientSalt,
    });

    // Sign the offchain fee quote. Same scoped_salt as IGP — the fee
    // and IGP scoped salts use distinct PDA derivations (different program
    // IDs), so reusing the clientSalt is safe.
    const feeClientSalt = secp256k1.utils.randomSecretKey();
    const feeScopedSalt = computeScopedSalt(senderWallet, feeClientSalt);
    const feeTransientQuotePda = (
      await deriveFeeTransientQuotePda(
        feeProgramId,
        feeAccountPda,
        feeScopedSalt,
      )
    ).address;

    const feeIssuedAt = u48BE(BigInt(Math.floor(Date.now() / 1000)) + 60n);
    const feeSignedQuote = signSvmQuote({
      privateKey: feeQuoteSignerPrivateKey,
      feeAccount: feeAccountPda,
      domainId: DOMAIN_LOCAL,
      payer: senderWallet,
      context: buildFeeQuoteContext(DOMAIN_REMOTE, RECIPIENT, TRANSFER_AMOUNT),
      data: buildFeeQuoteData(5000n, 2500n),
      issuedAt: feeIssuedAt,
      expiry: feeIssuedAt, // transient quote
      clientSalt: feeClientSalt,
    });

    // Simulate the fee-program SubmitQuote account set.
    const feeSubmitMetas = await simulateSubmitQuoteAccountMetas({
      rpc,
      programId: feeProgramId,
      feeAccount: feeAccountPda,
      payer: senderWallet,
      input: {
        destinationDomain: DOMAIN_REMOTE,
        targetRouter: ZERO_TARGET_ROUTER,
        scopedSalt: feeScopedSalt,
      },
    });
    // Replace the payer placeholder (index 1) with the real signer.
    const feeSubmitAccounts = feeSubmitMetas.map((m, i) => {
      if (i === 1) return writableSigner(signer.signer);
      return m.isWritable
        ? writableAccount(m.pubkey)
        : readonlyAccount(m.pubkey);
    });
    const submitFeeQuoteIx = getSubmitQuoteInstruction(
      feeProgramId,
      feeSubmitAccounts,
      feeSignedQuote,
    );

    // Discover the fee section's pass-through accounts for transfer_remote.
    // With scopedSalt provided, the cascade includes the freshly-submitted
    // transient quote PDA.
    const feeMetas = await simulateFeeQuoteAccountMetas({
      rpc,
      programId: feeProgramId,
      feeAccount: feeAccountPda,
      payer: senderWallet,
      input: {
        destinationDomain: DOMAIN_REMOTE,
        targetRouter: ZERO_TARGET_ROUTER,
        scopedSalt: feeScopedSalt,
      },
    });
    // Sim layout: [fee_account, payer_placeholder, ...pass_through].
    // Drop the first two — fee_account is part of D1's FeeTransferRemoteSection,
    // and payer is the warp tx's sender_wallet (already in the static prefix).
    const feePassThrough = feeMetas
      .slice(2)
      .map((m) =>
        m.isWritable ? writableAccount(m.pubkey) : readonlyAccount(m.pubkey),
      );

    const igpMetas = await simulateIgpQuoteAccountMetas({
      rpc,
      programId: TEST_PROGRAM_IDS.igp,
      igpAccount,
      payer: senderWallet,
      input: {
        destinationDomain: DOMAIN_REMOTE,
        sender: warpProgramId,
        scopedSalt,
      },
    });
    // IGP sim returns the PayForGas CPI account layout:
    //   [0] system_program
    //   [1] payer (placeholder, SDK replaces with sender_wallet)
    //   [2] igp_program_data
    //   [3] unique_gas_payment (placeholder, SDK replaces with unique_message)
    //   [4] gas_payment_pda (placeholder, SDK derives from unique_message)
    //   [5] configured_igp (or inner_igp for OverheadIgp — see warp/IGP variant)
    //   [6] sender_authority
    //   [7] quoted_sender (= warp program id)
    //   [8..]  cascade quote PDAs (transient or standing)
    // Slots [0..7] map onto fields D1 already knows or derives; the only
    // value we need from the sim is the cascade tail at [8..].
    const cascadeQuotePdas = igpMetas
      .slice(8)
      .map((m) =>
        m.isWritable ? writableAccount(m.pubkey) : readonlyAccount(m.pubkey),
      );

    // Compose [SubmitIgpQuote, TransferRemote].
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

    const submitQuoteIx = await getSubmitIgpQuoteInstruction(
      TEST_PROGRAM_IDS.igp,
      signer.signer,
      igpAccount,
      transientQuotePda,
      signedQuote,
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
        passThroughAccounts: feePassThrough,
        // Native warp's fee_beneficiary_pubkey is just the beneficiary wallet
        // (no ATA, since native moves SOL directly).
        feeBeneficiary: feeBeneficiary,
      },
      igp: {
        programId: TEST_PROGRAM_IDS.igp,
        programData: igpProgramData,
        paymentPda: gasPaymentPda,
        igpAccount: overheadIgpAccount, // OverheadIgp configured
        innerIgp: igpAccount,
        quoted: {
          senderAuthority: warpDispatchAuthority,
          cascadeQuotePdas,
        },
      },
      pluginAccounts: [
        readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
        writableAccount(
          (await deriveNativeCollateralPda(warpProgramId)).address,
        ),
      ],
    });

    // Build + freeze an ALT covering the static accounts to fit under
    // the 1232-byte packet limit.
    const altWriter = new SvmAddressLookupTableWriter(rpc, signer);
    const [altDeployed] = await altWriter.create({
      config: {
        owner: senderWallet,
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
        ],
      },
    });

    // Newly-created ALTs aren't available for lookups until the next slot.
    await sleep(2000);

    // Capture IGP balance pre-tx so we can assert the exact gas payment.
    const igpBalanceBefore = BigInt(
      (await rpc.getBalance(igpAccount).send()).value,
    );

    const receipt = await signer.send({
      instructions: [submitFeeQuoteIx, submitQuoteIx, transferRemoteIx],
      additionalSigners: [uniqueMessageAccount],
      addressLookupTables: {
        [altDeployed.deployed.address]: altDeployed.config.addresses,
      },
    });
    expect(receipt.signature, 'tx signature').to.be.a('string');

    // Both transient quote PDAs must be CLOSED — proves the fee program and
    // IGP both ran their respective Quoted flows and consumed the offchain-
    // signed transient quotes. The legacy/on-chain paths would not touch them.
    const igpTransient = await rpc
      .getAccountInfo(transientQuotePda, { encoding: 'base64' })
      .send();
    expect(igpTransient.value, 'IGP transient quote PDA consumed').to.be.null;

    const feeTransient = await rpc
      .getAccountInfo(feeTransientQuotePda, { encoding: 'base64' })
      .send();
    expect(feeTransient.value, 'fee transient quote PDA consumed').to.be.null;

    // Dispatched message PDA exists — proves mailbox dispatch ran.
    const dispatchedMessagePda = (
      await deriveMailboxDispatchedMessagePda(
        TEST_PROGRAM_IDS.mailbox,
        uniqueMessageAccount.address,
      )
    ).address;
    const dispatched = await rpc
      .getAccountInfo(dispatchedMessagePda, { encoding: 'base64' })
      .send();
    expect(dispatched.value, 'dispatched message PDA').to.exist;

    // Gas payment PDA exists — proves IGP PayForGas CPI created the receipt.
    const gasPayment = await rpc
      .getAccountInfo(gasPaymentPda, { encoding: 'base64' })
      .send();
    expect(gasPayment.value, 'gas payment PDA').to.exist;

    // IGP balance must have grown by the QUOTE-derived gas payment exactly.
    // Distinguishes Quoted vs legacy oracle: the oracle is set to gas_price=1
    // while the quote uses gas_price=10, so the Quoted path charges 10x.
    //
    // compute_gas_fee:
    //   dest_cost = total_gas_amount * quote_gas_price
    //   origin_cost = dest_cost * exchange_rate / 10^19
    //   (token_decimals == SOL_DECIMALS so no further conversion)
    //
    // total_gas_amount = destination_gas + overhead = 50_000 + 50_000 = 100_000
    // dest_cost = 100_000 * 10 = 1_000_000
    // origin_cost = 1_000_000 * 1e18 / 1e19 = 100_000 lamports
    const TOKEN_EXCHANGE_RATE_SCALE = 10_000_000_000_000_000_000n;
    const totalGasAmount = REMOTE_GAS + 50_000n; // + IGP overhead for DOMAIN_REMOTE
    const expectedGasPayment =
      (totalGasAmount * QUOTE_GAS_PRICE * QUOTE_TOKEN_EXCHANGE_RATE) /
      TOKEN_EXCHANGE_RATE_SCALE;
    const igpBalanceAfter = BigInt(
      (await rpc.getBalance(igpAccount).send()).value,
    );
    expect(igpBalanceAfter - igpBalanceBefore).to.equal(
      expectedGasPayment,
      'IGP balance delta must match the QUOTE-computed gas payment exactly (proving the Quoted flow, not the oracle, drove pricing)',
    );

    // Native collateral PDA holds at least the transferred amount.
    const nativeBalance = await rpc
      .getBalance((await deriveNativeCollateralPda(warpProgramId)).address)
      .send();
    expect(
      BigInt(nativeBalance.value) >= TRANSFER_AMOUNT,
      `native collateral balance ${nativeBalance.value} < ${TRANSFER_AMOUNT}`,
    ).to.be.true;

    // Fee beneficiary's balance grew by the exact linear-formula fee:
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
});
