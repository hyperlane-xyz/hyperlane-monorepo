// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.15;

import "forge-std/Test.sol";
import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {ICrossL2ProverV2} from "@polymerdao/prover-contracts/contracts/interfaces/ICrossL2ProverV2.sol";
import {PolymerISM} from "../../contracts/isms/PolymerISM.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";

contract MockCrossL2Prover is ICrossL2ProverV2 {
    uint32 public expectedChainId;
    address public expectedEmitter;
    bytes public expectedTopics;
    bytes public expectedData;
    bool public shouldRevertValidateEvent;

    function setExpectedEvent(
        uint32 chainId,
        address emitter,
        bytes memory topics,
        bytes memory data
    ) external {
        expectedChainId = chainId;
        expectedEmitter = emitter;
        expectedTopics = topics;
        expectedData = data;
        shouldRevertValidateEvent = false; // Default to not reverting
    }

    function setShouldRevert(bool _revert) external {
        shouldRevertValidateEvent = _revert;
    }

    function validateEvent(
        bytes calldata proof
    )
        external
        view
        override
        returns (
            uint32 chainId,
            address emittingContract,
            bytes memory topics,
            bytes memory unindexedData
        )
    {
        if (shouldRevertValidateEvent) {
            revert("MockCrossL2Prover: Forced revert");
        }
        return (expectedChainId, expectedEmitter, expectedTopics, expectedData);
    }

    // --- Unused ICrossL2ProverV2 functions ---
    function inspectLogIdentifier(
        bytes calldata proof
    )
        external
        pure
        override
        returns (
            uint32 srcChain,
            uint64 blockNumber,
            uint16 receiptIndex,
            uint8 logIndex
        )
    {
        return (0, 0, 0, 0);
    }

    function inspectPolymerState(
        bytes calldata proof
    )
        external
        pure
        override
        returns (bytes32 stateRoot, uint64 height, bytes memory signature)
    {
        return (bytes32(0), 0, "");
    }
}

// --- Test Contract ---
contract PolymerISMTest is Test {
    using Message for bytes;
    using TypeCasts for address;
    using TypeCasts for bytes32;

    // --- Constants & Test Setup ---
    uint32 constant TEST_VERSION = 0;
    uint32 constant TEST_NONCE = 1;
    uint32 constant TEST_ORIGIN_DOMAIN = 1000;
    uint32 constant TEST_LOCAL_DOMAIN = 2000;
    address constant TEST_SENDER_ADDR = address(0x111);
    address constant TEST_RECIPIENT_ADDR = address(0x222);
    bytes constant TEST_MESSAGE_BODY = "test message body";
    address constant TEST_ORIGIN_MAILBOX = address(0xABCDEF123);
    address constant TEST_POLYMER_PROVER_ADDR = address(0xDEADBEEF);
    bytes constant DUMMY_PROOF = hex"01";
    bytes32 public TEST_SENDER_BYTES32;
    bytes32 public TEST_RECIPIENT_BYTES32;

    // --- State ---
    MockCrossL2Prover public mockProver;
    PolymerISM public polymerIsm;
    bytes public testMessage;
    bytes public testEncodedDispatchData;
    bytes public testEncodedDispatchTopics;

    // --- Events ---
    event PolymerISMConfigured(
        address indexed polymerProver,
        address indexed originMailbox
    );

    // --- Setup ---
    function setUp() public {
        vm.chainId(TEST_LOCAL_DOMAIN); // Set the chain ID for block.chainid
        mockProver = new MockCrossL2Prover();
        polymerIsm = new PolymerISM(address(mockProver), TEST_ORIGIN_MAILBOX);

        // Initialize bytes32 state variables
        TEST_SENDER_BYTES32 = TEST_SENDER_ADDR.addressToBytes32();
        TEST_RECIPIENT_BYTES32 = TEST_RECIPIENT_ADDR.addressToBytes32();

        // Construct testMessage directly using abi.encodePacked, bypassing Message.formatMessage
        testMessage = abi.encodePacked(
            uint8(TEST_VERSION),
            TEST_NONCE,
            TEST_ORIGIN_DOMAIN,
            TEST_SENDER_BYTES32,
            TEST_LOCAL_DOMAIN,
            TEST_RECIPIENT_BYTES32,
            TEST_MESSAGE_BODY
        );

        // Pre-calculate expected event data/topics for the mock prover
        (
            testEncodedDispatchTopics,
            testEncodedDispatchData
        ) = _encodeDispatchEventData(
            TEST_SENDER_ADDR, // The actual sender of the dispatch call
            TEST_LOCAL_DOMAIN, // Destination domain in dispatch
            TEST_RECIPIENT_BYTES32, // Recipient in dispatch
            testMessage // The *full* message bytes passed in Dispatch
        );
    }

    // --- Helper ---
    /**
     * @dev Simulates the ABI encoding of the Hyperlane Mailbox Dispatch event.
     * event Dispatch(
     *     address indexed sender,
     *     uint32 indexed destination,
     *     bytes32 indexed recipient,
     *     bytes message // non-indexed
     * );
     */
    function _encodeDispatchEventData(
        address _sender,
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes memory _messageBody
    ) internal pure returns (bytes memory topics, bytes memory data) {
        // Define locally to avoid potential lookup issues
        bytes32 DISPATCH_EVENT_SIGNATURE_LOCAL = 0x8a14c3cf157c13a16c714580a137977637f7e9e699b36f5b7ad738f3d04d36d1;

        bytes32 topic0 = DISPATCH_EVENT_SIGNATURE_LOCAL;
        // Topic 1: Indexed sender (address padded)
        bytes32 topic1 = bytes32(uint256(uint160(_sender)));
        // Topic 2: Indexed destination (uint32 padded)
        bytes32 topic2 = bytes32(uint256(_destinationDomain));
        // Topic 3: Indexed recipient (bytes32)
        bytes32 topic3 = _recipientAddress;

        // Pack topics
        topics = abi.encodePacked(topic0, topic1, topic2, topic3);

        // Encode non-indexed data
        data = abi.encode(_messageBody);

        return (topics, data);
    }

    // ============ Constructor Tests ============

    function test_Constructor_Success() public {
        assertEq(address(polymerIsm.polymerProver()), address(mockProver));
        assertEq(polymerIsm.originMailbox(), TEST_ORIGIN_MAILBOX);
    }

    function test_Constructor_EmitEvent() public {
        // Redeploy within test to capture event
        vm.expectEmit(true, true, true, true);
        emit PolymerISMConfigured(
            address(mockProver), // Use the mock prover address here
            TEST_ORIGIN_MAILBOX
        );
        new PolymerISM(address(mockProver), TEST_ORIGIN_MAILBOX);
    }

    function test_Revert_Constructor_ZeroProver() public {
        vm.expectRevert("PolymerISM: Invalid polymer prover address");
        new PolymerISM(address(0), TEST_ORIGIN_MAILBOX);
    }

    function test_Revert_Constructor_ZeroMailbox() public {
        vm.expectRevert("PolymerISM: Invalid origin mailbox address");
        new PolymerISM(address(mockProver), address(0));
    }

    function test_Revert_Constructor_ZeroOriginDomain() public {
        vm.expectRevert("PolymerISM: Invalid origin domain");
        new PolymerISM(
            address(mockProver),
            TEST_ORIGIN_MAILBOX,
            0,
            TEST_LOCAL_DOMAIN
        );
    }

    function test_Revert_Constructor_ZeroLocalDomain() public {
        vm.expectRevert("PolymerISM: Invalid local domain");
        new PolymerISM(
            address(mockProver),
            TEST_ORIGIN_MAILBOX,
            TEST_ORIGIN_DOMAIN,
            0
        );
    }

    function test_Revert_Constructor_SameDomains() public {
        vm.expectRevert("PolymerISM: Domains cannot be the same");
        new PolymerISM(
            address(mockProver),
            TEST_ORIGIN_MAILBOX,
            TEST_ORIGIN_DOMAIN,
            TEST_ORIGIN_DOMAIN // Same domain
        );
    }

    // ============ ModuleType Test ============

    function test_ModuleType() public {
        // Check against the hardcoded value in PolymerISM.sol
        uint8 expectedType = 12;
        assertEq(
            IInterchainSecurityModule(address(polymerIsm)).moduleType(),
            expectedType,
            "ModuleType mismatch"
        );
    }

    // ============ Verify Tests ============

    function test_Verify_Success() public {
        // Configure mock prover to return expected values for a valid proof
        mockProver.setExpectedEvent(
            TEST_ORIGIN_DOMAIN, // Chain ID from proof must match message's origin
            TEST_ORIGIN_MAILBOX, // Emitter must match ISM's originMailbox
            testEncodedDispatchTopics, // Topics matching the Dispatch event structure
            testEncodedDispatchData // Data matching the abi.encode(testMessage)
        );

        // Call verify with dummy proof bytes and the matching message
        bool result = polymerIsm.verify(DUMMY_PROOF, testMessage);
        assertTrue(result, "Verification should succeed");
    }

    function test_Revert_Verify_ProverReverts() public {
        // Configure mock prover to revert
        mockProver.setShouldRevert(true);

        vm.expectRevert("MockCrossL2Prover: Forced revert");
        polymerIsm.verify(DUMMY_PROOF, testMessage);
    }

    function test_Revert_Verify_EmptyProof() public {
        vm.expectRevert("PolymerISM: Empty proof");
        polymerIsm.verify(bytes(""), testMessage); // Empty proof bytes
    }

    function test_Revert_Verify_WrongOriginChain() public {
        uint32 wrongOriginDomain = TEST_ORIGIN_DOMAIN + 1;
        mockProver.setExpectedEvent(
            wrongOriginDomain, // Different chain ID
            TEST_ORIGIN_MAILBOX,
            testEncodedDispatchTopics,
            testEncodedDispatchData
        );

        vm.expectRevert("PolymerISM: Message origin mismatch");
        polymerIsm.verify(DUMMY_PROOF, testMessage);
    }

    function test_Revert_Verify_WrongEmitter() public {
        address wrongEmitter = address(0xBAD);
        mockProver.setExpectedEvent(
            TEST_ORIGIN_DOMAIN,
            wrongEmitter, // Different emitter
            testEncodedDispatchTopics,
            testEncodedDispatchData
        );

        vm.expectRevert("PolymerISM: Proof emitter mismatch (origin mailbox)");
        polymerIsm.verify(DUMMY_PROOF, testMessage);
    }

    function test_Revert_Verify_InvalidTopicsLength() public {
        bytes memory wrongTopics = hex"010203"; // Incorrect length
        mockProver.setExpectedEvent(
            TEST_ORIGIN_DOMAIN,
            TEST_ORIGIN_MAILBOX,
            wrongTopics, // Topics with wrong length
            testEncodedDispatchData
        );

        vm.expectRevert(
            "PolymerISM: Invalid packed topics length for Dispatch event"
        );
        polymerIsm.verify(DUMMY_PROOF, testMessage);
    }

    function test_Revert_Verify_WrongEventSignature() public {
        // Create topics with a wrong signature (topic0)
        bytes32 wrongSignature = keccak256("WrongEvent(address,uint32)");
        (bytes memory originalTopics, ) = _encodeDispatchEventData(
            TEST_SENDER_ADDR,
            TEST_LOCAL_DOMAIN,
            TEST_RECIPIENT_BYTES32,
            testMessage
        );
        // Manually construct the wrong topics bytes array to avoid slicing/packing issues with formatter
        bytes memory wrongTopics = new bytes(128); // 4 * 32 bytes

        // Copy wrong signature (bytes 0-31)
        for (uint i = 0; i < 32; i++) {
            wrongTopics[i] = bytes1(wrongSignature[i]);
        }
        // Copy original topics 1, 2, 3 (bytes 32-127)
        for (uint i = 32; i < 128; i++) {
            wrongTopics[i] = originalTopics[i];
        }

        mockProver.setExpectedEvent(
            TEST_ORIGIN_DOMAIN,
            TEST_ORIGIN_MAILBOX,
            wrongTopics, // Topics with wrong signature
            testEncodedDispatchData
        );

        vm.expectRevert("PolymerISM: Invalid event signature in proof");
        polymerIsm.verify(DUMMY_PROOF, testMessage);
    }

    function test_Revert_Verify_WrongDestinationInProof() public {
        uint32 wrongDestinationDomain = TEST_LOCAL_DOMAIN + 1;

        // Regenerate topics with the wrong destination domain
        (bytes memory wrongTopics, ) = _encodeDispatchEventData(
            TEST_SENDER_ADDR,
            wrongDestinationDomain, // Use wrong destination here
            TEST_RECIPIENT_BYTES32,
            testMessage
        );

        mockProver.setExpectedEvent(
            TEST_ORIGIN_DOMAIN,
            TEST_ORIGIN_MAILBOX,
            wrongTopics, // Use the topics with the wrong destination encoded
            testEncodedDispatchData
        );

        vm.expectRevert(
            "PolymerISM: Proof destination mismatch (local domain)"
        );
        polymerIsm.verify(DUMMY_PROOF, testMessage);
    }

    function test_Revert_Verify_MessageContentMismatch_Data() public {
        // Proof data contains abi.encode(testMessage)
        // But we pass a different message body to verify()
        bytes memory differentMessage = abi.encodePacked(testMessage, hex"01");

        mockProver.setExpectedEvent(
            TEST_ORIGIN_DOMAIN,
            TEST_ORIGIN_MAILBOX,
            testEncodedDispatchTopics,
            testEncodedDispatchData // Mock returns data matching 'testMessage'
        );

        vm.expectRevert("PolymerISM: Proof message content mismatch");
        polymerIsm.verify(DUMMY_PROOF, differentMessage); // Verify against a *different* message
    }

    function test_Revert_Verify_MessageContentMismatch_ProofData() public {
        // Mock returns data for a *different* message than the one we pass to verify
        bytes memory differentMessageInProof = abi.encodePacked(
            testMessage,
            hex"01"
        );
        bytes memory differentEncodedData = abi.encode(differentMessageInProof); // Encode the different message

        mockProver.setExpectedEvent(
            TEST_ORIGIN_DOMAIN,
            TEST_ORIGIN_MAILBOX,
            testEncodedDispatchTopics,
            differentEncodedData // Mock returns data for a different message
        );

        vm.expectRevert("PolymerISM: Proof message content mismatch");
        polymerIsm.verify(DUMMY_PROOF, testMessage); // Verify against the original message
    }
}
