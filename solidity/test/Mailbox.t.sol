// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../contracts/test/TestMailbox.sol";
import "../contracts/upgrade/Versioned.sol";
import "../contracts/interfaces/hooks/IPostDispatchHook.sol";
import "../contracts/test/TestPostDispatchHook.sol";
import "../contracts/test/TestIsm.sol";
import "../contracts/test/TestRecipient.sol";
import "../contracts/hooks/MerkleTreeHook.sol";

import {StandardHookMetadata} from "../contracts/hooks/libs/StandardHookMetadata.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract Empty {}

contract EmptyFallback {
    fallback() external {}
}

contract MailboxTest is Test, Versioned {
    using StandardHookMetadata for bytes;
    using TypeCasts for address;
    using Message for bytes;

    uint32 localDomain = 1;
    uint32 remoteDomain = 2;
    TestMailbox mailbox;

    MerkleTreeHook merkleHook;

    TestPostDispatchHook defaultHook;
    TestPostDispatchHook overrideHook;
    TestPostDispatchHook requiredHook;

    TestIsm defaultIsm;
    TestRecipient recipient;
    bytes32 recipientb32;

    address owner;

    function setUp() public {
        mailbox = new TestMailbox(localDomain);
        recipient = new TestRecipient();
        recipientb32 = address(recipient).addressToBytes32();
        defaultHook = new TestPostDispatchHook();
        merkleHook = new MerkleTreeHook(address(mailbox));
        requiredHook = new TestPostDispatchHook();
        overrideHook = new TestPostDispatchHook();
        defaultIsm = new TestIsm();

        owner = msg.sender;
        mailbox.initialize(
            owner,
            address(defaultIsm),
            address(defaultHook),
            address(requiredHook)
        );
    }

    function test_localDomain() public {
        assertEq(mailbox.localDomain(), localDomain);
    }

    function test_initialize() public {
        assertEq(mailbox.owner(), owner);
        assertEq(address(mailbox.defaultIsm()), address(defaultIsm));
        assertEq(address(mailbox.defaultHook()), address(defaultHook));
        assertEq(address(mailbox.requiredHook()), address(requiredHook));
    }

    function test_initialize_revertsWhenCalledTwice() public {
        vm.expectRevert("Initializable: contract is already initialized");
        mailbox.initialize(
            owner,
            address(defaultIsm),
            address(defaultHook),
            address(requiredHook)
        );
    }

    function test_recipientIsm() public {
        IInterchainSecurityModule ism = mailbox.recipientIsm(
            address(recipient)
        );
        assertEq(address(defaultIsm), address(ism));

        // check no ism function returns default
        Empty empty = new Empty();
        ism = mailbox.recipientIsm(address(empty));
        assertEq(address(defaultIsm), address(ism));

        // check empty fallback returns default
        EmptyFallback emptyFallback = new EmptyFallback();
        ism = mailbox.recipientIsm(address(emptyFallback));
        assertEq(address(defaultIsm), address(ism));

        // check zero address returns default
        recipient.setInterchainSecurityModule(address(0));
        ism = mailbox.recipientIsm(address(recipient));
        assertEq(address(defaultIsm), address(ism));

        // check recipient override is used
        TestIsm newIsm = new TestIsm();
        recipient.setInterchainSecurityModule(address(newIsm));
        ism = mailbox.recipientIsm(address(recipient));
        assertEq(address(ism), address(newIsm));
    }

    event DefaultIsmSet(address indexed module);

    function test_setDefaultIsm() public {
        TestIsm newIsm = new TestIsm();

        // prank owner
        vm.startPrank(owner);
        vm.expectEmit(true, false, false, false, address(mailbox));
        emit DefaultIsmSet(address(newIsm));
        mailbox.setDefaultIsm(address(newIsm));
        assertEq(address(mailbox.defaultIsm()), address(newIsm));

        vm.expectRevert("Mailbox: default ISM not contract");
        mailbox.setDefaultIsm(owner);
        vm.stopPrank();

        vm.expectRevert("Ownable: caller is not the owner");
        mailbox.setDefaultIsm(address(newIsm));
    }

    event DefaultHookSet(address indexed module);

    function test_setDefaultHook() public {
        TestPostDispatchHook newHook = new TestPostDispatchHook();

        // prank owner
        vm.startPrank(owner);
        vm.expectEmit(true, false, false, false, address(mailbox));
        emit DefaultHookSet(address(newHook));
        mailbox.setDefaultHook(address(newHook));
        assertEq(address(mailbox.defaultHook()), address(newHook));

        vm.expectRevert("Mailbox: default hook not contract");
        mailbox.setDefaultHook(owner);
        vm.stopPrank();

        vm.expectRevert("Ownable: caller is not the owner");
        mailbox.setDefaultHook(address(newHook));
    }

    event RequiredHookSet(address indexed module);

    function test_setRequiredHook() public {
        TestPostDispatchHook newHook = new TestPostDispatchHook();

        // prank owner
        vm.startPrank(owner);
        vm.expectEmit(true, false, false, false, address(mailbox));
        emit RequiredHookSet(address(newHook));
        mailbox.setRequiredHook(address(newHook));
        assertEq(address(mailbox.requiredHook()), address(newHook));

        vm.expectRevert("Mailbox: required hook not contract");
        mailbox.setRequiredHook(owner);
        vm.stopPrank();

        vm.expectRevert("Ownable: caller is not the owner");
        mailbox.setRequiredHook(address(newHook));
    }

    function expectHookQuote(
        IPostDispatchHook hook,
        bytes memory metadata,
        bytes memory message
    ) internal {
        vm.expectCall(
            address(hook),
            abi.encodeCall(IPostDispatchHook.quoteDispatch, (metadata, message))
        );
    }

    function expectHookPost(
        IPostDispatchHook hook,
        bytes memory metadata,
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
        bytes memory prefixedMetadata = abi.encodePacked(
            StandardHookMetadata.VARIANT,
            metadata
        );
        vm.assume(
            requiredFee < type(uint128).max &&
                defaultFee < type(uint128).max &&
                overrideFee < type(uint128).max
        );
        defaultHook.setFee(defaultFee);
        requiredHook.setFee(requiredFee);
        overrideHook.setFee(overrideFee);

        bytes memory message = mailbox.buildOutboundMessage(
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

        expectHookQuote(requiredHook, prefixedMetadata, message);
        expectHookQuote(defaultHook, prefixedMetadata, message);
        quote = mailbox.quoteDispatch(
            remoteDomain,
            address(recipient).addressToBytes32(),
            body,
            prefixedMetadata
        );
        assertEq(quote, defaultFee + requiredFee);

        expectHookQuote(requiredHook, prefixedMetadata, message);
        expectHookQuote(overrideHook, prefixedMetadata, message);
        quote = mailbox.quoteDispatch(
            remoteDomain,
            address(recipient).addressToBytes32(),
            body,
            prefixedMetadata,
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
        TestPostDispatchHook firstHook,
        TestPostDispatchHook hook,
        bytes memory metadata,
        bytes calldata body
    ) internal {
        bytes memory message = mailbox.buildOutboundMessage(
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
        bytes memory prefixedMetadata = abi.encodePacked(
            StandardHookMetadata.VARIANT,
            metadata
        );
        bytes calldata defaultMetadata = metadata[0:0];
        uint256 quote;
        uint32 nonce;
        bytes32 id;

        for (uint256 i = 0; i < n; i += 3) {
            nonce = mailbox.nonce();
            assertEq(nonce, i);

            // default hook and no metadata
            quote = mailbox.quoteDispatch(remoteDomain, recipientb32, body);
            expectDispatch(requiredHook, defaultHook, defaultMetadata, body);
            id = mailbox.dispatch{value: quote}(
                remoteDomain,
                recipientb32,
                body
            );
            assertEq(mailbox.latestDispatchedId(), id);
            nonce = mailbox.nonce();
            assertEq(nonce, i + 1);

            // default hook with metadata
            quote = mailbox.quoteDispatch(
                remoteDomain,
                recipientb32,
                body,
                prefixedMetadata
            );
            expectDispatch(requiredHook, defaultHook, prefixedMetadata, body);
            id = mailbox.dispatch{value: quote}(
                remoteDomain,
                recipientb32,
                body,
                prefixedMetadata
            );
            assertEq(mailbox.latestDispatchedId(), id);
            nonce = mailbox.nonce();
            assertEq(nonce, i + 2);

            // override default hook with metadata
            quote = mailbox.quoteDispatch(
                remoteDomain,
                recipientb32,
                body,
                prefixedMetadata,
                overrideHook
            );
            expectDispatch(requiredHook, overrideHook, prefixedMetadata, body);
            id = mailbox.dispatch{value: quote}(
                remoteDomain,
                recipientb32,
                body,
                prefixedMetadata,
                overrideHook
            );
            assertEq(mailbox.latestDispatchedId(), id);
            nonce = mailbox.nonce();
            assertEq(nonce, i + 3);
        }
    }

    // for instrumenting gas costs of merkleHook.postDispatch after several insertions
    function test_100dispatch_withMerkleTreeHook(bytes calldata body) public {
        uint256 quote = mailbox.quoteDispatch(
            remoteDomain,
            recipientb32,
            body,
            body[0:0],
            merkleHook
        );
        for (uint256 i = 0; i < 100; i++) {
            mailbox.dispatch{value: quote}(
                remoteDomain,
                recipientb32,
                body,
                body[0:0],
                merkleHook
            );
        }
    }

    event ProcessId(bytes32 indexed messageId);

    event Process(
        uint32 indexed origin,
        bytes32 indexed sender,
        address indexed recipient
    );

    function expectProcess(
        bytes calldata metadata,
        bytes memory message,
        bytes calldata body,
        uint256 value
    ) internal {
        bytes32 sender = msg.sender.addressToBytes32();
        IInterchainSecurityModule ism = mailbox.recipientIsm(
            address(recipient)
        );
        vm.expectEmit(true, true, true, false, address(mailbox));
        emit Process(remoteDomain, sender, address(recipient));
        vm.expectEmit(true, false, false, false, address(mailbox));
        emit ProcessId(message.id());
        vm.expectCall(
            address(ism),
            abi.encodeCall(ism.verify, (metadata, message))
        );
        vm.expectCall(
            address(recipient),
            value,
            abi.encodeCall(recipient.handle, (remoteDomain, sender, body))
        );
    }

    function test_process(
        bytes calldata body,
        bytes calldata metadata,
        uint256 value
    ) public {
        vm.assume(value < address(this).balance);
        bytes memory message = mailbox.buildInboundMessage(
            remoteDomain,
            recipientb32,
            msg.sender.addressToBytes32(),
            body
        );
        bytes32 id = keccak256(message);
        assertEq(mailbox.delivered(id), false);
        expectProcess(metadata, message, body, value);
        mailbox.process{value: value}(metadata, message);
        assertEq(mailbox.delivered(id), true);
        assertEq(mailbox.processor(id), address(this));
        assertEq(mailbox.processedAt(id), uint48(block.number));
    }

    function test_process_revertsWhenAlreadyDelivered() public {
        bytes memory message = mailbox.buildInboundMessage(
            remoteDomain,
            recipientb32,
            address(this).addressToBytes32(),
            "0x"
        );
        mailbox.process("", message);
        vm.expectRevert("Mailbox: already delivered");
        mailbox.process("", message);
    }

    function test_process_revertsWhenBadVersion(bytes calldata body) public {
        bytes memory message = Message.formatMessage(
            VERSION + 1,
            0,
            localDomain,
            address(this).addressToBytes32(),
            remoteDomain,
            recipientb32,
            body
        );
        vm.expectRevert("Mailbox: bad version");
        mailbox.process("", message);
    }

    function test_process_revertsWhenBadDestination(bytes calldata body)
        public
    {
        bytes memory message = Message.formatMessage(
            VERSION,
            0,
            remoteDomain,
            address(this).addressToBytes32(),
            remoteDomain,
            recipientb32,
            body
        );
        vm.expectRevert("Mailbox: unexpected destination");
        mailbox.process("", message);
    }

    function test_process_revertsWhenISMFails(bytes calldata body) public {
        bytes memory message = mailbox.buildInboundMessage(
            remoteDomain,
            recipientb32,
            msg.sender.addressToBytes32(),
            body
        );
        defaultIsm.setVerify(false);
        vm.expectRevert("Mailbox: ISM verification failed");
        mailbox.process("", message);
    }
}
