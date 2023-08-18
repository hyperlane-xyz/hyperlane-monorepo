// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {PausableIsm} from "../../contracts/isms/PausableIsm.sol";

contract PausableIsmTest is Test {
    PausableIsm ism;

    function setUp() public {
        ism = new PausableIsm();
    }

    function test_verify() public {
        assertTrue(ism.verify("", ""));
        ism.pause();
        vm.expectRevert(bytes("Pausable: paused"));
        ism.verify("", "");
    }

    function test_pause() public {
        ism.pause();
        assertTrue(ism.paused());
    }

    function test_unpause() public {
        ism.pause();
        ism.unpause();
        assertFalse(ism.paused());
    }
}
