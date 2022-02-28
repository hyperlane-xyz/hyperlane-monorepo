import { expect } from 'chai';
import { ethers, bridge, abacus } from 'hardhat';
import { BigNumber, BytesLike } from 'ethers';

import * as types from './lib/types';
import { BridgeDeployment } from './lib/BridgeDeployment';
import { AbacusDeployment } from '@abacus-network/abacus-sol/test/lib/AbacusDeployment';
import { Signer } from '@abacus-network/abacus-sol/test/lib/types';
import { stringToBytes32, toBytes32 } from '@abacus-network/abacus-sol/test/lib/utils';
import { BridgeToken, BridgeToken__factory, IERC20 } from '../typechain';

const { BridgeMessageTypes } = bridge;
const localDomain = 1000;
const remoteDomain = 2000;
const domains = [localDomain, remoteDomain];
const testToken = `0x${'11'.repeat(32)}`;
const testTokenId = {
  domain: remoteDomain,
  id: testToken,
};

describe('BridgeRouter', async () => {
  let abacusDeployment: AbacusDeployment;
  let bridgeDeployment: BridgeDeployment;
  let deployer: Signer;
  let deployerAddress: string;
  let deployerId: BytesLike;

  const PROTOCOL_PROCESS_GAS = 800_000;

  // Numerical token value
  const TOKEN_VALUE = 0xffff;

  before(async () => {
    // populate deployer signer
    [deployer] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
    deployerId = toBytes32(await deployer.getAddress()).toLowerCase();
    abacusDeployment = await abacus.deployment.fromDomains(domains, deployer);
    // Enroll ourselves as a replica so we can send messages directly to the
    // local router.
    await abacusDeployment
      .connectionManager(localDomain)
      .ownerEnrollReplica(deployerAddress, remoteDomain);
  });

  beforeEach(async () => {
    bridgeDeployment = await BridgeDeployment.fromAbacusDeployment(
      abacusDeployment,
      deployer,
    );
    // Enroll ourselves as a router so we can send messages directly to the
    // local router.
    await bridgeDeployment
      .router(localDomain)
      .enrollRemoteRouter(remoteDomain, deployerId);
  });

  describe('invalid messages', async () => {
    it('rejects invalid messages', async () => {
      const handleTx = bridgeDeployment
        .router(localDomain)
        .handle(remoteDomain, deployerId, '0x', {
          gasLimit: PROTOCOL_PROCESS_GAS,
        });
      await expect(handleTx).to.be.reverted;
    });
  });

  describe('transfer message', async () => {
    describe('remotely-originating asset roundtrup', async () => {
      let transferMessage: BytesLike;
      let repr: IERC20;
      let handleTx: any;

      beforeEach(async () => {
        // generate transfer action
        const transferMessageObj: types.Message = {
          tokenId: testTokenId,
          action: {
            type: BridgeMessageTypes.TRANSFER,
            recipient: deployerId,
            amount: TOKEN_VALUE,
          },
        };
        transferMessage = bridge.serializeMessage(transferMessageObj);

        // Send a message to the local BridgeRouter triggering a BridgeToken
        // deployment.
        handleTx = await bridgeDeployment
          .router(localDomain)
          .handle(remoteDomain, deployerId, transferMessage, {
            gasLimit: PROTOCOL_PROCESS_GAS,
          });
        repr = await bridgeDeployment.bridgeToken(
          localDomain,
          remoteDomain,
          testToken,
        );
      });

      it('deploys a token on first inbound transfer', async () => {
        await expect(handleTx).to.emit(
          bridgeDeployment.router(localDomain),
          'TokenDeployed',
        );
        await expect(handleTx).to.emit(
          abacusDeployment.home(localDomain),
          'Dispatch',
        );
        expect(await repr.balanceOf(deployer.address)).to.equal(
          BigNumber.from(TOKEN_VALUE),
        );
        expect(await repr.totalSupply()).to.equal(BigNumber.from(TOKEN_VALUE));
      });

      it('errors on send if ERC20 balance is insufficient', async () => {
        const stealTx = bridgeDeployment
          .router(localDomain)
          .send(repr.address, TOKEN_VALUE * 10, remoteDomain, deployerId);

        await expect(stealTx).to.be.revertedWith(
          'ERC20: burn amount exceeds balance',
        );
      });

      it('errors when missing a remote router', async () => {
        expect(
          bridgeDeployment
            .router(localDomain)
            .send(repr.address, TOKEN_VALUE * 10, 121234, deployerId),
        ).to.be.revertedWith('!remote');
      });

      it('errors on send when recipient is the 0 address', async () => {
        expect(
          bridgeDeployment
            .router(localDomain)
            .send(
              repr.address,
              TOKEN_VALUE * 10,
              remoteDomain,
              `0x${'00'.repeat(32)}`,
            ),
        ).to.be.revertedWith('!recip');
      });

      it('errors on send if ERC20 amount is zero', async () => {
        const zeroTx = bridgeDeployment
          .router(localDomain)
          .send(repr.address, 0, remoteDomain, deployerId);

        await expect(zeroTx).to.be.revertedWith('!amnt');
      });

      it('errors on send if remote router is unknown', async () => {
        const unknownRemote = bridgeDeployment
          .router(localDomain)
          .send(repr.address, 1, 3000, deployerId);

        await expect(unknownRemote).to.be.revertedWith('!remote');
      });

      it('burns tokens on outbound message', async () => {
        // OUTBOUND
        const sendTx = bridgeDeployment
          .router(localDomain)
          .send(repr.address, TOKEN_VALUE, remoteDomain, deployerId);

        await expect(sendTx).to.emit(
          abacusDeployment.home(localDomain),
          'Dispatch',
        );

        expect(await repr.totalSupply()).to.equal(BigNumber.from(0));
      });

      it('errors on outbound messages with not enough balance', async () => {
        // OUTBOUND, NOT ENOUGH Tokens
        const badTx = bridgeDeployment
          .router(localDomain)
          .send(repr.address, TOKEN_VALUE + 1, remoteDomain, deployerId);
        await expect(badTx).to.be.revertedWith(
          'ERC20: burn amount exceeds balance',
        );
      });
    });

    describe('locally-originating asset roundtrip', async () => {
      let transferMessage: string;
      let localToken: BridgeToken;

      beforeEach(async () => {
        localToken = await new BridgeToken__factory(deployer).deploy();
        await localToken.initialize();
        await localToken.mint(deployerAddress, TOKEN_VALUE);

        // generate protocol messages
        const transferMessageObj: types.Message = {
          tokenId: {
            domain: localDomain,
            id: toBytes32(localToken.address),
          },
          action: {
            type: BridgeMessageTypes.TRANSFER,
            recipient: deployerId,
            amount: TOKEN_VALUE,
          },
        };
        transferMessage = bridge.serializeMessage(transferMessageObj);

        expect(await localToken.balanceOf(deployerAddress)).to.equal(
          BigNumber.from(TOKEN_VALUE),
        );
        expect(
          await localToken.balanceOf(
            bridgeDeployment.router(localDomain).address,
          ),
        ).to.equal(BigNumber.from(0));
      });

      it('errors if the token is not approved', async () => {
        // TOKEN NOT APPROVED
        const unapproved = bridgeDeployment
          .router(localDomain)
          .send(localToken.address, 1, remoteDomain, deployerId);

        expect(unapproved).to.be.revertedWith(
          'ERC20: transfer amount exceeds allowance',
        );
        expect(
          await localToken.balanceOf(
            bridgeDeployment.router(localDomain).address,
          ),
        ).to.equal(BigNumber.from(0));
      });

      it('errors if insufficient balance', async () => {
        await localToken.approve(
          bridgeDeployment.router(localDomain).address,
          ethers.constants.MaxUint256,
        );

        const badTx = bridgeDeployment
          .router(localDomain)
          .send(localToken.address, TOKEN_VALUE + 1, remoteDomain, deployerId);

        expect(badTx).to.be.revertedWith(
          'ERC20: transfer amount exceeds balance',
        );
        expect(
          await localToken.balanceOf(
            bridgeDeployment.router(localDomain).address,
          ),
        ).to.equal(BigNumber.from(0));
      });

      it('holds tokens on outbound transfer', async () => {
        await localToken.approve(
          bridgeDeployment.router(localDomain).address,
          ethers.constants.MaxUint256,
        );

        const sendTx = await bridgeDeployment
          .router(localDomain)
          .send(localToken.address, TOKEN_VALUE, remoteDomain, deployerId);

        await expect(sendTx).to.emit(
          abacusDeployment.home(localDomain),
          'Dispatch',
        );

        expect(
          await localToken.balanceOf(
            bridgeDeployment.router(localDomain).address,
          ),
        ).to.equal(BigNumber.from(TOKEN_VALUE));
      });

      it('unlocks tokens on inbound transfer', async () => {
        await localToken.approve(
          bridgeDeployment.router(localDomain).address,
          ethers.constants.MaxUint256,
        );

        const sendTx = await bridgeDeployment
          .router(localDomain)
          .send(localToken.address, TOKEN_VALUE, remoteDomain, deployerId);

        let handleTx = await bridgeDeployment
          .router(localDomain)
          .handle(remoteDomain, deployerId, transferMessage, {
            gasLimit: PROTOCOL_PROCESS_GAS,
          });

        expect(handleTx).to.not.emit(
          bridgeDeployment.router(localDomain),
          'TokenDeployed',
        );

        expect(
          await localToken.balanceOf(
            bridgeDeployment.router(localDomain).address,
          ),
        ).to.equal(BigNumber.from(0));

        expect(await localToken.balanceOf(deployerAddress)).to.equal(
          BigNumber.from(TOKEN_VALUE),
        );
      });
    });
  });

  describe('prefill', async () => {
    it('errors for non-existing assets', async () => {
      // generate transfer action
      const transferMessageObj: types.Message = {
        tokenId: testTokenId,
        action: {
          type: BridgeMessageTypes.TRANSFER,
          recipient: deployerId,
          amount: TOKEN_VALUE,
        },
      };
      const transferMessage = bridge.serializeMessage(transferMessageObj);

      expect(
        bridgeDeployment.router(localDomain).preFill(transferMessage),
      ).to.be.revertedWith('!token');
    });

    describe('remotely-originating asset', async () => {
      let setupMessage: string;
      let repr: IERC20;
      let recipient: string;
      let recipientId: string;
      let transferMessage: string;

      beforeEach(async () => {
        // generate actions
        recipient = `0x${'00'.repeat(19)}ff`;
        recipientId = toBytes32(recipient);

        // transfer message
        const transferMessageObj: types.Message = {
          tokenId: testTokenId,
          action: {
            type: BridgeMessageTypes.TRANSFER,
            recipient: recipientId,
            amount: TOKEN_VALUE,
          },
        };
        transferMessage = bridge.serializeMessage(transferMessageObj);

        // setup message
        const setupMessageObj: types.Message = {
          tokenId: testTokenId,
          action: {
            type: BridgeMessageTypes.TRANSFER,
            recipient: deployerId,
            amount: TOKEN_VALUE,
          },
        };
        setupMessage = bridge.serializeMessage(setupMessageObj);

        // perform setup
        const setupTx = await bridgeDeployment
          .router(localDomain)
          .handle(remoteDomain, deployerId, setupMessage, {
            gasLimit: PROTOCOL_PROCESS_GAS,
          });

        await expect(setupTx).to.emit(
          bridgeDeployment.router(localDomain),
          'TokenDeployed',
        );

        repr = await bridgeDeployment.bridgeToken(
          localDomain,
          remoteDomain,
          testToken,
        );

        expect(await repr.balanceOf(deployerAddress)).to.equal(
          BigNumber.from(TOKEN_VALUE),
        );
        await repr.approve(
          bridgeDeployment.router(localDomain).address,
          ethers.constants.MaxUint256,
        );
      });

      it('transfers tokens on a prefill', async () => {
        const prefillTx = await bridgeDeployment
          .router(localDomain)
          .preFill(transferMessage);
        await expect(prefillTx)
          .to.emit(repr, 'Transfer')
          .withArgs(
            deployerAddress,
            recipient,
            BigNumber.from(TOKEN_VALUE).mul(9995).div(10000),
          );
      });

      it('mints tokens for the liquidity provider on message receipt', async () => {
        await bridgeDeployment.router(localDomain).preFill(transferMessage);
        let deliver = bridgeDeployment
          .router(localDomain)
          .handle(remoteDomain, deployerId, transferMessage, {
            gasLimit: PROTOCOL_PROCESS_GAS,
          });
        await expect(deliver)
          .to.emit(repr, 'Transfer')
          .withArgs(ethers.constants.AddressZero, deployerAddress, TOKEN_VALUE);
      });
    });

    describe('locally-originating asset', async () => {
      let localToken: BridgeToken;
      let recipient: string;
      let recipientId: string;
      let transferMessage: string;

      beforeEach(async () => {
        localToken = await new BridgeToken__factory(deployer).deploy();
        await localToken.initialize();
        await localToken.mint(deployerAddress, TOKEN_VALUE);
        await localToken.mint(
          bridgeDeployment.router(localDomain).address,
          TOKEN_VALUE,
        );
        await localToken.approve(
          bridgeDeployment.router(localDomain).address,
          ethers.constants.MaxUint256,
        );

        expect(await localToken.balanceOf(deployerAddress)).to.equal(
          BigNumber.from(TOKEN_VALUE),
        );
        expect(
          await localToken.balanceOf(
            bridgeDeployment.router(localDomain).address,
          ),
        ).to.equal(BigNumber.from(TOKEN_VALUE));

        // generate transfer action
        recipient = `0x${'00'.repeat(19)}ff`;
        recipientId = toBytes32(recipient);

        const transferMessageObj: types.Message = {
          tokenId: {
            domain: localDomain,
            id: toBytes32(localToken.address),
          },
          action: {
            type: BridgeMessageTypes.TRANSFER,
            recipient: recipientId,
            amount: TOKEN_VALUE,
          },
        };
        transferMessage = bridge.serializeMessage(transferMessageObj);
      });

      it('transfers tokens on prefill', async () => {
        const prefillTx = await bridgeDeployment
          .router(localDomain)
          .preFill(transferMessage);
        await expect(prefillTx)
          .to.emit(localToken, 'Transfer')
          .withArgs(
            deployerAddress,
            recipient,
            BigNumber.from(TOKEN_VALUE).mul(9995).div(10000),
          );
      });

      it('unlocks tokens on message receipt', async () => {
        await bridgeDeployment.router(localDomain).preFill(transferMessage);
        let deliver = bridgeDeployment
          .router(localDomain)
          .handle(remoteDomain, deployerId, transferMessage, {
            gasLimit: PROTOCOL_PROCESS_GAS,
          });
        await expect(deliver)
          .to.emit(localToken, 'Transfer')
          .withArgs(
            bridgeDeployment.router(localDomain).address,
            deployerAddress,
            TOKEN_VALUE,
          );
      });
    });
  });

  describe('details message', async () => {
    let localToken: BridgeToken;
    let requestMessage: string;
    let outgoingDetails: string;
    let incomingDetails: string;
    let transferMessage: string;
    let repr: BridgeToken;

    const TEST_NAME = 'TEST TOKEN';
    const TEST_SYMBOL = 'TEST';
    const TEST_DECIMALS = 8;

    beforeEach(async () => {
      localToken = await new BridgeToken__factory(deployer).deploy();
      await localToken.initialize();
      await localToken.setDetails(TEST_NAME, TEST_SYMBOL, TEST_DECIMALS);

      const requestMessageObj: types.Message = {
        tokenId: {
          domain: localDomain,
          id: toBytes32(localToken.address),
        },
        action: {
          type: BridgeMessageTypes.REQUEST_DETAILS,
        },
      };
      requestMessage = bridge.serializeMessage(requestMessageObj);

      const outgoingDetailsObj: types.Message = {
        tokenId: {
          domain: localDomain,
          id: toBytes32(localToken.address),
        },
        action: {
          type: BridgeMessageTypes.DETAILS,
          name: stringToBytes32(TEST_NAME),
          symbol: stringToBytes32(TEST_SYMBOL),
          decimals: TEST_DECIMALS,
        },
      };
      outgoingDetails = bridge.serializeMessage(outgoingDetailsObj);

      // generate transfer action
      const transferMessageObj: types.Message = {
        tokenId: testTokenId,
        action: {
          type: BridgeMessageTypes.TRANSFER,
          recipient: deployerId,
          amount: TOKEN_VALUE,
        },
      };
      transferMessage = bridge.serializeMessage(transferMessageObj);

      const incomingDetailsObj: types.Message = {
        tokenId: testTokenId,
        action: {
          type: BridgeMessageTypes.DETAILS,
          name: stringToBytes32(TEST_NAME),
          symbol: stringToBytes32(TEST_SYMBOL),
          decimals: TEST_DECIMALS,
        },
      };
      incomingDetails = bridge.serializeMessage(incomingDetailsObj);

      // first send in a transfer to create the repr
      await bridgeDeployment
        .router(localDomain)
        .handle(remoteDomain, deployerId, transferMessage);

      repr = await bridgeDeployment.bridgeToken(
        localDomain,
        remoteDomain,
        testToken,
      );
    });

    it('allows admins to dispatch requestDetails', async () => {
      const requestTx = await bridgeDeployment
        .router(localDomain)
        .requestDetails(remoteDomain, testToken);

      const requestDetailsObj: types.Message = {
        tokenId: testTokenId,
        action: {
          type: BridgeMessageTypes.REQUEST_DETAILS,
        },
      };
      const requestDetails = bridge.serializeMessage(requestDetailsObj);

      await expect(requestTx).to.emit(
        abacusDeployment.home(localDomain),
        'Dispatch',
      );
    });

    it('handles incoming requestDetails by dispatching a details message', async () => {
      const handleTx = bridgeDeployment
        .router(localDomain)
        .handle(remoteDomain, deployerId, requestMessage);

      await expect(handleTx).to.emit(
        abacusDeployment.home(localDomain),
        'Dispatch',
      );
    });

    it('errors if token is a repr', async () => {
      const badRequestObj: types.Message = {
        tokenId: {
          domain: localDomain,
          id: toBytes32(repr.address),
        },
        action: {
          type: BridgeMessageTypes.REQUEST_DETAILS,
        },
      };
      const badRequest = bridge.serializeMessage(badRequestObj);

      let badRequestTx = bridgeDeployment
        .router(localDomain)
        .handle(remoteDomain, deployerId, badRequest);

      await expect(badRequestTx).to.be.revertedWith('!local origin');
    });

    it('errors if no registered router for response', async () => {
      const badRequestObj: types.Message = {
        tokenId: {
          domain: localDomain,
          id: toBytes32(localToken.address),
        },
        action: {
          type: BridgeMessageTypes.REQUEST_DETAILS,
        },
      };
      const badRequest = bridge.serializeMessage(badRequestObj);

      let badRequestTx = bridgeDeployment
        .router(localDomain)
        .handle(3812, deployerId, badRequest);

      await expect(badRequestTx).to.be.revertedWith('!remote router');
    });

    it('sets details during details message handling', async () => {
      // repr should not be configured
      expect((await repr.name()).length).to.equal(15);
      expect((await repr.symbol()).length).to.equal(15);
      expect(await repr.decimals()).to.equal(18);

      await bridgeDeployment
        .router(localDomain)
        .handle(remoteDomain, deployerId, incomingDetails);

      expect(await repr.name()).to.equal(TEST_NAME);
      expect(await repr.symbol()).to.equal(TEST_SYMBOL);
      expect(await repr.decimals()).to.equal(TEST_DECIMALS);
    });
  });

  describe('custom token representations', async () => {
    let transferMessage: string;
    let defaultRepr: BridgeToken;
    let customRepr: BridgeToken;
    const VALUE = `0xffffffffffffffff`;

    beforeEach(async () => {
      // generate transfer action
      const transferMessageObj: types.Message = {
        tokenId: testTokenId,
        action: {
          type: BridgeMessageTypes.TRANSFER,
          recipient: deployerId,
          amount: VALUE,
        },
      };
      transferMessage = bridge.serializeMessage(transferMessageObj);

      // first send in a transfer to create the repr
      await bridgeDeployment
        .router(localDomain)
        .handle(remoteDomain, deployerId, transferMessage);

      defaultRepr = await bridgeDeployment.bridgeToken(
        localDomain,
        remoteDomain,
        testToken,
      );
      expect(await defaultRepr.balanceOf(deployerAddress)).to.equal(
        BigNumber.from(VALUE),
      );

      // setup custom
      customRepr = await new BridgeToken__factory(deployer).deploy();
      await customRepr.initialize();
      expect(await customRepr.balanceOf(deployerAddress)).to.equal(
        BigNumber.from(0),
      );
    });

    it('migrate errors if old === new', async () => {
      const migrate = bridgeDeployment
        .router(localDomain)
        .migrate(defaultRepr.address);
      await expect(migrate).to.be.revertedWith('!different');
    });

    it('migrate errors if custom token is not enrolled', async () => {
      const migrate = bridgeDeployment
        .router(localDomain)
        .migrate(customRepr.address);
      await expect(migrate).to.be.revertedWith('!repr');
    });

    it('errors if no mint/burn privileges', async () => {
      const enrollTx = bridgeDeployment
        .router(localDomain)
        .enrollCustom(remoteDomain, testToken, customRepr.address);

      await expect(enrollTx).to.be.revertedWith(
        'Ownable: caller is not the owner',
      );
    });
    describe('when registering a custom token', () => {
      beforeEach(async () => {
        await customRepr.transferOwnership(
          bridgeDeployment.router(localDomain).address,
        );

        const enrollTx = bridgeDeployment
          .router(localDomain)
          .enrollCustom(remoteDomain, testToken, customRepr.address);

        await expect(enrollTx).to.not.be.reverted;
      });

      it('registers the custom token', async () => {
        expect(
          (
            await bridgeDeployment.bridgeToken(
              localDomain,
              remoteDomain,
              testToken,
            )
          ).address,
        ).to.equal(customRepr.address);

        let [domain, token] = await bridgeDeployment
          .router(localDomain)
          .getCanonicalAddress(customRepr.address);
        expect(domain).to.equal(remoteDomain);
        expect(token).to.equal(testToken);

        [domain, token] = await bridgeDeployment
          .router(localDomain)
          .getCanonicalAddress(defaultRepr.address);
        expect(domain).to.equal(remoteDomain);
        expect(token).to.equal(testToken);
      });

      describe('when bridging a custom token', () => {
        let defaultBalance: BigNumber;
        beforeEach(async () => {
          defaultBalance = await defaultRepr.balanceOf(deployerAddress);
          // first send in a transfer to create the repr
          await bridgeDeployment
            .router(localDomain)
            .handle(remoteDomain, deployerId, transferMessage);
        });

        it('mints incoming tokens in the custom repr', async () => {
          // did not mint default
          expect(await defaultRepr.balanceOf(deployerAddress)).to.equal(
            defaultBalance,
          );
          // did mint custom
          expect(await customRepr.balanceOf(deployerAddress)).to.equal(
            BigNumber.from(VALUE),
          );
        });

        describe('when transferring a custom token', () => {
          it('allows outbound transfers of both assets', async () => {
            const smallTransfer: types.Message = {
              tokenId: testTokenId,
              action: {
                type: BridgeMessageTypes.TRANSFER,
                recipient: deployerId,
                amount: TOKEN_VALUE,
              },
            };
            const smallTransferMessage = bridge.serializeMessage(smallTransfer);

            const defaultSendTx = await bridgeDeployment
              .router(localDomain)
              .send(defaultRepr.address, TOKEN_VALUE, remoteDomain, deployerId);
            await expect(defaultSendTx).to.emit(
              abacusDeployment.home(localDomain),
              'Dispatch',
            );

            const customSendTx = await bridgeDeployment
              .router(localDomain)
              .send(customRepr.address, TOKEN_VALUE, remoteDomain, deployerId);
            await expect(customSendTx).to.emit(
              abacusDeployment.home(localDomain),
              'Dispatch',
            );
          });

          it('allows users to migrate', async () => {
            const defaultBalance = await defaultRepr.balanceOf(deployerAddress);
            const customBalance = await customRepr.balanceOf(deployerAddress);

            let migrateTx = bridgeDeployment
              .router(localDomain)
              .migrate(defaultRepr.address);

            await expect(migrateTx).to.not.be.reverted;

            expect(await defaultRepr.balanceOf(deployerAddress)).to.equal(
              ethers.constants.Zero,
            );
            expect(await customRepr.balanceOf(deployerAddress)).to.equal(
              defaultBalance.add(customBalance),
            );
          });
        });
      });
    });
  });
});
