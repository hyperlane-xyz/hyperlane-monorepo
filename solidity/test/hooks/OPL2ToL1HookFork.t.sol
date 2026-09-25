// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {OPL2ToL1Hook} from "../../contracts/hooks/OPL2ToL1Hook.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

contract OPL2ToL1HookForkTest is Test {
    using TypeCasts for address;

    uint32 internal constant OPTIMISM_DOMAIN = 10;
    uint32 internal constant MAINNET_DOMAIN = 1;
    uint256 internal constant FORK_BLOCK = 124_000_000;
    uint256 internal constant MSG_VALUE = 1 ether;

    address internal constant L2_MESSENGER_ADDRESS =
        0x4200000000000000000000000000000000000007;

    TestMailbox internal mailbox;
    OPL2ToL1Hook internal hook;
    bytes internal message;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("optimism"), FORK_BLOCK);

        mailbox = new TestMailbox(OPTIMISM_DOMAIN);
        hook = new OPL2ToL1Hook(
            address(mailbox),
            MAINNET_DOMAIN,
            address(0xBEEF).addressToBytes32(),
            L2_MESSENGER_ADDRESS,
            address(new TestPostDispatchHook())
        );
        message = mailbox.buildOutboundMessage(
            MAINNET_DOMAIN,
            address(new TestRecipient()).addressToBytes32(),
            "test"
        );
    }

    function testFork_postDispatch_revertWhen_valueMessageReplayedWithoutValue()
        public
    {
        bytes memory metadata = StandardHookMetadata.overrideMsgValue(
            MSG_VALUE
        );
        mailbox.updateLatestDispatchedId(Message.id(message));
        vm.deal(address(this), MSG_VALUE);

        hook.postDispatch{value: MSG_VALUE}(metadata, message);

        vm.expectRevert("AbstractMessageIdAuthHook: message already processed");
        hook.postDispatch("", message);
    }
}
