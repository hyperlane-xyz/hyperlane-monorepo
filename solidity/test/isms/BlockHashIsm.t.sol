// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {BlockHashIsm} from "../../contracts/isms/BlockHashIsm.sol";
import {IBlockHashOracle} from "../../contracts/interfaces/IBlockHashOracle.sol";

contract BlockHashIsmTest is Test {
    using TypeCasts for address;

    uint32 localDomain = 12345;
    uint32 remoteDomain = 54321;

    TestMailbox mailbox;
    BlockHashIsm ism;
    TestRecipient recipient;

    IBlockHashOracle oracle;

    function setUp() public {
        oracle = new BlockHashOracle();
        recipient = new TestRecipient();
        mailbox = new TestMailbox(12345);
        ism = new BlockHashIsm(address(mailbox), address(oracle));
        recipient.setInterchainSecurityModule(address(ism));
    }

    function test_revertsWhen_invalidMailboxOrOracle() public {
        vm.expectRevert("BlockHashIsm: invalid oracle");
        new BlockHashIsm(address(mailbox), address(0));
        vm.expectRevert("BlockHashIsm: invalid mailbox");
        new BlockHashIsm(address(0), address(oracle));
    }

    function test_verify_revertsWhen_emptyBody(bytes32 sender) public {
        uint32 origin = 0x9001;
        bytes memory body = "";
        bytes memory message = mailbox.buildInboundMessage(
            origin,
            address(recipient).addressToBytes32(),
            sender,
            body
        );
        vm.expectRevert();
        ism.verify("", message);
    }
}

contract BlockHashOracle is IBlockHashOracle {
    uint32 public immutable origin = 0x9001;

    function blockhash(uint256 height) external view returns (uint256) {
        return 0x42;
    }
}
