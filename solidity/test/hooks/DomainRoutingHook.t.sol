// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {DomainRoutingHook} from "../../contracts/hooks/routing/DomainRoutingHook.sol";
import {FallbackDomainRoutingHook} from "../../contracts/hooks/routing/FallbackDomainRoutingHook.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract DomainRoutingHookTest is Test {
    using TypeCasts for address;
    using Strings for uint32;

    DomainRoutingHook public hook;
    TestPostDispatchHook public noopHook;
    TestMailbox public mailbox;

    function setUp() public virtual {
        address owner = address(this);
        uint32 origin = 0;
        mailbox = new TestMailbox(origin);
        hook = new DomainRoutingHook(address(mailbox), owner);
        noopHook = new TestPostDispatchHook();
    }

    function test_quoteDispatch(
        uint32 destination,
        bytes32 recipient,
        bytes memory body,
        bytes memory metadata,
        uint256 fee
    ) public {
        noopHook.setFee(fee);

        hook.setHook(destination, address(noopHook));

        bytes memory testMessage = mailbox.buildOutboundMessage(
            destination,
            recipient,
            body
        );

        vm.expectCall(
            address(noopHook),
            abi.encodeCall(noopHook.quoteDispatch, (metadata, testMessage))
        );
        assertEq(hook.quoteDispatch(metadata, testMessage), fee);
    }

    function test_quoteDispatch_whenDestinationUnenrolled(
        uint32 destination,
        bytes32 recipient,
        bytes memory body,
        bytes memory metadata,
        uint256
    ) public virtual {
        bytes memory testMessage = mailbox.buildOutboundMessage(
            destination,
            recipient,
            body
        );
        // dynamic reason cannot be checked?
        vm.expectRevert();
        hook.quoteDispatch(metadata, testMessage);
    }

    function test_postDispatch(
        uint32 destination,
        bytes32 recipient,
        bytes memory body,
        bytes memory metadata
    ) public {
        hook.setHook(destination, address(noopHook));

        bytes memory testMessage = mailbox.buildOutboundMessage(
            destination,
            recipient,
            body
        );

        vm.expectCall(
            address(noopHook),
            abi.encodeCall(noopHook.postDispatch, (metadata, testMessage))
        );
        hook.postDispatch(metadata, testMessage);
    }

    function test_postDispatch_whenDestinationUnenrolled(
        uint32 destination,
        bytes32 recipient,
        bytes memory body,
        bytes memory metadata
    ) public virtual {
        bytes memory testMessage = mailbox.buildOutboundMessage(
            destination,
            recipient,
            body
        );
        // dynamic reason cannot be checked?
        vm.expectRevert();
        hook.postDispatch(metadata, testMessage);
    }

    function testHookType() public virtual {
        assertEq(hook.hookType(), uint8(IPostDispatchHook.Types.ROUTING));
    }
}

contract FallbackDomainRoutingHookTest is DomainRoutingHookTest {
    TestPostDispatchHook public fallbackHook;

    function setUp() public override {
        address owner = address(this);
        uint32 origin = 0;
        mailbox = new TestMailbox(origin);
        fallbackHook = new TestPostDispatchHook();
        noopHook = new TestPostDispatchHook();
        hook = new FallbackDomainRoutingHook(
            address(mailbox),
            owner,
            address(fallbackHook)
        );
    }

    function test_quoteDispatch_whenDestinationUnenrolled(
        uint32 destination,
        bytes32 recipient,
        bytes memory body,
        bytes memory metadata,
        uint256 fee
    ) public override {
        fallbackHook.setFee(fee);

        bytes memory testMessage = mailbox.buildOutboundMessage(
            destination,
            recipient,
            body
        );

        vm.expectCall(
            address(fallbackHook),
            abi.encodeCall(fallbackHook.quoteDispatch, (metadata, testMessage))
        );
        assertEq(hook.quoteDispatch(metadata, testMessage), fee);
    }

    function test_postDispatch_whenDestinationUnenrolled(
        uint32 destination,
        bytes32 recipient,
        bytes memory body,
        bytes memory metadata
    ) public override {
        bytes memory testMessage = mailbox.buildOutboundMessage(
            destination,
            recipient,
            body
        );

        vm.expectCall(
            address(fallbackHook),
            abi.encodeCall(fallbackHook.postDispatch, (metadata, testMessage))
        );
        hook.postDispatch(metadata, testMessage);
    }

    function testHookType() public override {
        assertEq(
            hook.hookType(),
            uint8(IPostDispatchHook.Types.FALLBACK_ROUTING)
        );
    }
}
