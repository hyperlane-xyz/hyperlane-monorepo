// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {Origin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {TypeCasts} from "../../../contracts/libs/TypeCasts.sol";
import {Message} from "../../../contracts/libs/Message.sol";
import {LibBit} from "../../../contracts/libs/LibBit.sol";
import {LayerZeroV2Ism} from "../../../contracts/isms/hook/layer-zero/LayerZeroV2Ism.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";

contract LayerZeroV2IsmTest is Test {
    using TypeCasts for address;
    using Message for bytes;
    using LibBit for uint256;

    LayerZeroV2Ism lZIsm;
    address endpoint;
    address hook;

    function _encodedFunctionCall(
        bytes32 _messageId
    ) internal pure returns (bytes memory) {
        return
            abi.encodeCall(
                AbstractMessageIdAuthorizedIsm.preVerifyMessage,
                (_messageId, 0)
            );
    }

    function setUp() public {
        endpoint = makeAddr("endpointAddr");
        hook = makeAddr("hook");
        lZIsm = new LayerZeroV2Ism(endpoint);
    }

    function _makeLzParameters(
        address _sender,
        bytes32 _guid,
        bytes memory _message,
        address _executor,
        bytes memory _extraData
    )
        internal
        pure
        returns (
            Origin memory origin,
            bytes32 guid,
            bytes memory message,
            address executor,
            bytes memory extraData
        )
    {
        origin = Origin(1, _sender.addressToBytes32(), 1);
        guid = _guid;
        message = _message;
        executor = _executor;
        extraData = _extraData;
    }

    function testLzV2Ism_lzReceive_RevertWhen_NotCalledByEndpoint(
        address _endpoint
    ) public {
        vm.assume(_endpoint != address(0));
        vm.assume(_endpoint != endpoint);
        lZIsm.setAuthorizedHook(hook.addressToBytes32());

        vm.startPrank(_endpoint);
        (
            Origin memory origin,
            bytes32 guid,
            bytes memory message,
            address executor,
            bytes memory extraData
        ) = _makeLzParameters(
                hook,
                bytes32(""),
                _encodedFunctionCall(bytes32("")),
                makeAddr("executor"),
                bytes("")
            );

        vm.expectRevert("LayerZeroV2Ism: endpoint is not authorized");
        lZIsm.lzReceive(origin, guid, message, executor, extraData);
        vm.stopPrank();

        // Set endpoint
        vm.prank(endpoint);
        lZIsm.lzReceive(
            origin,
            guid,
            _encodedFunctionCall(bytes32("")),
            executor,
            extraData
        );
    }

    function testLzV2Ism_lzReceive_RevertWhen_NotSentByHook(
        address _hook
    ) public {
        vm.assume(_hook != address(0));

        (
            Origin memory origin,
            bytes32 guid,
            bytes memory message,
            address executor,
            bytes memory extraData
        ) = _makeLzParameters(
                _hook,
                bytes32(""),
                _encodedFunctionCall(bytes32("")),
                makeAddr("executor"),
                bytes("")
            );

        vm.startPrank(endpoint);
        vm.expectRevert("LayerZeroV2Ism: hook is not authorized");
        lZIsm.lzReceive(origin, guid, message, executor, extraData);
        vm.stopPrank();

        // Set hook
        vm.startPrank(endpoint);
        lZIsm.setAuthorizedHook(_hook.addressToBytes32());

        lZIsm.lzReceive(
            origin,
            guid,
            _encodedFunctionCall(bytes32("")),
            executor,
            extraData
        );
        vm.stopPrank();
    }

    function testLzV2Ism_preVerifyMessage_SetsCorrectMessageId(
        bytes32 messageId
    ) public {
        lZIsm.setAuthorizedHook(hook.addressToBytes32());
        vm.startPrank(endpoint);
        (
            Origin memory origin,
            bytes32 guid,
            bytes memory message,
            address executor,
            bytes memory extraData
        ) = _makeLzParameters(
                hook,
                bytes32(""),
                _encodedFunctionCall(messageId),
                makeAddr("executor"),
                bytes("")
            );
        lZIsm.lzReceive(origin, guid, message, executor, extraData);
        vm.stopPrank();

        bool messageIdVerified = lZIsm.verifiedMessages(messageId).isBitSet(
            lZIsm.VERIFIED_MASK_INDEX()
        );
        assertTrue(messageIdVerified);
    }
}
