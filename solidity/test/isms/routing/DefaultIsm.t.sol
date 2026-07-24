// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {TestMailbox} from "../../../contracts/test/TestMailbox.sol";
import {IInterchainSecurityModule} from "../../../contracts/interfaces/IInterchainSecurityModule.sol";
import {DefaultIsm} from "../../../contracts/isms/routing/DefaultIsm.sol";
import {TestIsm} from "../IsmTestUtils.sol";

contract DefaultIsmTest is Test {
    TestMailbox internal mailbox;
    DefaultIsm internal ism;
    TestIsm internal defaultIsm;

    function setUp() public {
        mailbox = new TestMailbox(12345);
        defaultIsm = new TestIsm(bytes(""));
        mailbox.setDefaultIsm(address(defaultIsm));
        ism = new DefaultIsm(address(mailbox));
    }

    function test_constructor_revertsWhen_invalidMailbox() public {
        vm.expectRevert("DefaultIsm: invalid mailbox");
        new DefaultIsm(address(0xdeadbeef));
    }

    function test_moduleType() public {
        assertEq(
            ism.moduleType(),
            uint8(IInterchainSecurityModule.Types.ROUTING)
        );
    }

    function test_route_returnsMailboxDefaultIsm(
        bytes calldata message
    ) public {
        assertEq(address(ism.route(message)), address(defaultIsm));
    }

    function test_route_reflectsUpdatedMailboxDefaultIsm(
        bytes calldata message
    ) public {
        TestIsm newDefaultIsm = new TestIsm(bytes(""));
        mailbox.setDefaultIsm(address(newDefaultIsm));
        assertEq(address(ism.route(message)), address(newDefaultIsm));
    }

    function test_verify_delegatesToMailboxDefaultIsm(
        bytes calldata message
    ) public {
        bytes memory metadata = "metadata";
        defaultIsm.setRequiredMetadata(metadata);
        assertTrue(ism.verify(metadata, message));
        assertFalse(ism.verify("wrong", message));
    }
}
