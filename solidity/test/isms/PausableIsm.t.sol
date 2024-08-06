// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {PausableIsm} from "../../contracts/isms/PausableIsm.sol";

contract PausableIsmTest is Test {
    PausableIsm ism;

    address owner;

    function setUp() public {
        owner = msg.sender;
        ism = new PausableIsm(owner);
    }

    function test_verify() public {
        assertTrue(ism.verify("", ""));
        vm.prank(owner);
        ism.pause();
        vm.expectRevert(bytes("Pausable: paused"));
        ism.verify("", "");
    }

    function test_pause() public {
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        ism.pause();
        vm.prank(owner);
        ism.pause();
        assertTrue(ism.paused());
    }

    function test_unpause() public {
        vm.prank(owner);
        ism.pause();
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        ism.unpause();
        vm.prank(owner);
        ism.unpause();
        assertFalse(ism.paused());
    }
}
