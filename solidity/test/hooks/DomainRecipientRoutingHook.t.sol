// SPDX-License-Identifier: Apache-1.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {DomainRecipientRoutingHook} from "../../contracts/hooks/routing/DomainRecipientRoutingHook.sol";
import {FallbackDomainRecipientRoutingHook} from "../../contracts/hooks/routing/FallbackDomainRecipientRoutingHook.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract DomainRecipientRoutingHookTest is Test {
    using Strings for uint32;
    using TypeCasts for address;

    DomainRecipientRoutingHook public hook;
    TestPostDispatchHook public noopHook;
    TestMailbox public mailbox;

    function setUp() public virtual {
        address owner = address(this);
        uint32 origin = 0;
        mailbox = new TestMailbox(origin);
        hook = new DomainRecipientRoutingHook(address(mailbox), owner);
        noopHook = new TestPostDispatchHook();
    }

    function test_quoteDispatch(
        uint32 destination,
        address recipient,
        bytes memory body,
        bytes memory metadata,
        uint256 fee
    ) public {
        vm.assume(recipient != address(0));
        noopHook.setFee(fee);

        hook.setHook(destination, recipient, address(noopHook));

        bytes memory testMessage = mailbox.buildOutboundMessage(
            destination,
            recipient.addressToBytes32(),
            body
        );

        vm.expectCall(
            address(noopHook),
            abi.encodeCall(noopHook.quoteDispatch, (metadata, testMessage))
        );
        assertEq(hook.quoteDispatch(metadata, testMessage), fee);
    }

    function test_quoteDispatch_whenDestinationRecipientUnenrolled(
        uint32 destination,
        address recipient,
        bytes memory body,
        bytes memory metadata
    ) public {
        vm.assume(recipient != address(0));
        bytes memory testMessage = mailbox.buildOutboundMessage(
            destination,
            recipient.addressToBytes32(),
            body
        );
        // dynamic reason cannot be checked?
        vm.expectRevert();
        hook.quoteDispatch(metadata, testMessage);
    }

    function test_postDispatch(
        uint32 destination,
        address recipient,
        bytes memory body,
        bytes memory metadata
    ) public {
        vm.assume(recipient != address(0));
        hook.setHook(destination, recipient, address(noopHook));

        bytes memory testMessage = mailbox.buildOutboundMessage(
            destination,
            recipient.addressToBytes32(),
            body
        );

        vm.expectCall(
            address(noopHook),
            abi.encodeCall(noopHook.postDispatch, (metadata, testMessage))
        );
        hook.postDispatch(metadata, testMessage);
    }

    function test_postDispatch_whenDestinationRecipientUnenrolled(
        uint32 destination,
        address recipient,
        bytes memory body,
        bytes memory metadata
    ) public virtual {
        vm.assume(recipient != address(0));
        bytes memory testMessage = mailbox.buildOutboundMessage(
            destination,
            recipient.addressToBytes32(),
            body
        );
        // dynamic reason cannot be checked?
        vm.expectRevert();
        hook.postDispatch(metadata, testMessage);
    }

    function testHookType() public virtual {
        assertEq(hook.hookType(), uint8(IPostDispatchHook.Types.ROUTING));
    }

    function test_setHooks(
        uint32[] memory destinations,
        address[] memory recipients,
        address[] memory hooks
    ) public {
        vm.assume(
            destinations.length > 0 &&
                destinations.length == recipients.length &&
                destinations.length == hooks.length
        );

        // Create configs array
        DomainRecipientRoutingHook.HookConfig[]
            memory configs = new DomainRecipientRoutingHook.HookConfig[](
                destinations.length
            );

        for (uint256 i = 0; i < destinations.length; i++) {
            vm.assume(recipients[i] != address(0));
            configs[i] = DomainRecipientRoutingHook.HookConfig({
                destination: destinations[i],
                recipient: recipients[i],
                hook: hooks[i]
            });
        }

        hook.setHooks(configs);

        // Verify each hook was set correctly
        for (uint256 i = 0; i < destinations.length; i++) {
            assertEq(
                address(hook.hooks(destinations[i], recipients[i])),
                hooks[i]
            );
        }
    }
}

contract FallbackDomainRecipientRoutingHookTest is
    DomainRecipientRoutingHookTest
{
    using TypeCasts for address;

    TestPostDispatchHook public fallbackHook;

    function setUp() public override {
        address owner = address(this);
        uint32 origin = 0;
        mailbox = new TestMailbox(origin);
        fallbackHook = new TestPostDispatchHook();
        noopHook = new TestPostDispatchHook();
        hook = new FallbackDomainRecipientRoutingHook(
            address(mailbox),
            owner,
            address(fallbackHook)
        );
    }

    function test_quoteDispatch_whenDestinationRecipientUnenrolled(
        uint32 destination,
        address recipient,
        bytes memory body,
        bytes memory metadata,
        uint256 fee
    ) public {
        vm.assume(recipient != address(0));
        fallbackHook.setFee(fee);

        bytes memory testMessage = mailbox.buildOutboundMessage(
            destination,
            recipient.addressToBytes32(),
            body
        );

        vm.expectCall(
            address(fallbackHook),
            abi.encodeCall(fallbackHook.quoteDispatch, (metadata, testMessage))
        );
        assertEq(hook.quoteDispatch(metadata, testMessage), fee);
    }

    function test_postDispatch_whenDestinationRecipientUnenrolled(
        uint32 destination,
        address recipient,
        bytes memory body,
        bytes memory metadata
    ) public override {
        vm.assume(recipient != address(0));
        bytes memory testMessage = mailbox.buildOutboundMessage(
            destination,
            recipient.addressToBytes32(),
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
