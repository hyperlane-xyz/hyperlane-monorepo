import { expect } from 'chai';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { type ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import {
  type DeployedWarpAddress,
  type RawWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert } from '@hyperlane-xyz/utils';

import { StarknetSigner } from '../clients/signer.js';
import { StarknetIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { StarknetMailboxArtifactManager } from '../mailbox/mailbox-artifact-manager.js';
import { DEFAULT_E2E_TEST_TIMEOUT } from '../testing/constants.js';
import { TEST_STARKNET_CHAIN_METADATA } from '../testing/index.js';
import { createSigner } from '../testing/utils.js';
import { StarknetWarpArtifactManager } from '../warp/warp-artifact-manager.js';

describe('5b. starknet sdk warp transfer e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let signer: StarknetSigner;
  let genericSigner: ISigner<AnnotatedTx, TxReceipt>;

  before(async () => {
    signer = await createSigner();
    genericSigner = signer;
  });

  async function createMailbox() {
    const ismArtifactManager = new StarknetIsmArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
    );
    const [ism] = await ismArtifactManager
      .createWriter(AltVM.IsmType.TEST_ISM, signer)
      .create({ config: { type: AltVM.IsmType.TEST_ISM } });

    const hookTx = await signer.getCreateNoopHookTransaction({
      signer: signer.getSignerAddress(),
      mailboxAddress: signer.getSignerAddress(),
    });
    const hookReceipt = await signer.sendAndConfirmTransaction(hookTx);
    assert(hookReceipt.contractAddress, 'failed to deploy noop hook');
    const hookAddress = hookReceipt.contractAddress;

    const mailboxArtifactManager = new StarknetMailboxArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
    );
    const [mailbox] = await mailboxArtifactManager
      .createWriter('mailbox', signer)
      .create({
        config: {
          owner: signer.getSignerAddress(),
          defaultIsm: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: ism.deployed.address },
          },
          defaultHook: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: hookAddress },
          },
          requiredHook: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: hookAddress },
          },
        },
      });
    return mailbox.deployed.address;
  }

  async function assertRemoteTransfer<C extends RawWarpArtifactConfig>(
    tokenAddress: string,
    mailboxAddress: string,
    warpWriter: {
      update: (
        artifact: ArtifactDeployed<C, DeployedWarpAddress>,
      ) => Promise<AnnotatedTx[]>;
      read: (
        address: string,
      ) => Promise<ArtifactDeployed<C, DeployedWarpAddress>>;
    },
  ) {
    // Enroll remote router via artifact writer
    const currentToken = await warpWriter.read(tokenAddress);
    const enrollTxs = await warpWriter.update({
      ...currentToken,
      config: {
        ...currentToken.config,
        remoteRouters: {
          1234: { address: signer.getSignerAddress() },
        },
        destinationGas: {
          1234: '200000',
        },
      },
    });
    for (const tx of enrollTxs) {
      await genericSigner.sendAndConfirmTransaction(tx);
    }

    const quote = await signer.quoteRemoteTransfer({
      tokenAddress,
      destinationDomainId: 1234,
    });
    const token = await signer.getToken({ tokenAddress });
    expect(typeof quote.amount).to.equal('bigint');
    expect(quote.denom).to.not.equal('');

    const [beforeMailbox, beforeSenderBalance, beforeEscrowBalance] =
      await Promise.all([
        signer.getMailbox({ mailboxAddress }),
        signer.getBalance({
          denom: token.denom,
          address: signer.getSignerAddress(),
        }),
        signer.getBalance({
          denom: token.denom,
          address: tokenAddress,
        }),
      ]);

    // remoteTransfer kept as action method — it batches token approvals
    await signer.remoteTransfer({
      tokenAddress,
      destinationDomainId: 1234,
      recipient: signer.getSignerAddress(),
      amount: '1',
      gasLimit: '200000',
      maxFee: {
        denom: quote.denom,
        amount: quote.amount.toString(),
      },
    });

    const [afterMailbox, afterSenderBalance, afterEscrowBalance] =
      await Promise.all([
        signer.getMailbox({ mailboxAddress }),
        signer.getBalance({
          denom: token.denom,
          address: signer.getSignerAddress(),
        }),
        signer.getBalance({
          denom: token.denom,
          address: tokenAddress,
        }),
      ]);
    expect(afterMailbox.nonce).to.equal(beforeMailbox.nonce + 1);
    expect(afterSenderBalance < beforeSenderBalance).to.equal(true);
    expect(afterEscrowBalance > beforeEscrowBalance).to.equal(true);
  }

  it('quotes and executes native remote transfer', async () => {
    const mailboxAddress = await createMailbox();
    const warpArtifactManager = new StarknetWarpArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
    );
    const writer = warpArtifactManager.createWriter('native', signer);
    const [nativeToken] = await writer.create({
      config: {
        type: AltVM.TokenType.native,
        owner: signer.getSignerAddress(),
        mailbox: mailboxAddress,
        remoteRouters: {},
        destinationGas: {},
      },
    });

    await assertRemoteTransfer(
      nativeToken.deployed.address,
      mailboxAddress,
      writer,
    );
  });

  it('quotes and executes collateral remote transfer', async () => {
    const mailboxAddress = await createMailbox();
    const collateralDenom = TEST_STARKNET_CHAIN_METADATA.nativeToken?.denom;
    assert(collateralDenom, 'Expected Starknet test collateral denom');

    const warpArtifactManager = new StarknetWarpArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
    );
    const writer = warpArtifactManager.createWriter('collateral', signer);
    const [collateralToken] = await writer.create({
      config: {
        type: AltVM.TokenType.collateral,
        owner: signer.getSignerAddress(),
        mailbox: mailboxAddress,
        token: collateralDenom,
        remoteRouters: {},
        destinationGas: {},
      },
    });

    await assertRemoteTransfer(
      collateralToken.deployed.address,
      mailboxAddress,
      writer,
    );
  });
});
