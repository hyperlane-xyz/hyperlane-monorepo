import { address, type Address, generateKeyPairSigner } from '@solana/kit';
import { before, describe } from 'mocha';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import type { IgpHookConfig } from '@hyperlane-xyz/provider-sdk/hook';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';

import { SvmSigner } from '../clients/signer.js';
import { SvmMailboxWriter } from '../core/mailbox.js';
import { DEFAULT_IGP_SALT, SvmIgpHookWriter } from '../hook/igp-hook.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getMintToInstruction,
} from '../instructions/spl-token.js';
import {
  getTokenEnrollRemoteRoutersInstruction,
  getTokenSetDestinationGasConfigsInstruction,
} from '../instructions/token.js';
import { SvmTestIsmWriter } from '../ism/test-ism.js';
import { deriveAssociatedTokenAddress } from '../pda.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
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
const REMOTE_ROUTER = new Uint8Array(32).fill(0xab);
const REMOTE_GAS = 50_000n;

/**
 * Drives a single CC warp through the `SvmWarpAltManager` for every
 * combination of fee type (none / leaf / routing / CC routing) and IGP
 * presence, ALT-compresses a real `transfer_remote_to` tx using only the
 * freshly-emitted ALTs, and simulates on chain. If `deriveWarpRouteAddresses`
 * forgets any account the on-chain handler reads, the simulation fails and
 * the test surfaces exactly which addresses are missing — proving the
 * off-chain ALT derivation stays in lockstep with the on-chain program
 * logic across all fee/IGP shape combinations.
 */
describe('SVM warp ALT completeness via simulation — cross-collateral', function () {
  this.timeout(600_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let mailboxAddress: Address;
  let igpProgramId: Address;
  let igpConfig: IgpHookConfig;
  let collateralMint: Address;
  let senderAta: Address;
  let feeBeneficiaryOwner: Address;
  let feeBeneficiaryAta: Address;
  let warpProgramId: Address;

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
    igpConfig = {
      type: 'interchainGasPaymaster',
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
    senderAta = (
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
    // The beneficiary doesn't sign anything during transfer_remote_to,
    // so we only need its address — discard the keypair.
    feeBeneficiaryOwner = (await generateKeyPairSigner()).address;
    feeBeneficiaryAta = (
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
    const senderForIxs = address(signer.getSignerAddress());
    await signer.send({
      instructions: [
        await getTokenEnrollRemoteRoutersInstruction(
          warpProgramId,
          senderForIxs,
          [{ domain: DOMAIN_REMOTE, router: REMOTE_ROUTER }],
        ),
        await getTokenSetDestinationGasConfigsInstruction(
          warpProgramId,
          senderForIxs,
          [{ domain: DOMAIN_REMOTE, gas: REMOTE_GAS }],
        ),
      ],
    });
  });
});
