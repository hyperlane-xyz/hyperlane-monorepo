// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Test} from "forge-std/Test.sol";
import "forge-std/console.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {TestSendReceiver} from "../../contracts/test/TestSendReceiver.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestIsm} from "../../contracts/test/TestIsm.sol";
import {TestInterchainGasPaymaster} from "../../contracts/test/TestInterchainGasPaymaster.sol";
import {TestMerkleTreeHook} from "../../contracts/test/TestMerkleTreeHook.sol";

contract TestSendReceiverTest is Test {
    using TypeCasts for address;

    uint32 internal constant TEST_ORIGIN_DOMAIN = 1;
    uint32 internal constant TEST_DESTINATION_DOMAIN = 2;
    bytes internal constant TEST_MESSAGE_CONTENT = bytes("Bonjour");
    TestSendReceiver internal testSendReceiver;
    TestInterchainGasPaymaster internal igp;
    TestMailbox internal mailbox;
    uint256 internal gasPayment;
    bytes internal testMessage;

    function setUp() public {
        mailbox = new TestMailbox(TEST_ORIGIN_DOMAIN);
        TestIsm ism = new TestIsm();
        igp = new TestInterchainGasPaymaster();
        TestMerkleTreeHook requiredHook = new TestMerkleTreeHook(
            address(mailbox)
        );
        mailbox.initialize(
            address(this),
            address(ism),
            address(igp),
            address(requiredHook)
        );
        testSendReceiver = new TestSendReceiver();

        gasPayment = mailbox.quoteDispatch(
            TEST_DESTINATION_DOMAIN,
            address(testSendReceiver).addressToBytes32(),
            TEST_MESSAGE_CONTENT
        );
        testMessage = mailbox.buildOutboundMessage(
            TEST_DESTINATION_DOMAIN,
            address(testSendReceiver).addressToBytes32(),
            TEST_MESSAGE_CONTENT
        );
    }

    event Dispatch(
        address indexed sender,
        uint32 indexed destination,
        bytes32 indexed recipient,
        bytes message
    );

    function testDispatchToSelf() public {
        vm.expectEmit(true, true, true, false, address(mailbox));
        // sender address is the testSendReceiver which doesn't match sender
        // in event (not in scope for test here - tested in Mailbox.t.sol)
        emit Dispatch(
            address(testSendReceiver),
            TEST_DESTINATION_DOMAIN,
            address(testSendReceiver).addressToBytes32(),
            testMessage
        );
        testSendReceiver.dispatchToSelf{value: gasPayment}(
            mailbox,
            TEST_DESTINATION_DOMAIN,
            TEST_MESSAGE_CONTENT
        );
    }

    function testDispatchToSelf_withHook() public {
        vm.expectEmit(true, true, true, false, address(mailbox));
        // sender address is the testSendReceiver which doesn't match sender
        // in event (not in scope for test here - tested in Mailbox.t.sol)
        emit Dispatch(
            address(testSendReceiver),
            TEST_DESTINATION_DOMAIN,
            address(testSendReceiver).addressToBytes32(),
            testMessage
        );
        testSendReceiver.dispatchToSelf{value: gasPayment}(
            mailbox,
            TEST_DESTINATION_DOMAIN,
            TEST_MESSAGE_CONTENT,
            igp
        );
    }

    event Handled(bytes32 blockhash);

    function testHandle(uint256 blockNumber) public {
        vm.assume(blockNumber > 0);
        vm.roll(blockNumber);

        // previousBlockHash() = blockhash(n-1)
        if (uint256(blockhash(blockNumber - 1)) % 16 == 0) {
            vm.expectRevert("block hash ends in 0"); // blockhash(n-1) ends in 0
        } else {
            vm.expectEmit(true, true, true, false, address(testSendReceiver)); // Process
            emit Handled(bytes32(blockNumber - 1));
        }
        testSendReceiver.handle(
            0,
            address(testSendReceiver).addressToBytes32(),
            "0x1234"
        );
    }

    function testHandle_withHardcodedBody() public {
        bytes memory hardcodedFail = "failMessageBody";

        vm.expectRevert("failMessageBody");
        testSendReceiver.handle(
            0,
            address(testSendReceiver).addressToBytes32(),
            hardcodedFail
        );
    }
}
