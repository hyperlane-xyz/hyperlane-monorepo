// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {Message} from "../../contracts/libs/Message.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {MockOptimismPortal} from "../../contracts/mock/MockOptimism.sol";
import {OpL1V1NativeTokenBridge} from "../../contracts/token/extensions/OPL2ToL1TokenBridgeNative.sol";
import {IOptimismPortal} from "../../contracts/interfaces/optimism/IOptimismPortal.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";
import {LightTestRecipient} from "../../contracts/test/LightTestRecipient.sol";
import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";
import {OPL2ToL1Withdrawal} from "../../contracts/libs/OPL2ToL1Withdrawal.sol";

contract OpL1V1NativeTokenBridgeTest is Test {
    using TypeCasts for address;
    using TokenMessage for bytes;
    using OPL2ToL1Withdrawal for IOptimismPortal.WithdrawalTransaction;

    address payable internal constant L2_BRIDGE_ADDRESS =
        payable(0x4200000000000000000000000000000000000010);

    uint256 internal constant scale = 1;

    uint32 internal constant origin = 1;
    uint32 internal constant destination = 2;

    address tokenBridgeOrigin;
    address tokenBridgeDestination;

    OpL1V1NativeTokenBridge internal ism;

    string[] urls;
    IOptimismPortal portal;
    MockHyperlaneEnvironment internal environment;
    MockMailbox mailboxOrigin;
    MockMailbox mailboxDestination;

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function setUp() public {
        urls = new string[](1);
        urls[0] = "https://ccip-read-gateway.io";
        environment = new MockHyperlaneEnvironment(origin, destination);
        mailboxOrigin = environment.mailboxes(origin);
        mailboxDestination = environment.mailboxes(destination);
        portal = new MockOptimismPortal();

        // We just need two contracts
        tokenBridgeOrigin = address(new LightTestRecipient());
        tokenBridgeDestination = address(new LightTestRecipient());

        ism = new OpL1V1NativeTokenBridge(
            address(mailboxDestination),
            address(portal)
        );

        mailboxDestination.setDefaultIsm(address(ism));
        mailboxDestination.addRemoteMailbox(origin, mailboxOrigin);
    }

    function test_constructor_revertsWhen_opPortalNotContract() public {
        address nonContract = address(0x123);
        vm.expectRevert("OPL2ToL1CcipReadIsm: invalid opPortal");
        new OpL1V1NativeTokenBridge(
            address(mailboxDestination),
            nonContract // Using a non-contract address for portal
        );
    }

    function test_verify_revertsWhen_mailboxTryToCallVerify() public {
        mailboxOrigin.dispatch(
            destination,
            address(ism).addressToBytes32(),
            bytes("")
        );

        uint256 nonce = mailboxDestination.inboundProcessedNonce();
        bytes memory message = mailboxDestination.inboundMessages(nonce);

        vm.expectRevert();
        environment.processNextPendingMessage();
    }

    function _getDummyVerifyMetadata(
        IOptimismPortal.WithdrawalTransaction memory _tx
    ) internal returns (bytes memory) {
        uint256 gameIndex = 0;
        IOptimismPortal.OutputRootProof memory outputRootProof;
        bytes[] memory proof;
        return abi.encode(_tx, gameIndex, outputRootProof, proof);
    }

    function _getDummyWithdrawalTx(
        uint256 nonce,
        uint256 amount,
        bytes memory data
    ) internal returns (IOptimismPortal.WithdrawalTransaction memory) {
        uint256 gasLimit = 200_000;

        return
            IOptimismPortal.WithdrawalTransaction(
                nonce,
                tokenBridgeOrigin,
                tokenBridgeDestination,
                amount,
                gasLimit,
                data
            );
    }

    function test_verify_proveWithdrawalSuccessfully(
        bytes32 _recipient,
        uint256 amount
    ) public {
        IOptimismPortal.WithdrawalTransaction
            memory withdrawalTx = _getDummyWithdrawalTx(0, amount, bytes(""));

        // amount 0 indicates prove message
        bytes memory messageBody = TokenMessage.format(_recipient, 0);
        mailboxOrigin.dispatch(
            destination,
            address(ism).addressToBytes32(),
            messageBody
        );

        bytes memory message = mailboxDestination.inboundMessages(0);
        bytes memory metadata = _getDummyVerifyMetadata(withdrawalTx);

        ism.verify(metadata, message);

        assert(
            portal.provenWithdrawals(withdrawalTx.hashWithdrawal()).timestamp !=
                0
        );
    }

    function test_verify_finalizeWithdrawalSuccessfully(
        bytes32 _recipient,
        uint256 amount
    ) public {
        vm.assume(amount > 0);

        IOptimismPortal.WithdrawalTransaction
            memory withdrawalTx = _getDummyWithdrawalTx(0, amount, bytes(""));

        bytes memory messageBody = TokenMessage.format(_recipient, amount);
        mailboxOrigin.dispatch(
            destination,
            address(tokenBridgeDestination).addressToBytes32(),
            messageBody
        );

        vm.deal(address(portal), amount);

        bytes memory message = mailboxDestination.inboundMessages(0);
        bytes memory metadata = _getDummyVerifyMetadata(withdrawalTx);

        ism.verify(metadata, message);

        assertEq(
            portal.finalizedWithdrawals(withdrawalTx.hashWithdrawal()),
            true
        );
    }

    function test_interchainSecurityModule_givenIsmIsCorrect() public {
        assertEq(address(ism.interchainSecurityModule()), address(ism));
    }
}
