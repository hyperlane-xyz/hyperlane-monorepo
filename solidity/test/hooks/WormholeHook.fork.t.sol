// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test, Vm} from "forge-std/Test.sol";
import "forge-std/console.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {MessageUtils} from "../isms/IsmTestUtils.sol";
import {WormholeHook} from "../../contracts/hooks/WormholeHook.sol";
import {IWormhole} from "../../contracts/interfaces/IWormhole.sol";

/**
 * @notice Fork test that drives a real dispatch through the live Base Wormhole
 * Core Bridge and asserts the guardian-facing `LogMessagePublished` event is
 * emitted with the Hyperlane message id as its payload — i.e. the message
 * triggers the Wormhole publish exactly as expected on-chain.
 */
contract WormholeHookForkTest is Test {
    using TypeCasts for address;
    using MessageUtils for bytes;

    // Wormhole Core Bridge on Base (Wormhole chain id 30, messageFee 0).
    address internal constant BASE_WORMHOLE_CORE =
        0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6;
    uint16 internal constant BASE_WORMHOLE_CHAIN_ID = 30;

    // LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)
    bytes32 internal constant LOG_MESSAGE_PUBLISHED_TOPIC =
        0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2;

    uint32 internal constant ORIGIN_DOMAIN = 8453; // Base
    uint32 internal constant DESTINATION_DOMAIN = 1; // Ethereum
    uint8 internal constant CONSISTENCY_LEVEL = 200; // instant

    IWormhole internal wormhole;
    TestMailbox internal mailbox;
    TestRecipient internal recipient;
    WormholeHook internal hook;

    bytes internal encodedMessage;
    bytes32 internal messageId;
    bytes internal metadata;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("base"));

        wormhole = IWormhole(BASE_WORMHOLE_CORE);
        mailbox = new TestMailbox(ORIGIN_DOMAIN);
        recipient = new TestRecipient();
        hook = new WormholeHook(
            BASE_WORMHOLE_CORE,
            CONSISTENCY_LEVEL,
            address(mailbox),
            DESTINATION_DOMAIN,
            address(0xbeef).addressToBytes32()
        );

        encodedMessage = MessageUtils.formatMessage(
            1,
            0,
            ORIGIN_DOMAIN,
            address(this).addressToBytes32(),
            DESTINATION_DOMAIN,
            address(recipient).addressToBytes32(),
            "wormhole fork test"
        );
        messageId = Message.id(encodedMessage);
        metadata = StandardHookMetadata.formatMetadata(0, 0, address(this), "");
    }

    receive() external payable {}

    function testFork_quoteDispatch_matchesCoreFee() public view {
        assertEq(
            hook.quoteDispatch(metadata, encodedMessage),
            wormhole.messageFee()
        );
    }

    function testFork_postDispatch_emitsLogMessagePublished() public {
        mailbox.updateLatestDispatchedId(messageId);
        uint256 fee = wormhole.messageFee();

        vm.recordLogs();
        hook.postDispatch{value: fee}(metadata, encodedMessage);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter != BASE_WORMHOLE_CORE ||
                logs[i].topics[0] != LOG_MESSAGE_PUBLISHED_TOPIC
            ) {
                continue;
            }
            // indexed sender is the hook (left-padded address)
            assertEq(
                logs[i].topics[1],
                bytes32(uint256(uint160(address(hook))))
            );
            (
                ,
                /*uint64 sequence*/ uint32 nonce,
                bytes memory payload,
                uint8 consistencyLevel
            ) = abi.decode(logs[i].data, (uint64, uint32, bytes, uint8));
            assertEq(nonce, 0);
            assertEq(consistencyLevel, CONSISTENCY_LEVEL);
            assertEq(
                abi.decode(payload, (bytes32)),
                messageId,
                "published payload must be the hyperlane message id"
            );
            found = true;
            break;
        }
        assertTrue(found, "LogMessagePublished not emitted by Wormhole core");
    }
}
