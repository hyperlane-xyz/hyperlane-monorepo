// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MessageUtils} from "./IsmTestUtils.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {ArbL2ToL1Hook} from "../../contracts/hooks/ArbL2ToL1Hook.sol";
import {ArbL2ToL1Ism} from "../../contracts/isms/hook/ArbL2ToL1Ism.sol";
import {MockArbBridge, MockArbSys} from "../../contracts/mock/MockArbBridge.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {ExternalBridgeTest} from "./ExternalBridgeTest.sol";

contract ArbL2ToL1IsmTest is ExternalBridgeTest {
    uint256 internal constant MOCK_LEAF_INDEX = 40160;
    uint256 internal constant MOCK_L2_BLOCK = 54220000;
    uint256 internal constant MOCK_L1_BLOCK = 6098300;

    address internal constant L2_ARBSYS_ADDRESS =
        0x0000000000000000000000000000000000000064;

    MockArbBridge internal arbBridge;

    function setUp() public override {
        ORIGIN_DOMAIN = 42161;
        DESTINATION_DOMAIN = 1;
        GAS_QUOTE = 120_000;
        super.setUp();

        // Arbitrum bridge mock setup
        vm.etch(L2_ARBSYS_ADDRESS, address(new MockArbSys()).code);

        deployAll();
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployHook() public {
        originMailbox = new TestMailbox(ORIGIN_DOMAIN);
        hook = new ArbL2ToL1Hook(
            address(originMailbox),
            DESTINATION_DOMAIN,
            TypeCasts.addressToBytes32(address(ism)),
            L2_ARBSYS_ADDRESS,
            GAS_QUOTE
        );
    }

    function deployIsm() public {
        arbBridge = new MockArbBridge();
        ism = new ArbL2ToL1Ism(address(arbBridge));
    }

    function deployAll() public {
        deployIsm();
        deployHook();

        arbBridge.setL2ToL1Sender(address(hook));
        ism.setAuthorizedHook(TypeCasts.addressToBytes32(address(hook)));
    }

    /* ============ helper functions ============ */

    function _expectOriginExternalBridgeCall(
        bytes memory _encodedHookData
    ) internal override {
        vm.expectCall(
            L2_ARBSYS_ADDRESS,
            abi.encodeCall(
                MockArbSys.sendTxToL1,
                (address(ism), _encodedHookData)
            )
        );
    }

    function _encodeExternalDestinationBridgeCall(
        address _from,
        address _to,
        uint256 _msgValue,
        bytes32 _messageId
    ) internal override returns (bytes memory) {
        vm.deal(address(arbBridge), _msgValue);
        return _encodeOutboxTx(_from, _to, _messageId, _msgValue);
    }

    function _externalBridgeDestinationCall(
        bytes memory _encodedHookData,
        uint256 _msgValue
    ) internal override {
        vm.deal(address(arbBridge), _msgValue);
        arbBridge.executeTransaction(
            new bytes32[](0),
            MOCK_LEAF_INDEX,
            address(hook),
            address(ism),
            MOCK_L2_BLOCK,
            MOCK_L1_BLOCK,
            block.timestamp,
            _msgValue,
            _encodedHookData
        );
    }

    function _setExternalOriginSender(address _sender) internal override {
        unauthorizedHookError = "ArbL2ToL1Ism: l2Sender != authorizedHook";
        arbBridge.setL2ToL1Sender(_sender);
    }

    function _encodeOutboxTx(
        address _hook,
        address _ism,
        bytes32 _messageId,
        uint256 _value
    ) internal view returns (bytes memory) {
        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (_messageId)
        );

        bytes32[] memory proof = new bytes32[](16);
        return
            abi.encode(
                proof,
                MOCK_LEAF_INDEX,
                _hook,
                _ism,
                MOCK_L2_BLOCK,
                MOCK_L1_BLOCK,
                block.timestamp,
                _value,
                encodedHookData
            );
    }
}
