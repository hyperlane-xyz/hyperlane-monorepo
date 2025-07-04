// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {DefaultHook} from "../../contracts/hooks/DefaultHook.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";

contract DefaultHookTest is Test {
    DefaultHook public hook;
    TestPostDispatchHook public noopHook;
    TestMailbox public mailbox;

    bytes public metadata;

    function setUp() public virtual {
        uint32 origin = 1;
        mailbox = new TestMailbox(origin);
        hook = new DefaultHook(address(mailbox));
        noopHook = new TestPostDispatchHook();
        mailbox.setDefaultHook(address(noopHook));
        metadata = StandardHookMetadata.formatMetadata(
            0,
            0,
            address(this),
            bytes("")
        );
    }

    function test_hookType() public {
        assertEq(
            hook.hookType(),
            uint8(IPostDispatchHook.Types.MAILBOX_DEFAULT_HOOK)
        );
    }

    function test_quoteDispatch(bytes calldata message, uint256 fee) public {
        noopHook.setFee(fee);

        uint256 quote = hook.quoteDispatch(metadata, message);
        assertEq(quote, fee);
    }

    function test_postDispatch(bytes calldata message, uint256 value) public {
        vm.deal(address(this), value);
        vm.expectCall(
            address(noopHook),
            value,
            abi.encodeCall(noopHook.postDispatch, (metadata, message))
        );
        hook.postDispatch{value: value}(metadata, message);
    }
}
