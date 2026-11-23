// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/console.sol";

import {LibBit} from "../../contracts/libs/LibBit.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {MockArbSys, MockArbitrumInbox} from "../../contracts/mock/MockArbBridge.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MessageUtils} from "./IsmTestUtils.sol";
import {ArbitrumOrbitIsm} from "../../contracts/isms/hook/ArbitrumOrbitIsm.sol";
import {ArbitrumOrbitHook} from "../../contracts/hooks/ArbitrumOrbitHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {IInbox} from "@arbitrum/nitro-contracts/src/bridge/IInbox.sol";
import {NotCrossChainCall} from "@openzeppelin/contracts/crosschain/errors.sol";
import {ExternalBridgeTest} from "./ExternalBridgeTest.sol";

contract ArbitrumOrbitIsmTest is ExternalBridgeTest {
    using LibBit for uint256;
    using TypeCasts for address;
    using MessageUtils for bytes;

    address internal constant L1_INBOX_ADDRESS =
        0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f;
    address internal constant L2_ARBSYS_ADDRESS =
        0x0000000000000000000000000000000000000064;

    uint256 internal constant DEFAULT_GAS_LIMIT = 300_000;
    uint256 internal constant DEFAULT_MAX_FEE_PER_GAS = 100_000_000;
    uint256 internal constant SUBMISSION_FEE = 0.001 ether;

    MockArbitrumInbox internal mockInbox;
    MockArbSys internal mockArbSys;

    function setUp() public override {
        // Setup mock L1 Inbox
        vm.etch(
            L1_INBOX_ADDRESS,
            address(new MockArbitrumInbox()).code
        );
        mockInbox = MockArbitrumInbox(L1_INBOX_ADDRESS);
        mockInbox.setSubmissionFee(SUBMISSION_FEE);

        // Setup mock L2 ArbSys at precompile address
        vm.etch(
            L2_ARBSYS_ADDRESS,
            address(new MockArbSys()).code
        );
        mockArbSys = MockArbSys(L2_ARBSYS_ADDRESS);

        // testMetadata specifies gasLimit = 0 (unset), so hook uses DEFAULT_GAS_LIMIT
        GAS_QUOTE = SUBMISSION_FEE + (DEFAULT_GAS_LIMIT * DEFAULT_MAX_FEE_PER_GAS);

        deployAll();
        super.setUp();
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployHook() public {
        originMailbox = new TestMailbox(ORIGIN_DOMAIN);
        hook = new ArbitrumOrbitHook(
            address(originMailbox),
            DESTINATION_DOMAIN,
            TypeCasts.addressToBytes32(address(ism)),
            L1_INBOX_ADDRESS,
            address(0) // no gas oracle, use default max fee per gas
        );
    }

    function deployIsm() public {
        ism = new ArbitrumOrbitIsm();
    }

    function deployAll() public {
        deployIsm();
        deployHook();

        ism.setAuthorizedHook(TypeCasts.addressToBytes32(address(hook)));
        mockArbSys.setCallerWithoutAliasing(address(hook), true);
    }

    function test_verify_revertWhen_invalidMetadata() public override {
        assertFalse(ism.verify(new bytes(0), encodedMessage));
    }

    function test_verify_revertsWhen_incorrectMessageId() public override {
        bytes32 incorrectMessageId = keccak256("incorrect message id");

        _externalBridgeDestinationCall(
            _encodeHookData(incorrectMessageId, 0),
            0
        );
        assertFalse(ism.isVerified(testMessage));
    }

    function test_verify_revertsWhen_notAuthorizedHook() public override {
        // Needs to be a cross-chain call
        mockArbSys.setCallerWithoutAliasing(address(hook), false);
        vm.expectRevert(NotCrossChainCall.selector);
        ism.preVerifyMessage(messageId, 0);

        // Needs to be called by the authorized hook contract
        mockArbSys.setCallerWithoutAliasing(address(this), true);
        vm.expectRevert(
            "AbstractMessageIdAuthorizedIsm: sender is not the hook"
        );
        ism.preVerifyMessage(messageId, 0);

        // Restore authorized hook
        mockArbSys.setCallerWithoutAliasing(address(hook), true);
    }

    /* ============ helper functions ============ */

    function _expectOriginExternalBridgeCall(
        bytes memory _encodedHookData
    ) internal override {
        vm.expectCall(
            L1_INBOX_ADDRESS,
            abi.encodeCall(
                IInbox.createRetryableTicket,
                (
                    address(ism),
                    0,
                    SUBMISSION_FEE,
                    address(this),
                    address(this),
                    DEFAULT_GAS_LIMIT,
                    DEFAULT_MAX_FEE_PER_GAS,
                    _encodedHookData
                )
            )
        );
    }

    function _externalBridgeDestinationCall(
        bytes memory _encodedHookData,
        uint256 _msgValue
    ) internal override {
        vm.deal(address(this), _msgValue);
        (bool success, bytes memory returnData) = address(ism).call{
            value: _msgValue
        }(_encodedHookData);
        if (!success) {
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }
    }

    function _encodeExternalDestinationBridgeCall(
        address /*_from*/,
        address /*_to*/,
        uint256 /*_msgValue*/,
        bytes32 /*_messageId*/
    ) internal pure override returns (bytes memory) {
        return new bytes(0);
    }

    // SKIP - no outbox proof required for L1->L2 retryable tickets
    function test_preVerifyMessage_externalBridgeCall() public override {}

    function test_verify_msgValue_externalBridgeCall() public override {}

    function test_verify_revertsWhen_invalidIsm() public override {}

    function test_verify_false_arbitraryCall() public override {}
}
