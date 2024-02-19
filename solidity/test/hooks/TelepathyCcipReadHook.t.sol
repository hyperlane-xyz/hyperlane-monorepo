// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {TelepathyCcipReadHook} from "../../contracts/hooks/ccip/TelepathyCcipReadHook.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";

contract TelepathyCcipReadHookTest is Test {
    using Message for bytes;
    using TypeCasts for address;

    TelepathyCcipReadHook hook;

    function setUp() public {
        hook = new TelepathyCcipReadHook();
    }

    function testTelepathyCcipReadHookTest_SetsDispatchedMapping(
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
        assertEq(message.id(), hook.dispatched(address(this), _nonce));
    }

    function testTelepathyCcipReadHookTest_QuotesZero() public {
        bytes memory metadata = StandardHookMetadata.formatMetadata(
            0,
            0, // gas limit
            address(0), // refund address
            bytes("")
        );
        assertEq(hook.quoteDispatch(metadata, bytes("")), 0);
    }

    function testTelepathyCcipReadHookTest_HookType() public {
        assertEq(hook.hookType(), uint8(IPostDispatchHook.Types.CCIP_READ));
    }
}
