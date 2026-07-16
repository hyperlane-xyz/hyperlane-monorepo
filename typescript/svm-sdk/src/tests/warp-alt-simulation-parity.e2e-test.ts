import { secp256k1 } from '@noble/curves/secp256k1';
import { address, type Address, generateKeyPairSigner } from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type CrossCollateralRoutingFeeArtifactConfig,
  FeeParamsType,
  FeeStrategyType,
  FeeType,
  type LinearFeeConfig,
  type RoutingFeeArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/fee';
import type { IgpHookConfig } from '@hyperlane-xyz/provider-sdk/hook';
import {
  type CrossCollateralWarpArtifactConfig,
  type DeployedWarpAddress,
  TokenType,
} from '@hyperlane-xyz/provider-sdk/warp';

import { createWarpAltReader } from '../alt/warp-alt-manager.js';
import { deriveCoreDeploymentAltAddresses } from '../alt/warp-alt.js';
import { SvmSigner } from '../clients/signer.js';
import { SvmMailboxWriter } from '../core/mailbox.js';
import { SvmCrossCollateralRoutingFeeWriter } from '../fee/cross-collateral-routing-fee.js';
import { SvmLinearFeeWriter } from '../fee/linear-fee.js';
import { SvmRoutingFeeWriter } from '../fee/routing-fee.js';
import { DEFAULT_FEE_SALT } from '../fee/types.js';
import { DEFAULT_IGP_SALT, SvmIgpHookWriter } from '../hook/igp-hook.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { simulateFeeQuoteAccountMetas } from '../instructions/fee.js';
import { simulateIgpQuoteAccountMetas } from '../instructions/igp.js';
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getMintToInstruction,
} from '../instructions/spl-token.js';
import {
  getTokenEnrollRemoteRoutersInstruction,
  getTokenSetDestinationGasConfigsInstruction,
} from '../instructions/token.js';
import { WILDCARD_SENDER } from '../codecs/igp.js';
import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import { SvmTestIsmWriter } from '../ism/test-ism.js';
import {
  deriveAssociatedTokenAddress,
  deriveIgpAccountPda,
  deriveIgpStandingQuotePda,
} from '../pda.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { ethAddressHexFromPrivateKey } from '../quote-signing.js';
import {
  TEST_ATA_PAYER_FUNDING_AMOUNT,
  TEST_PROGRAM_IDS,
  airdropSol,
  createSplMint,
} from '../testing/setup.js';
import { SvmCrossCollateralTokenWriter } from '../warp/cross-collateral-token.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const DOMAIN_LOCAL = 1;
const DOMAIN_REMOTE = 99;
// A cross-collateral-only destination: present in crossCollateralRouters but
// absent from remoteRouters. Its per-domain IGP standing quotes must still be
// covered by the ALT.
const DOMAIN_CC_ONLY = 77;
const CC_ONLY_ROUTER = new Uint8Array(32).fill(0xcd);
const CC_ONLY_ROUTER_HEX = `0x${Array.from(CC_ONLY_ROUTER)
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('')}`;
const REMOTE_ROUTER = new Uint8Array(32).fill(0xab);
const REMOTE_ROUTER_HEX = `0x${Array.from(REMOTE_ROUTER)
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('')}`;
const REMOTE_GAS = 50_000n;

interface CompletenessCase {
  name: string;
  feeType:
    | typeof FeeType.linear
    | typeof FeeType.routing
    | typeof FeeType.crossCollateralRouting
    | null;
  igpEnabled: boolean;
}

const CASES: CompletenessCase[] = [
  { name: 'leaf fee + IGP enabled', feeType: FeeType.linear, igpEnabled: true },
  {
    name: 'leaf fee + IGP disabled',
    feeType: FeeType.linear,
    igpEnabled: false,
  },
  {
    name: 'routing fee + IGP enabled',
    feeType: FeeType.routing,
    igpEnabled: true,
  },
  {
    name: 'routing fee + IGP disabled',
    feeType: FeeType.routing,
    igpEnabled: false,
  },
  {
    name: 'CC-routing fee + IGP enabled',
    feeType: FeeType.crossCollateralRouting,
    igpEnabled: true,
  },
  {
    name: 'CC-routing fee + IGP disabled',
    feeType: FeeType.crossCollateralRouting,
    igpEnabled: false,
  },
  { name: 'no fee + IGP enabled', feeType: null, igpEnabled: true },
];

/**
 * For each (fee type × IGP-on/off) combination, this suite derives the
 * warp's ALT address set off-chain via the same code path that powers
 * `hyperlane warp alt create`, then runs the on-chain `GetQuoteAccountMetas`
 * and `GetIgpQuoteAccountMetas` simulation instructions to enumerate every
 * account each cascade actually reads. The test fails the moment any
 * simulation-returned account isn't in the ALT set — surfacing drift
 * between the on-chain handler and the off-chain `deriveWarpRouteAddresses`
 * derivation as soon as it appears.
 *
 * No ALTs are written on chain; the test exercises the pure derivation
 * path against the live program's account-meta enumerator.
 */
describe('SVM warp ALT simulation parity — cross-collateral', function () {
  this.timeout(600_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let mailboxAddress: Address;
  let igpProgramId: Address;
  let igpAccountPda: Address;
  let igpConfig: IgpHookConfig;
  let collateralMint: Address;
  let feeBeneficiaryOwner: Address;
  let warpProgramId: Address;

  // Each fee variant deploys its own fee program (so the per-chain
  // `resolveFeeSalt` PDA doesn't collide). The artifact config is the same
  // shape the off-chain ALT writer consumes — keeping the on-chain account
  // state and the in-memory artifact in lockstep is what makes the
  // simulation-vs-ALT diff meaningful.
  let linearFee: {
    programId: Address;
    accountPda: Address;
    config: LinearFeeConfig;
  };
  let routingFee: {
    programId: Address;
    accountPda: Address;
    config: RoutingFeeArtifactConfig;
  };
  let ccRoutingFee: {
    programId: Address;
    accountPda: Address;
    config: CrossCollateralRoutingFeeArtifactConfig;
  };

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    const senderWallet = address(signer.getSignerAddress());
    await airdropSol(rpc, senderWallet, 100_000_000_000n);

    mailboxAddress = TEST_PROGRAM_IDS.mailbox;
    igpProgramId = TEST_PROGRAM_IDS.igp;

    // ---- ISM ----
    await new SvmTestIsmWriter(
      { program: { programId: TEST_PROGRAM_IDS.testIsm } },
      rpc,
      signer,
    ).create({
      artifactState: ArtifactState.NEW,
      config: { type: 'testIsm' },
    });

    // ---- Mailbox (outbox PDA must exist for warp dispatch) ----
    await new SvmMailboxWriter(
      {
        program: { programId: mailboxAddress },
        domainId: DOMAIN_LOCAL,
      },
      rpc,
      signer,
    ).create({
      config: {
        owner: signer.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_PROGRAM_IDS.testIsm },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: mailboxAddress },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: mailboxAddress },
        },
      },
    });

    // ---- IGP hook (program is shared with all warps in CI) ----
    const quoteSignerHex = ethAddressHexFromPrivateKey(
      secp256k1.utils.randomSecretKey(),
    );
    igpConfig = {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      owner: signer.getSignerAddress(),
      beneficiary: signer.getSignerAddress(),
      oracleKey: signer.getSignerAddress(),
      overhead: { [DOMAIN_REMOTE]: 50_000 },
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
      { program: { programId: igpProgramId }, domainId: DOMAIN_LOCAL },
      rpc,
      DEFAULT_IGP_SALT,
      signer,
    ).create({
      artifactState: ArtifactState.NEW,
      config: igpConfig,
    });

    // ---- SPL mint + sender ATA funded for amount + max fee headroom ----
    collateralMint = await createSplMint(rpc, signer, 9);
    const senderAta = (
      await deriveAssociatedTokenAddress({
        wallet: senderWallet,
        mint: collateralMint,
      })
    ).address;
    await signer.send({
      instructions: [
        getCreateAssociatedTokenIdempotentInstruction({
          payer: senderWallet,
          ata: senderAta,
          wallet: senderWallet,
          mint: collateralMint,
        }),
        getMintToInstruction({
          mint: collateralMint,
          destination: senderAta,
          authority: senderWallet,
          amount: 1_000_000_000n,
        }),
      ],
    });

    // ---- Fee beneficiary owner + its ATA (CC fees pay to an ATA) ----
    // The beneficiary doesn't sign anything; we just need a stable address
    // for the fee artifact configs. The ATA is created so the fee program
    // is wired against real state in case a future simulation branches on it.
    feeBeneficiaryOwner = (await generateKeyPairSigner()).address;
    const feeBeneficiaryAta = (
      await deriveAssociatedTokenAddress({
        wallet: feeBeneficiaryOwner,
        mint: collateralMint,
      })
    ).address;
    await signer.send({
      instructions: [
        getCreateAssociatedTokenIdempotentInstruction({
          payer: senderWallet,
          ata: feeBeneficiaryAta,
          wallet: feeBeneficiaryOwner,
          mint: collateralMint,
        }),
      ],
    });

    // ---- CC warp deploy (fee + hook are wired at artifact-build time
    //      per test case; the on-chain warp itself doesn't care) ----
    const ccWarpWriter = new SvmCrossCollateralTokenWriter(
      {
        program: {
          programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenCrossCollateral,
        },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
      },
      rpc,
      signer,
    );
    const [warpDeployed] = await ccWarpWriter.create({
      config: {
        type: TokenType.crossCollateral,
        owner: signer.getSignerAddress(),
        mailbox: mailboxAddress,
        token: collateralMint,
        remoteRouters: {},
        destinationGas: {},
        crossCollateralRouters: {},
      },
    });
    warpProgramId = address(warpDeployed.deployed.address);

    // ---- Enroll the single remote router + gas config used by every test ----
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

    // ---- IGP account PDA (cached for per-test simulation calls) ----
    igpAccountPda = (await deriveIgpAccountPda(igpProgramId, DEFAULT_IGP_SALT))
      .address;

    // ---- Fee program deploys — one per fee type, default salt each.
    // Sharing the chain's resolveFeeSalt across multiple fee accounts on
    // the same program would collide on the (programId, salt) PDA, so we
    // give each fee type its own program. ----
    const feeProgramTarget = {
      program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee },
    };
    const linearParams = {
      type: FeeParamsType.raw,
      maxFee: '1000',
      halfAmount: '500',
    };
    const ccRoutingRouters = {
      [DOMAIN_REMOTE]: new Set([REMOTE_ROUTER_HEX]),
    };
    const feeReadContext = {
      knownRoutersPerDomain: ccRoutingRouters,
    };

    const [linearDeployed] = await new SvmLinearFeeWriter(
      feeProgramTarget,
      rpc,
      DOMAIN_LOCAL,
      signer,
      DEFAULT_FEE_SALT,
    ).create({
      artifactState: ArtifactState.NEW,
      config: {
        type: FeeType.linear,
        owner: signer.getSignerAddress(),
        beneficiary: feeBeneficiaryOwner,
        params: linearParams,
      },
    });
    linearFee = {
      programId: address(linearDeployed.deployed.programId),
      accountPda: address(linearDeployed.deployed.feeAccountPda),
      config: linearDeployed.config,
    };

    const [routingDeployed] = await new SvmRoutingFeeWriter(
      feeProgramTarget,
      rpc,
      DOMAIN_LOCAL,
      signer,
      feeReadContext,
      DEFAULT_FEE_SALT,
    ).create({
      artifactState: ArtifactState.NEW,
      config: {
        type: FeeType.routing,
        owner: signer.getSignerAddress(),
        beneficiary: feeBeneficiaryOwner,
        routes: {
          [DOMAIN_REMOTE]: {
            type: FeeStrategyType.linear,
            params: linearParams,
          },
        },
      },
    });
    routingFee = {
      programId: address(routingDeployed.deployed.programId),
      accountPda: address(routingDeployed.deployed.feeAccountPda),
      config: routingDeployed.config,
    };

    const [ccRoutingDeployed] = await new SvmCrossCollateralRoutingFeeWriter(
      feeProgramTarget,
      rpc,
      DOMAIN_LOCAL,
      signer,
      feeReadContext,
      DEFAULT_FEE_SALT,
    ).create({
      artifactState: ArtifactState.NEW,
      config: {
        type: FeeType.crossCollateralRouting,
        owner: signer.getSignerAddress(),
        beneficiary: feeBeneficiaryOwner,
        routes: {
          [DOMAIN_REMOTE]: {
            [REMOTE_ROUTER_HEX]: {
              type: FeeStrategyType.linear,
              params: linearParams,
            },
          },
        },
      },
    });
    ccRoutingFee = {
      programId: address(ccRoutingDeployed.deployed.programId),
      accountPda: address(ccRoutingDeployed.deployed.feeAccountPda),
      config: ccRoutingDeployed.config,
    };
  });

  for (const c of CASES) {
    it(c.name, async () => {
      const feeSetup =
        c.feeType === FeeType.linear
          ? linearFee
          : c.feeType === FeeType.routing
            ? routingFee
            : c.feeType === FeeType.crossCollateralRouting
              ? ccRoutingFee
              : null;

      // Build the expanded warp artifact the off-chain ALT derivation
      // consumes. Fee + hook are conditional on the case row.
      const expandedWarp: ArtifactDeployed<
        CrossCollateralWarpArtifactConfig,
        DeployedWarpAddress
      > = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: TokenType.crossCollateral,
          owner: signer.getSignerAddress(),
          mailbox: mailboxAddress,
          token: collateralMint,
          remoteRouters: {
            [DOMAIN_REMOTE]: { address: REMOTE_ROUTER_HEX },
          },
          destinationGas: { [DOMAIN_REMOTE]: REMOTE_GAS.toString() },
          crossCollateralRouters: {
            [DOMAIN_REMOTE]: new Set([REMOTE_ROUTER_HEX]),
          },
          ...(feeSetup
            ? {
                fee: {
                  artifactState: ArtifactState.DEPLOYED,
                  config: feeSetup.config,
                  deployed: { address: feeSetup.programId },
                },
              }
            : {}),
          ...(c.igpEnabled
            ? {
                hook: {
                  artifactState: ArtifactState.DEPLOYED,
                  config: igpConfig,
                  deployed: { address: igpProgramId },
                },
              }
            : {}),
        },
        deployed: { address: warpProgramId },
      };

      // ---- Off-chain ALT set ----
      const altReader = createWarpAltReader(TEST_SVM_CHAIN_METADATA);
      const reader = altReader.createReader(TokenType.crossCollateral);
      const warpSpecific = await reader.deriveWarpRouteAddresses(expandedWarp);
      const core = await deriveCoreDeploymentAltAddresses(
        mailboxAddress,
        c.igpEnabled
          ? {
              programId: igpProgramId,
              igpSalt: DEFAULT_IGP_SALT,
              includeOverheadIgp: Object.keys(igpConfig.overhead).length > 0,
            }
          : undefined,
      );
      const altSet = new Set<string>(
        [...core, ...warpSpecific].map((entry) => entry.address),
      );

      // ---- On-chain expected addresses via simulation ----
      const senderWallet = address(signer.getSignerAddress());
      const expected = new Set<string>();

      if (feeSetup) {
        const metas = await simulateFeeQuoteAccountMetas({
          rpc,
          programId: feeSetup.programId,
          feeAccount: feeSetup.accountPda,
          payer: senderWallet,
          input: {
            destinationDomain: DOMAIN_REMOTE,
            targetRouter: REMOTE_ROUTER,
          },
        });
        for (const meta of metas) expected.add(meta.address);
      }

      if (c.igpEnabled) {
        const metas = await simulateIgpQuoteAccountMetas({
          rpc,
          programId: igpProgramId,
          igpAccount: igpAccountPda,
          payer: senderWallet,
          input: {
            destinationDomain: DOMAIN_REMOTE,
            sender: warpProgramId,
          },
        });
        for (const meta of metas) expected.add(meta.address);
      }

      // ---- Assertion: every simulation-returned address is in the ALT ----
      const missing = [...expected].filter((addr) => !altSet.has(addr));
      expect(
        missing,
        `addresses missing from ALT (${missing.length}): ${missing.join(', ')}`,
      ).to.have.length(0);
    });
  }

  it('covers IGP standing quotes for cross-collateral-only destination domains', async () => {
    // DOMAIN_CC_ONLY lives only in crossCollateralRouters, never in
    // remoteRouters — the case where the two domain sets diverge. Its IGP
    // standing-quote PDAs must still land in the ALT.
    const expandedWarp: ArtifactDeployed<
      CrossCollateralWarpArtifactConfig,
      DeployedWarpAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: TokenType.crossCollateral,
        owner: signer.getSignerAddress(),
        mailbox: mailboxAddress,
        token: collateralMint,
        remoteRouters: {
          [DOMAIN_REMOTE]: { address: REMOTE_ROUTER_HEX },
        },
        destinationGas: { [DOMAIN_REMOTE]: REMOTE_GAS.toString() },
        crossCollateralRouters: {
          [DOMAIN_REMOTE]: new Set([REMOTE_ROUTER_HEX]),
          [DOMAIN_CC_ONLY]: new Set([CC_ONLY_ROUTER_HEX]),
        },
        fee: {
          artifactState: ArtifactState.DEPLOYED,
          config: ccRoutingFee.config,
          deployed: { address: ccRoutingFee.programId },
        },
        hook: {
          artifactState: ArtifactState.DEPLOYED,
          config: igpConfig,
          deployed: { address: igpProgramId },
        },
      },
      deployed: { address: warpProgramId },
    };

    const altReader = createWarpAltReader(TEST_SVM_CHAIN_METADATA);
    const reader = altReader.createReader(TokenType.crossCollateral);
    const warpSpecific = await reader.deriveWarpRouteAddresses(expandedWarp);
    const altSet = new Set<string>(warpSpecific.map((entry) => entry.address));

    // The IGP cascade emits, per enrolled domain, (domain, sender) and
    // (domain, WILDCARD_SENDER) standing-quote PDAs against the native
    // sentinel mint. Assert both for DOMAIN_CC_ONLY.
    const perDest = await deriveIgpStandingQuotePda(
      igpProgramId,
      igpAccountPda,
      SYSTEM_PROGRAM_ADDRESS,
      DOMAIN_CC_ONLY,
      warpProgramId,
    );
    const perDestWildcardSender = await deriveIgpStandingQuotePda(
      igpProgramId,
      igpAccountPda,
      SYSTEM_PROGRAM_ADDRESS,
      DOMAIN_CC_ONLY,
      WILDCARD_SENDER,
    );

    expect(altSet.has(perDest.address)).to.equal(
      true,
      `ALT missing IGP standing quote for CC-only domain ${DOMAIN_CC_ONLY} (sender=self)`,
    );
    expect(altSet.has(perDestWildcardSender.address)).to.equal(
      true,
      `ALT missing IGP standing quote for CC-only domain ${DOMAIN_CC_ONLY} (sender=wildcard)`,
    );
  });
});
