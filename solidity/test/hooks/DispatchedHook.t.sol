// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {DispatchedHook} from "../../contracts/hooks/DispatchedHook.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";

contract DispatchedHookTest is Test {
    using Message for bytes;
    using TypeCasts for address;

    DispatchedHook hook;

    function setUp() public {
        hook = new DispatchedHook();
    }

    function testDispatchedHookTest_SetsDispatchedMapping(
        uint32 _nonce,
        bytes calldata _messageBody
    ) public {
        bytes memory message = Message.formatMessage(
            0,
            _nonce,
            0,
            address(this).addressToBytes32(),
            0,
            address(this).addressToBytes32(),
            _messageBody
        );
        bytes memory metadata = StandardHookMetadata.formatMetadata(
            0,
            0,
            address(0),
            bytes("")
        );
        hook.postDispatch(metadata, message);
        assertEq(message.id(), hook.dispatched(_nonce));
    }

    function testDispatchedHookTest_QuotesZero() public view {
        bytes memory metadata = StandardHookMetadata.formatMetadata(
            0,
            0, // gas limit
            address(0), // refund address
            bytes("")
        );
        assertEq(hook.quoteDispatch(metadata, bytes("")), 0);
    }

    function testDispatchedHookTest_HookType() public view {
        assertEq(hook.hookType(), uint8(IPostDispatchHook.Types.DISPATCHED));
    }
}
