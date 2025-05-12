// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import {DomainRoutingMailbox} from "../DomainRoutingMailbox.sol";
import {MockMailbox} from "../mock/MockMailbox.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

import {Message} from "../libs/Message.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {MockMessageRecipient} from "../mock/MockMessageRecipient.sol";

contract TestDomainRoutingMailbox is Test {
    using Message for bytes;
    using TypeCasts for address;

    DomainRoutingMailbox internal drm;
    MockMailbox internal mbDefault; // Default mailbox for the DRM
    MockMailbox internal mbSpecific; // A mailbox configured for a specific domain in DRM

    // Remote mailboxes to "receive" dispatched messages for verification purposes
    // These simulate mailboxes on destination chains.
    MockMailbox internal rcvrForMbDefaultAtDest1; // Receives messages from mbDefault targeting REMOTE_DEST_1
    MockMailbox internal rcvrForMbDefaultAtDest2; // Receives messages from mbDefault targeting REMOTE_DEST_2
    MockMailbox internal rcvrForMbSpecificAtDest1; // Receives messages from mbSpecific targeting REMOTE_DEST_1

    address internal owner; // Owner of the DRM
    address internal user = address(0xCAFE); // A general user interacting with the DRM
    address internal messageOriginator = address(0x5E4D); // Logical sender of message content (used in message bytes)

    uint32 internal constant DEFAULT_MB_LOCAL_DOMAIN = 1000; // localDomain of mbDefault
    uint32 internal constant SPECIFIC_MB_LOCAL_DOMAIN = 2000; // localDomain of mbSpecific
    // Note: *_LOCAL_DOMAIN constants represent the domain where a Mailbox instance *thinks* it is deployed.

    uint32 internal constant REMOTE_DEST_1 = 3000; // A destination domain for dispatch tests
    uint32 internal constant REMOTE_DEST_2 = 4000; // Another destination domain for dispatch tests
    uint32 internal constant ORIGIN_DOMAIN_1 = 5000; // An origin domain for process routing tests
    uint32 internal constant UNCONFIGURED_DOMAIN = 9999; // A domain not specifically configured in DRM, to test fallbacks

    bytes32 internal immutable RECIPIENT_BYTES32; // Message recipient (bytes32 format)
    address internal immutable RECIPIENT_ADDR = address(0x4EC1); // Message recipient (address format)
    bytes internal constant DUMMY_MESSAGE_BODY = "ping";
    bytes internal constant EMPTY_METADATA = ""; // Used for ISM metadata or hook metadata

    uint8 internal constant MESSAGE_VERSION = 3;

    constructor() {
        RECIPIENT_BYTES32 = RECIPIENT_ADDR.addressToBytes32();
    }

    function setUp() public {
        owner = address(this); // The test contract itself will be the owner
        vm.deal(user, 10 ether); // Fund the user for payable calls

        // Deploy default mailbox
        mbDefault = new MockMailbox(DEFAULT_MB_LOCAL_DOMAIN);

        // Deploy DomainRoutingMailbox, initializing with mbDefault
        drm = new DomainRoutingMailbox();
        drm.initialize(owner, address(mbDefault));

        // Deploy a mailbox that can be used as a domain-specific one
        mbSpecific = new MockMailbox(SPECIFIC_MB_LOCAL_DOMAIN);

        // Deploy "remote" mailboxes that will act as receivers on destination chains
        rcvrForMbDefaultAtDest1 = new MockMailbox(REMOTE_DEST_1);
        rcvrForMbDefaultAtDest2 = new MockMailbox(REMOTE_DEST_2);
        rcvrForMbSpecificAtDest1 = new MockMailbox(REMOTE_DEST_1);

        // Configure underlying MockMailboxes to "send" messages to these remote receivers
        // This uses MockMailbox's addRemoteMailbox feature for testing dispatch.
        mbDefault.addRemoteMailbox(REMOTE_DEST_1, rcvrForMbDefaultAtDest1);
        mbDefault.addRemoteMailbox(REMOTE_DEST_2, rcvrForMbDefaultAtDest2);
        mbSpecific.addRemoteMailbox(REMOTE_DEST_1, rcvrForMbSpecificAtDest1);
    }

    // Helper to construct a Hyperlane message for testing `process`
    function _buildTestMessage(
        uint32 nonce,
        uint32 originDomain,
        bytes32 sender, // This is message.sender() in Mailbox terms (originator on source chain)
        uint32 destinationDomain,
        bytes32 recipient,
        bytes memory body
    ) internal pure returns (bytes memory) {
        return
            Message.formatMessage(
                MESSAGE_VERSION,
                nonce,
                originDomain,
                sender,
                destinationDomain,
                recipient,
                _memoryToCalldata(body)
            );
    }

    function _memoryToCalldata(
        bytes memory data
    ) internal pure returns (bytes calldata result) {
        assembly {
            result.offset := data
            result.length := mload(data)
        }
    }

    // Test 1: Initialization and Default Mailbox Properties
    function test_InitializationAndDefaultMailboxProperties() public {
        assertEq(drm.owner(), owner, "Owner mismatch");
        assertEq(
            address(drm.defaultMailbox()),
            address(mbDefault),
            "Default mailbox mismatch"
        );

        // Properties that should reflect the defaultMailbox
        assertEq(
            drm.localDomain(),
            mbDefault.localDomain(),
            "localDomain mismatch"
        );
        assertEq(
            address(drm.defaultIsm()),
            address(mbDefault.defaultIsm()),
            "defaultIsm mismatch"
        );
        assertEq(
            address(drm.defaultHook()),
            address(mbDefault.defaultHook()),
            "defaultHook mismatch"
        );
        assertEq(
            address(drm.requiredHook()),
            address(mbDefault.requiredHook()),
            "requiredHook mismatch"
        );
        assertEq(
            drm.latestDispatchedId(),
            mbDefault.latestDispatchedId(),
            "latestDispatchedId mismatch (should be 0)"
        );
    }

    // Test 2: Dispatch Routing - Specific vs Default Mailbox
    function test_DispatchRouting_SpecificVsDefault() public {
        // Configure mbSpecific to handle dispatches to REMOTE_DEST_1
        drm.setDomainMailbox(REMOTE_DEST_1, address(mbSpecific));
        assertEq(
            address(drm.getMailboxForDomain(REMOTE_DEST_1)),
            address(mbSpecific),
            "getMailboxForDomain for REMOTE_DEST_1 failed"
        );

        // Dispatch to REMOTE_DEST_1 (should be routed to mbSpecific)
        vm.prank(user);
        drm.dispatch(REMOTE_DEST_1, RECIPIENT_BYTES32, DUMMY_MESSAGE_BODY);

        // Check if mbSpecific's remote receiver got the message
        assertEq(
            rcvrForMbSpecificAtDest1.inboundUnprocessedNonce(),
            1,
            "REMOTE_DEST_1 msg not on mbSpecific's remote"
        );
        // Check mbDefault's remote receiver for REMOTE_DEST_1 was NOT used
        assertEq(
            rcvrForMbDefaultAtDest1.inboundUnprocessedNonce(),
            0,
            "REMOTE_DEST_1 msg incorrectly on mbDefault's remote"
        );
        // Check nonces of underlying mailboxes
        assertEq(mbSpecific.nonce(), 1, "mbSpecific nonce should increment");
        assertEq(mbDefault.nonce(), 0, "mbDefault nonce should not increment");

        // Dispatch to REMOTE_DEST_2 (should be routed to mbDefault, as no specific mailbox is set for REMOTE_DEST_2)
        assertEq(
            address(drm.getMailboxForDomain(REMOTE_DEST_2)),
            address(mbDefault),
            "getMailboxForDomain for REMOTE_DEST_2 should be default"
        );
        vm.prank(user);
        drm.dispatch(REMOTE_DEST_2, RECIPIENT_BYTES32, DUMMY_MESSAGE_BODY);

        // Check if mbDefault's remote receiver for REMOTE_DEST_2 got the message
        assertEq(
            rcvrForMbDefaultAtDest2.inboundUnprocessedNonce(),
            1,
            "REMOTE_DEST_2 msg not on mbDefault's remote"
        );
        // Check nonces
        assertEq(
            mbDefault.nonce(),
            1,
            "mbDefault nonce should increment for its dispatch"
        );
        assertEq(
            mbSpecific.nonce(),
            1,
            "mbSpecific nonce should remain unchanged"
        );
    }

    // Test 3: Process Routing - Based on Message Origin Domain
    function test_ProcessRouting_ByMessageOrigin() public {
        // Configure mbSpecific to handle messages originating from ORIGIN_DOMAIN_1
        drm.setDomainMailbox(ORIGIN_DOMAIN_1, address(mbSpecific));
        assertEq(
            address(drm.getMailboxForDomain(ORIGIN_DOMAIN_1)),
            address(mbSpecific)
        );

        // Deploy a MockMessageRecipient at the RECIPIENT_ADDR to handle the delivered messages
        vm.etch(RECIPIENT_ADDR, address(new MockMessageRecipient()).code);

        // Message 1: Originates from ORIGIN_DOMAIN_1.
        // For `process` to succeed on `mbSpecific`, message destination must match `mbSpecific.localDomain()`.
        bytes memory messageFromOrigin1 = _buildTestMessage(
            1,
            ORIGIN_DOMAIN_1,
            messageOriginator.addressToBytes32(),
            SPECIFIC_MB_LOCAL_DOMAIN,
            RECIPIENT_BYTES32,
            DUMMY_MESSAGE_BODY
        );
        bytes32 messageId1 = messageFromOrigin1.id();

        vm.prank(user); // Relayer/processor
        // Expect ProcessId event from mbSpecific
        vm.expectEmit(true, true, true, true, address(mbSpecific));
        emit IMailbox.ProcessId(messageId1);
        drm.process(EMPTY_METADATA, messageFromOrigin1);
        // Verify mbSpecific marked it as delivered
        assertTrue(
            mbSpecific.delivered(messageId1),
            "Message1 not delivered by mbSpecific"
        );

        // Message 2: Originates from UNCONFIGURED_DOMAIN.
        // Should be processed by mbDefault. Message destination must match `mbDefault.localDomain()`.
        bytes memory messageFromUnconfiguredOrigin = _buildTestMessage(
            2,
            UNCONFIGURED_DOMAIN,
            messageOriginator.addressToBytes32(),
            DEFAULT_MB_LOCAL_DOMAIN,
            RECIPIENT_BYTES32,
            DUMMY_MESSAGE_BODY
        );
        bytes32 messageId2 = messageFromUnconfiguredOrigin.id();

        vm.prank(user); // Relayer/processor
        // Expect ProcessId event from mbDefault
        vm.expectEmit(true, true, true, true, address(mbDefault));
        emit IMailbox.ProcessId(messageId2);
        drm.process(EMPTY_METADATA, messageFromUnconfiguredOrigin);
        // Verify mbDefault marked it as delivered
        assertTrue(
            mbDefault.delivered(messageId2),
            "Message2 not delivered by mbDefault"
        );
    }

    // Test 4: Delivered and DeliveredForOrigin Routing Logic
    function test_DeliveredAndDeliveredForOriginRouting() public {
        // Configure mbSpecific to be the mailbox for ORIGIN_DOMAIN_1
        drm.setDomainMailbox(ORIGIN_DOMAIN_1, address(mbSpecific));

        // Message 1: Processed by mbDefault directly.
        // (Origin is UNCONFIGURED_DOMAIN, destination is DEFAULT_MB_LOCAL_DOMAIN)
        bytes memory msgForDefaultMailbox = _buildTestMessage(
            1,
            UNCONFIGURED_DOMAIN,
            messageOriginator.addressToBytes32(),
            DEFAULT_MB_LOCAL_DOMAIN,
            RECIPIENT_BYTES32,
            "msg1_for_default"
        );
        bytes32 id1 = msgForDefaultMailbox.id();

        // Instead of adding the message to mbDefault directly and processing it,
        // let's simulate a completed process through drm by manually marking the message as delivered
        // in mbDefault without actually processing it
        vm.mockCall(
            address(mbDefault),
            abi.encodeWithSelector(IMailbox.delivered.selector, id1),
            abi.encode(true)
        );

        // Message 2: Processed by mbSpecific directly.
        // (Origin is ORIGIN_DOMAIN_1, destination is SPECIFIC_MB_LOCAL_DOMAIN)
        bytes memory msgForSpecificMailbox = _buildTestMessage(
            2,
            ORIGIN_DOMAIN_1,
            messageOriginator.addressToBytes32(),
            SPECIFIC_MB_LOCAL_DOMAIN,
            RECIPIENT_BYTES32,
            "msg2_for_specific"
        );
        bytes32 id2 = msgForSpecificMailbox.id();

        // Similarly, we mock the response for mbSpecific
        vm.mockCall(
            address(mbSpecific),
            abi.encodeWithSelector(IMailbox.delivered.selector, id2),
            abi.encode(true)
        );

        // Check drm.delivered(messageId) - always queries defaultMailbox (mbDefault)
        assertTrue(
            drm.delivered(id1),
            "drm.delivered(id1) should be true (checked on mbDefault)"
        );
        assertFalse(
            drm.delivered(id2),
            "drm.delivered(id2) should be false (checked on mbDefault, but id2 processed by mbSpecific)"
        );

        // Check drm.deliveredForOrigin(messageId, originDomain)
        // For id1 (processed by mbDefault):
        // Querying with UNCONFIGURED_DOMAIN routes to mbDefault
        assertTrue(
            drm.deliveredForOrigin(id1, UNCONFIGURED_DOMAIN),
            "deliveredForOrigin(id1, UNCONFIGURED_DOMAIN) should be true (via mbDefault)"
        );
        // Querying with ORIGIN_DOMAIN_1 routes to mbSpecific
        assertFalse(
            drm.deliveredForOrigin(id1, ORIGIN_DOMAIN_1),
            "deliveredForOrigin(id1, ORIGIN_DOMAIN_1) should be false (via mbSpecific)"
        );

        // For id2 (processed by mbSpecific):
        // Querying with UNCONFIGURED_DOMAIN routes to mbDefault
        assertFalse(
            drm.deliveredForOrigin(id2, UNCONFIGURED_DOMAIN),
            "deliveredForOrigin(id2, UNCONFIGURED_DOMAIN) should be false (via mbDefault)"
        );
        // Querying with ORIGIN_DOMAIN_1 routes to mbSpecific
        assertTrue(
            drm.deliveredForOrigin(id2, ORIGIN_DOMAIN_1),
            "deliveredForOrigin(id2, ORIGIN_DOMAIN_1) should be true (via mbSpecific)"
        );
    }

    // Test 5: Removing a Domain-Specific Mailbox and Verifying Fallback
    function test_RemoveDomainMailboxAndFallback() public {
        // 1. Set mbSpecific for REMOTE_DEST_1
        drm.setDomainMailbox(REMOTE_DEST_1, address(mbSpecific));
        assertEq(
            address(drm.getMailboxForDomain(REMOTE_DEST_1)),
            address(mbSpecific),
            "Initial setDomainMailbox failed"
        );
        assertEq(
            drm.getSpecificDomainMailbox(REMOTE_DEST_1),
            address(mbSpecific),
            "getSpecificDomainMailbox check failed"
        );

        // 2. Dispatch to REMOTE_DEST_1 (should use mbSpecific)
        vm.prank(user);
        drm.dispatch(REMOTE_DEST_1, RECIPIENT_BYTES32, DUMMY_MESSAGE_BODY);
        assertEq(
            rcvrForMbSpecificAtDest1.inboundUnprocessedNonce(),
            1,
            "Msg not on mbSpecific's remote before removal"
        );
        assertEq(
            rcvrForMbDefaultAtDest1.inboundUnprocessedNonce(),
            0,
            "Msg incorrectly on mbDefault's remote before removal"
        );
        uint256 mbSpecificNonceBeforeRemoval = mbSpecific.nonce(); // Should be 1
        uint256 mbDefaultNonceBeforeRemoval = mbDefault.nonce(); // Should be 0

        // 3. Remove domain-specific mailbox for REMOTE_DEST_1 (set to address(0))
        drm.setDomainMailbox(REMOTE_DEST_1, address(0));
        assertEq(
            address(drm.getMailboxForDomain(REMOTE_DEST_1)),
            address(mbDefault),
            "Fallback to default mailbox failed after removal"
        );
        assertEq(
            drm.getSpecificDomainMailbox(REMOTE_DEST_1),
            address(0),
            "Specific domain mailbox not cleared"
        );

        // 4. Dispatch to REMOTE_DEST_1 again (should now use mbDefault due to fallback)
        vm.prank(user);
        drm.dispatch(REMOTE_DEST_1, RECIPIENT_BYTES32, DUMMY_MESSAGE_BODY);
        // Check mbSpecific's remote receiver - should NOT have new messages
        assertEq(
            rcvrForMbSpecificAtDest1.inboundUnprocessedNonce(),
            1,
            "mbSpecific's remote nonce changed after its removal"
        );
        // Check mbDefault's remote receiver for REMOTE_DEST_1 - SHOULD have a new message
        assertEq(
            rcvrForMbDefaultAtDest1.inboundUnprocessedNonce(),
            1,
            "Msg not on mbDefault's remote after fallback"
        );

        // Check nonces of underlying mailboxes
        assertEq(
            mbSpecific.nonce(),
            mbSpecificNonceBeforeRemoval,
            "mbSpecific nonce changed after its removal as handler"
        );
        assertEq(
            mbDefault.nonce(),
            mbDefaultNonceBeforeRemoval + 1,
            "mbDefault nonce did not increment after fallback dispatch"
        );
    }
}
