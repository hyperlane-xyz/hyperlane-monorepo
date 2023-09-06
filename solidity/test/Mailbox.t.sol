// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../contracts/test/TestMailbox.sol";
import "../contracts/libs/Message.sol";
import "../contracts/upgrade/Versioned.sol";
import "../contracts/test/TestHook.sol";
import "../contracts/test/TestIsm.sol";
import "../contracts/test/TestRecipient.sol";
import "../contracts/hooks/MerkleTreeHook.sol";

import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract MailboxTest is Test, Versioned {
    using TypeCasts for address;
    using Message for bytes;

    uint32 localDomain = 1;
    uint32 remoteDomain = 2;
    TestMailbox mailbox;

    MerkleTreeHook merkleHook;

    TestHook defaultHook;
    TestHook overrideHook;
    TestHook requiredHook;

    TestIsm ism;
    TestRecipient recipient;
    bytes32 recipientb32;

    function setUp() public {
        mailbox = new TestMailbox(localDomain);
        recipient = new TestRecipient();
        recipientb32 = address(recipient).addressToBytes32();
        defaultHook = new TestHook();
        merkleHook = new MerkleTreeHook(address(mailbox));
        requiredHook = new TestHook();
        overrideHook = new TestHook();
        ism = new TestIsm();

        mailbox.initialize(
            msg.sender,
            address(ism),
            address(defaultHook),
            address(requiredHook)
        );
    }

    function test_localDomain() public {
        assertEq(mailbox.localDomain(), localDomain);
    }

    function test_initialize() public {
        assertEq(mailbox.owner(), msg.sender);
        assertEq(address(mailbox.defaultIsm()), address(ism));
        assertEq(address(mailbox.defaultHook()), address(defaultHook));
        assertEq(address(mailbox.requiredHook()), address(requiredHook));
    }

    function test_initialize_revertsWhenCalledTwice() public {
        vm.expectRevert("Initializable: contract is already initialized");
        mailbox.initialize(
            msg.sender,
            address(ism),
            address(defaultHook),
            address(requiredHook)
        );
    }

    function expectHookQuote(
        IPostDispatchHook hook,
        bytes calldata metadata,
        bytes memory message
    ) internal {
        vm.expectCall(
            address(hook),
            abi.encodeCall(IPostDispatchHook.quoteDispatch, (metadata, message))
        );
    }

    function expectHookPost(
        IPostDispatchHook hook,
        bytes calldata metadata,
        bytes memory message,
        uint256 value
    ) internal {
        vm.expectCall(
            address(hook),
            value,
            abi.encodeCall(IPostDispatchHook.postDispatch, (metadata, message))
        );
    }

    function test_quoteDispatch(
        uint256 requiredFee,
        uint256 defaultFee,
        uint256 overrideFee,
        bytes calldata body,
        bytes calldata metadata
    ) public {
        vm.assume(
            requiredFee < type(uint128).max &&
                defaultFee < type(uint128).max &&
                overrideFee < type(uint128).max
        );
        defaultHook.setFee(defaultFee);
        requiredHook.setFee(requiredFee);
        overrideHook.setFee(overrideFee);

        bytes memory message = mailbox.buildMessage(
            remoteDomain,
            recipientb32,
            body
        );
        bytes calldata defaultMetadata = metadata[0:0];

        expectHookQuote(requiredHook, defaultMetadata, message);
        expectHookQuote(defaultHook, defaultMetadata, message);
        uint256 quote = mailbox.quoteDispatch(
            remoteDomain,
            address(recipient).addressToBytes32(),
            body
        );
        assertEq(quote, defaultFee + requiredFee);

        expectHookQuote(requiredHook, metadata, message);
        expectHookQuote(defaultHook, metadata, message);
        quote = mailbox.quoteDispatch(
            remoteDomain,
            address(recipient).addressToBytes32(),
            body,
            metadata
        );
        assertEq(quote, defaultFee + requiredFee);

        expectHookQuote(requiredHook, metadata, message);
        expectHookQuote(overrideHook, metadata, message);
        quote = mailbox.quoteDispatch(
            remoteDomain,
            address(recipient).addressToBytes32(),
            body,
            metadata,
            overrideHook
        );
        assertEq(quote, overrideFee + requiredFee);
    }

    event Dispatch(
        address indexed sender,
        uint32 indexed destination,
        bytes32 indexed recipient,
        bytes message
    );

    event DispatchId(bytes32 indexed messageId);

    function expectDispatch(
        TestHook firstHook,
        TestHook hook,
        bytes calldata metadata,
        bytes calldata body
    ) internal {
        bytes memory message = mailbox.buildMessage(
            remoteDomain,
            recipientb32,
            body
        );
        expectHookQuote(firstHook, metadata, message);
        expectHookPost(firstHook, metadata, message, firstHook.fee());
        expectHookPost(hook, metadata, message, hook.fee());
        vm.expectEmit(true, true, true, true, address(mailbox));
        emit Dispatch(address(this), remoteDomain, recipientb32, message);
        vm.expectEmit(true, false, false, false, address(mailbox));
        emit DispatchId(message.id());
    }

    function test_dispatch(
        uint8 n,
        bytes calldata body,
        bytes calldata metadata
    ) public {
        bytes calldata defaultMetadata = metadata[0:0];
        uint32 nonce;
        bytes32 id;

        for (uint256 i = 0; i < n; i += 3) {
            nonce = mailbox.nonce();
            assertEq(nonce, i);

            // default hook and no metadata
            expectDispatch(requiredHook, defaultHook, defaultMetadata, body);
            id = mailbox.dispatch(remoteDomain, recipientb32, body);
            assertEq(mailbox.latestDispatchedId(), id);
            nonce = mailbox.nonce();
            assertEq(nonce, i + 1);

            // default hook with metadata
            expectDispatch(requiredHook, defaultHook, metadata, body);
            id = mailbox.dispatch(remoteDomain, recipientb32, body, metadata);
            assertEq(mailbox.latestDispatchedId(), id);
            nonce = mailbox.nonce();
            assertEq(nonce, i + 2);

            // override default hook with metadata
            expectDispatch(requiredHook, overrideHook, metadata, body);
            id = mailbox.dispatch(
                remoteDomain,
                recipientb32,
                body,
                metadata,
                overrideHook
            );
            assertEq(mailbox.latestDispatchedId(), id);
            nonce = mailbox.nonce();
            assertEq(nonce, i + 3);
        }
    }

    function test_100dispatch_withMerkleTreeHook(bytes calldata body) public {
        for (uint256 i = 0; i < 100; i++) {
            mailbox.dispatch(
                remoteDomain,
                address(recipient).addressToBytes32(),
                body,
                body[0:0],
                merkleHook
            );
        }
    }
}
