// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {BlacklistIsm} from "../../contracts/isms/BlacklistIsm.sol";
import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {MessageUtils} from "./IsmTestUtils.sol";

contract BlacklistIsmTest is Test {
    BlacklistIsm ism;

    address owner;
    bytes testMessage;
    bytes32 testMessageId;

    function setUp() public {
        owner = msg.sender;
        ism = new BlacklistIsm(owner);
        testMessage = MessageUtils.formatMessage(
            0,
            42,
            1983,
            bytes32(0),
            1,
            bytes32(0),
            ""
        );
        testMessageId = keccak256(testMessage);
    }

    function test_moduleType() public view {
        assertEq(ism.moduleType(), uint8(IInterchainSecurityModule.Types.NULL));
    }

    function test_verify_acceptsByDefault() public view {
        assertTrue(ism.verify("", testMessage));
    }

    function test_verify_rejectsBlacklisted() public {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = testMessageId;
        vm.prank(owner);
        ism.blacklist(ids);

        assertFalse(ism.verify("", testMessage));
    }

    function test_verify_acceptsAfterWhitelist() public {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = testMessageId;

        vm.prank(owner);
        ism.blacklist(ids);
        assertFalse(ism.verify("", testMessage));

        vm.prank(owner);
        ism.whitelist(ids);
        assertTrue(ism.verify("", testMessage));
    }

    function test_blacklist_onlyOwner() public {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = testMessageId;
        vm.expectRevert("Ownable: caller is not the owner");
        ism.blacklist(ids);
    }

    function test_whitelist_onlyOwner() public {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = testMessageId;
        vm.expectRevert("Ownable: caller is not the owner");
        ism.whitelist(ids);
    }

    function test_blacklist_batch() public {
        bytes memory msg1 = MessageUtils.formatMessage(
            0,
            1,
            1983,
            bytes32(0),
            1,
            bytes32(0),
            ""
        );
        bytes memory msg2 = MessageUtils.formatMessage(
            0,
            2,
            1983,
            bytes32(0),
            1,
            bytes32(0),
            ""
        );
        bytes memory msg3 = MessageUtils.formatMessage(
            0,
            3,
            1983,
            bytes32(0),
            1,
            bytes32(0),
            ""
        );

        bytes32[] memory ids = new bytes32[](2);
        ids[0] = keccak256(msg1);
        ids[1] = keccak256(msg2);

        vm.prank(owner);
        ism.blacklist(ids);

        assertFalse(ism.verify("", msg1));
        assertFalse(ism.verify("", msg2));
        assertTrue(ism.verify("", msg3));
    }

    function test_blacklist_emitsEvents() public {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = testMessageId;

        vm.expectEmit(true, false, false, false);
        emit BlacklistIsm.MessageBlacklisted(testMessageId);
        vm.prank(owner);
        ism.blacklist(ids);
    }

    function test_whitelist_emitsEvents() public {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = testMessageId;

        vm.prank(owner);
        ism.blacklist(ids);

        vm.expectEmit(true, false, false, false);
        emit BlacklistIsm.MessageWhitelisted(testMessageId);
        vm.prank(owner);
        ism.whitelist(ids);
    }

    function test_verify_nonBlacklistedUnaffected() public {
        bytes memory otherMessage = MessageUtils.formatMessage(
            0,
            999,
            1,
            bytes32(0),
            1,
            bytes32(0),
            ""
        );

        bytes32[] memory ids = new bytes32[](1);
        ids[0] = testMessageId;
        vm.prank(owner);
        ism.blacklist(ids);

        assertFalse(ism.verify("", testMessage));
        assertTrue(ism.verify("", otherMessage));
    }

    function testFuzz_verify(bytes32 messageId) public {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = testMessageId;
        vm.prank(owner);
        ism.blacklist(ids);

        bytes32[] memory listed = ism.blacklistedIds();
        assertEq(listed.length, 1);
        assertEq(listed[0], testMessageId);

        if (messageId == testMessageId) {
            assertFalse(ism.verify("", abi.encodePacked(messageId)));
        }
    }

    function test_blacklistedIds_enumeration() public {
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = testMessageId;
        ids[1] = keccak256("other");
        vm.prank(owner);
        ism.blacklist(ids);

        bytes32[] memory listed = ism.blacklistedIds();
        assertEq(listed.length, 2);

        vm.prank(owner);
        bytes32[] memory removeOne = new bytes32[](1);
        removeOne[0] = ids[0];
        ism.whitelist(removeOne);

        listed = ism.blacklistedIds();
        assertEq(listed.length, 1);
        assertEq(listed[0], ids[1]);
    }
}
