// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {Origin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {TypeCasts} from "../../../contracts/libs/TypeCasts.sol";
import {Message} from "../../../contracts/libs/Message.sol";
import {LayerZeroV2Ism} from "../../../contracts/isms/hook/layer-zero/LayerZeroV2Ism.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import "forge-std/console.sol";

contract LayerZeroV2IsmTest is Test {
    using TypeCasts for address;
    using Message for bytes;
    LayerZeroV2Ism lZIsm;
    address endpoint;
    address hook;

    bytes constant encodedFunctionCall =
        abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (bytes32(""))
        );

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
                bytes(""),
                makeAddr("executor"),
                bytes("")
            );

        vm.expectRevert("LayerZeroV2Ism: endpoint is not authorized");
        lZIsm.lzReceive(origin, guid, message, executor, extraData);
        vm.stopPrank();

        // Set endpoint
        vm.prank(endpoint);
        lZIsm.lzReceive(origin, guid, encodedFunctionCall, executor, extraData);
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
                bytes(""),
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

        lZIsm.lzReceive(origin, guid, encodedFunctionCall, executor, extraData);
        vm.stopPrank();
    }

    function testLzV2Ism_lzReceive_RevertWhen_NotMessagePayloadIncorrect(
        bytes calldata _message
    ) public {
        // Check the function signature
        vm.assume(
            bytes4(_message) !=
                bytes4(AbstractMessageIdAuthorizedIsm.verifyMessageId.selector)
        );

        // Set hook
        lZIsm.setAuthorizedHook(hook.addressToBytes32());
        (
            Origin memory origin,
            bytes32 guid,
            bytes memory message,
            address executor,
            bytes memory extraData
        ) = _makeLzParameters(
                hook,
                bytes32(""),
                _message,
                makeAddr("executor"),
                bytes("")
            );

        vm.startPrank(endpoint);
        vm.expectRevert("LayerZeroV2Ism: message payload is incorrect");
        lZIsm.lzReceive(origin, guid, message, executor, extraData);
        vm.stopPrank();

        // Try with correct payload
        vm.startPrank(endpoint);
        (origin, guid, message, executor, extraData) = _makeLzParameters(
            hook,
            bytes32(""),
            encodedFunctionCall,
            makeAddr("executor"),
            bytes("")
        );
        lZIsm.lzReceive(origin, guid, message, executor, extraData);
        vm.stopPrank();
    }

    function testLzV2Ism_verifyMessageId_RevertWhen_NotCalledBySelf(
        bytes32 messageId
    ) public {
        lZIsm.setAuthorizedHook(hook.addressToBytes32());

        vm.startPrank(endpoint);
        vm.expectRevert(
            "AbstractMessageIdAuthorizedIsm: sender is not the hook"
        );
        lZIsm.verifyMessageId(messageId);
        vm.stopPrank();

        // Try through LZ Ism
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
                encodedFunctionCall,
                makeAddr("executor"),
                bytes("")
            );
        lZIsm.lzReceive(origin, guid, message, executor, extraData);
        vm.stopPrank();
    }
}
