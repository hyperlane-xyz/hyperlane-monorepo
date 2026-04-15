import { expect } from 'chai';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { assert, eqAddressStarknet } from '@hyperlane-xyz/utils';

import { type ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';

import { StarknetSigner } from '../clients/signer.js';
import { StarknetIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { StarknetMailboxArtifactManager } from '../mailbox/mailbox-artifact-manager.js';
import { StarknetWarpArtifactManager } from '../warp/warp-artifact-manager.js';
import {
  DEFAULT_E2E_TEST_TIMEOUT,
  TEST_STARKNET_CHAIN_METADATA,
} from '../testing/constants.js';
import { createSigner } from '../testing/utils.js';

describe('5a. starknet sdk warp core e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let signer: StarknetSigner;

  before(async () => {
    signer = await createSigner();
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

  it('creates and reads native token', async () => {
    const mailboxAddress = await createMailbox();
    const warpArtifactManager = new StarknetWarpArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
    );
    const [nativeToken] = await warpArtifactManager
      .createWriter('native', signer)
      .create({
        config: {
          type: AltVM.TokenType.native,
          owner: signer.getSignerAddress(),
          mailbox: mailboxAddress,
          remoteRouters: {},
          destinationGas: {},
        },
      });
    const readToken = await warpArtifactManager.readWarpToken(
      nativeToken.deployed.address,
    );
    expect(readToken.config.type).to.equal(AltVM.TokenType.native);
    expect(
      eqAddressStarknet(readToken.config.owner, signer.getSignerAddress()),
    ).to.equal(true);
    expect(
      eqAddressStarknet(readToken.config.mailbox, mailboxAddress),
    ).to.equal(true);
  });

  it('creates and reads synthetic token', async () => {
    const mailboxAddress = await createMailbox();
    const warpArtifactManager = new StarknetWarpArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
    );
    const [syntheticToken] = await warpArtifactManager
      .createWriter('synthetic', signer)
      .create({
        config: {
          type: AltVM.TokenType.synthetic,
          owner: signer.getSignerAddress(),
          mailbox: mailboxAddress,
          name: 'TEST',
          symbol: 'TEST',
          decimals: 18,
          remoteRouters: {},
          destinationGas: {},
        },
      });

    const readToken = await warpArtifactManager.readWarpToken(
      syntheticToken.deployed.address,
    );
    expect(readToken.config.type).to.equal(AltVM.TokenType.synthetic);
    expect(
      eqAddressStarknet(readToken.config.owner, signer.getSignerAddress()),
    ).to.equal(true);
    expect(
      eqAddressStarknet(readToken.config.mailbox, mailboxAddress),
    ).to.equal(true);
    expect(readToken.config.decimals).to.equal(18);
  });

  it('creates and reads collateral token', async () => {
    const mailboxAddress = await createMailbox();
    const collateralDenom = TEST_STARKNET_CHAIN_METADATA.nativeToken?.denom;
    assert(collateralDenom, 'Expected Starknet test collateral denom');

    const warpArtifactManager = new StarknetWarpArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
    );
    const [collateralToken] = await warpArtifactManager
      .createWriter('collateral', signer)
      .create({
        config: {
          type: AltVM.TokenType.collateral,
          owner: signer.getSignerAddress(),
          mailbox: mailboxAddress,
          token: collateralDenom,
          remoteRouters: {},
          destinationGas: {},
        },
      });

    const collateralReader = warpArtifactManager.createReader('collateral');
    const readToken = await collateralReader.read(
      collateralToken.deployed.address,
    );
    expect(readToken.config.type).to.equal(AltVM.TokenType.collateral);
    expect(
      eqAddressStarknet(readToken.config.owner, signer.getSignerAddress()),
    ).to.equal(true);
    expect(
      eqAddressStarknet(readToken.config.mailbox, mailboxAddress),
    ).to.equal(true);
    expect(eqAddressStarknet(readToken.config.token, collateralDenom)).to.equal(
      true,
    );
  });

  it('sets token ism/hook/owner', async () => {
    const mailboxAddress = await createMailbox();

    const warpArtifactManager = new StarknetWarpArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
    );
    const warpWriter = warpArtifactManager.createWriter('native', signer);
    const [nativeToken] = await warpWriter.create({
      config: {
        type: AltVM.TokenType.native,
        owner: signer.getSignerAddress(),
        mailbox: mailboxAddress,
        remoteRouters: {},
        destinationGas: {},
      },
    });
    const tokenAddress = nativeToken.deployed.address;

    const ismAM = new StarknetIsmArtifactManager(TEST_STARKNET_CHAIN_METADATA);
    const [ismResult] = await ismAM
      .createWriter(AltVM.IsmType.TEST_ISM, signer)
      .create({ config: { type: AltVM.IsmType.TEST_ISM } });
    const ismAddress = ismResult.deployed.address;

    const hookTx = await signer.getCreateNoopHookTransaction({
      signer: signer.getSignerAddress(),
      mailboxAddress,
    });
    const hookReceipt = await signer.sendAndConfirmTransaction(hookTx);
    assert(hookReceipt.contractAddress, 'failed to deploy noop hook');
    const hookAddress = hookReceipt.contractAddress;

    const newOwner = '0x777';
    const genericSigner: ISigner<AnnotatedTx, TxReceipt> = signer;
    const updateTxs = await warpWriter.update({
      ...nativeToken,
      config: {
        ...nativeToken.config,
        interchainSecurityModule: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ismAddress },
        },
        hook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: hookAddress },
        },
        owner: newOwner,
      },
    });
    for (const tx of updateTxs) {
      await genericSigner.sendAndConfirmTransaction(tx);
    }

    const readToken = await warpWriter.read(tokenAddress);
    const ismOnChain = readToken.config.interchainSecurityModule;
    const hookOnChain = readToken.config.hook;
    expect(
      ismOnChain && eqAddressStarknet(ismOnChain.deployed.address, ismAddress),
    ).to.equal(true);
    expect(
      hookOnChain &&
        eqAddressStarknet(hookOnChain.deployed.address, hookAddress),
    ).to.equal(true);
    expect(eqAddressStarknet(readToken.config.owner, newOwner)).to.equal(true);
  });

  it('enrolls and unenrolls remote router', async () => {
    const mailboxAddress = await createMailbox();

    const warpArtifactManager = new StarknetWarpArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
    );
    const warpWriter = warpArtifactManager.createWriter('native', signer);
    const [nativeToken] = await warpWriter.create({
      config: {
        type: AltVM.TokenType.native,
        owner: signer.getSignerAddress(),
        mailbox: mailboxAddress,
        remoteRouters: {},
        destinationGas: {},
      },
    });
    const tokenAddress = nativeToken.deployed.address;

    const emptyRead = await warpWriter.read(tokenAddress);
    expect(Object.keys(emptyRead.config.remoteRouters)).to.have.length(0);

    const genericSigner: ISigner<AnnotatedTx, TxReceipt> = signer;
    const enrollTxs = await warpWriter.update({
      ...nativeToken,
      config: {
        ...nativeToken.config,
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

    const enrolledRead = await warpWriter.read(tokenAddress);
    expect(Object.keys(enrolledRead.config.remoteRouters)).to.have.length(1);
    const enrolledRouter = enrolledRead.config.remoteRouters[1234];
    assert(enrolledRouter, 'Expected remote router for domain 1234');
    expect(
      eqAddressStarknet(enrolledRouter.address, signer.getSignerAddress()),
    ).to.equal(true);

    const unenrollTxs = await warpWriter.update({
      ...nativeToken,
      config: {
        ...nativeToken.config,
        remoteRouters: {},
        destinationGas: {},
      },
    });
    for (const tx of unenrollTxs) {
      await genericSigner.sendAndConfirmTransaction(tx);
    }

    const clearedRead = await warpWriter.read(tokenAddress);
    expect(Object.keys(clearedRead.config.remoteRouters)).to.have.length(0);
  });
});
