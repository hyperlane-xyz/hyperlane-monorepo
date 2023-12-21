// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {LZEndpointMock} from "@layerzerolabs/solidity-examples/contracts/lzApp/mocks/LZEndpointMock.sol";
import {Test} from "forge-std/Test.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {LayerZeroHook} from "../../contracts/hooks/LayerZeroHook.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";

contract LayerZeroHookTest is Test {
    LZEndpointMock lZEndpointMock;
    TestMailbox public mailbox;
    LayerZeroHook hook;

    function setUp() public {
        lZEndpointMock = new LZEndpointMock(uint16(block.chainid));
        mailbox = new TestMailbox(0);
        hook = new LayerZeroHook(address(mailbox));
    }

    // function testPostDispatch_emit() public {}

    function testQuoteDispatch() public {
        assertEq(hook.quoteDispatch("", ""), 0);
    }

    function testHookType() public {
        assertEq(hook.hookType(), uint8(IPostDispatchHook.Types.LAYER_ZERO));
    }
}
