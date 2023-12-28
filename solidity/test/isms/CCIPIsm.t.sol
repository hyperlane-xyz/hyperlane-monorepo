// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import "forge-std/console.sol";

import {LibBit} from "../../contracts/libs/LibBit.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MessageUtils} from "./IsmTestUtils.sol";
import {CCIPIsm} from "../../contracts/isms/hook/CCIPIsm.sol";
import {CCIPHook} from "../../contracts/hooks/CCIPHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {NotCrossChainCall} from "@openzeppelin/contracts/crosschain/errors.sol";

// ============ External Imports ============
import {IRouterClient} from "@chainlink/contracts-ccip/src/v0.8/ccip/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/src/v0.8/ccip/libraries/Client.sol";
import {EVM2EVMOnRamp} from "@chainlink/contracts-ccip/src/v0.8/ccip/onRamp/EVM2EVMOnRamp.sol";

contract CCIPIsmTest is Test {
    using LibBit for uint256;
    using TypeCasts for address;
    using MessageUtils for bytes;

    uint256 internal mainnetFork;
    uint256 internal optimismFork;

    address internal constant MAINNET_ROUTER_ADDRESS =
        0xE561d5E02207fb5eB32cca20a699E0d8919a1476; // Ethereum CCIP Router
    address internal constant OP_ROUTER_ADDRESS =
        0x261c05167db67B2b619f9d312e0753f3721ad6E8; // Optimism CCIP Router

    uint8 internal constant CHAINLINK_VERSION = 0;
    uint8 internal constant HYPERLANE_VERSION = 1;

    address internal alice = address(0x1);

    TestMailbox internal l1Mailbox;
    TestMailbox internal l2Mailbox;
    CCIPIsm internal ccipISMOptimism;
    CCIPHook internal ccipHookMainnet;
    IRouterClient internal iRouterMainnet;
    IRouterClient internal iRouterOptimism;

    TestRecipient internal testRecipient;
    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");
    bytes internal testMetadata;

    bytes internal encodedMessage;
    bytes32 internal messageId;

    uint32 internal constant MAINNET_DOMAIN = 1;
    uint32 internal constant OPTIMISM_DOMAIN = 101241;
    uint64 internal constant MAINNET_CHAIN_SELECTOR = 5009297550715157269;
    uint64 internal constant OPTIMISM_CHAIN_SELECTOR = 3734403246176062136;

    event MessageSent(
      bytes32 indexed messageId, // The unique ID of the CCIP message.
      uint64 indexed destinationChainSelector, // The chain selector of the destination chain.
      address receiver, // The address of the receiver on the destination chain.
      bytes callData, // The payload being sent
      address feeToken, // the token address used to pay CCIP fees.
      uint256 fees // The fees paid for sending the CCIP message.
    );

    // Event emitted when a message is received from another chain.
    event MessageReceived(
      bytes32 indexed messageId, // The unique ID of the CCIP message.
      uint64 indexed sourceChainSelector, // The chain selector of the source chain.
      address sender, // The address of the sender from the source chain.
      bytes32 payload // The payload that was received.
    );

    event ReceivedMessage(bytes32 indexed messageId);

    function setUp() public {
        // block numbers to fork from, chain data is cached to ../../forge-cache/
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"), 18_787_859);
        optimismFork = vm.createFork(vm.rpcUrl("optimism"), 106_233_774);

        testRecipient = new TestRecipient();

        encodedMessage = _encodeTestMessage();
        messageId = Message.id(encodedMessage);
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployCCIPHookAndISMMainnet() public {
        vm.selectFork(mainnetFork);

        l1Mailbox = new TestMailbox(MAINNET_DOMAIN);

        ccipHookMainnet = new CCIPHook(
            MAINNET_ROUTER_ADDRESS,
            address(l1Mailbox)
        );

        ccipHookMainnet.addDestinationChainToAllowlist(OPTIMISM_CHAIN_SELECTOR, true);

        vm.makePersistent(address(ccipHookMainnet), MAINNET_ROUTER_ADDRESS);
    }

    function deployCCIPHookAndISMOptimism() public {
        vm.selectFork(optimismFork);

        l2Mailbox = new TestMailbox(MAINNET_DOMAIN);

        ccipISMOptimism = new CCIPIsm(OP_ROUTER_ADDRESS);

        ccipISMOptimism.addSourceChainToAllowlist(MAINNET_CHAIN_SELECTOR, true);
        ccipISMOptimism.setAuthorizedHook(TypeCasts.addressToBytes32(address(OP_ROUTER_ADDRESS)));

        vm.makePersistent(address(ccipISMOptimism), OP_ROUTER_ADDRESS);
    }

    function deployAll() public {
        deployCCIPHookAndISMMainnet();
        deployCCIPHookAndISMOptimism();

        vm.selectFork(optimismFork);
        ccipISMOptimism.addSenderToAllowlist(address(ccipHookMainnet), true);

        // for sending value
        vm.deal(
            OP_ROUTER_ADDRESS,
            2 ** 255
        );
    }

    ///////////////////////////////////////////////////////////////////
    ///                         FORK TESTS                          ///
    ///////////////////////////////////////////////////////////////////

    /* ============ hook.quoteDispatch ============ */

    function testFork_quoteDispatch() public {
        deployAll();

        vm.selectFork(mainnetFork);

        testMetadata = _buildMetadata(OPTIMISM_CHAIN_SELECTOR, address(ccipISMOptimism));

        assert(ccipHookMainnet.quoteDispatch(testMetadata, encodedMessage) > 0);
    }

    /* ============ hook.postDispatch ============ */

    function testFork_postDispatch() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes memory encodedHookData = abi.encode(messageId);
        testMetadata = _buildMetadata(OPTIMISM_CHAIN_SELECTOR, address(ccipISMOptimism));

        _allowAnyAddressToSendCCIP();

        l1Mailbox.updateLatestDispatchedId(messageId);

        uint256 quotedFee = ccipHookMainnet.quoteDispatch(testMetadata, encodedMessage);

        vm.expectEmit(false, true, false, false, address(ccipHookMainnet));
        emit MessageSent(
            bytes32(0),
            OPTIMISM_CHAIN_SELECTOR,
            address(ccipISMOptimism),
            bytes(encodedHookData),
            address(0),
            8891396275644
        );

        ccipHookMainnet.postDispatch{value: quotedFee * 11 / 10}(testMetadata, encodedMessage);
    }

    function testFork_postDispatch_RevertWhen_CCIPChainSelectorNotSupported() public {
        deployAll();

        vm.selectFork(mainnetFork);

        _allowAnyAddressToSendCCIP();

        l1Mailbox.updateLatestDispatchedId(messageId);

        testMetadata = _buildMetadata(MAINNET_CHAIN_SELECTOR, address(ccipISMOptimism));

        bytes4 selector = bytes4(keccak256("DestinationChainNotAllowlisted(uint64)"));
        vm.expectRevert(abi.encodeWithSelector(selector, MAINNET_CHAIN_SELECTOR));
    
        ccipHookMainnet.postDispatch{value: 1 ether}(testMetadata, encodedMessage);
    }

    function testFork_postDispatch_RevertWhen_NotEnoughValueSent() public {
        deployAll();

        vm.selectFork(mainnetFork);

        _allowAnyAddressToSendCCIP();

        l1Mailbox.updateLatestDispatchedId(messageId);

        vm.expectRevert();
    
        ccipHookMainnet.postDispatch(testMetadata, encodedMessage);
    }

    function testFork_postDispatch_RevertWhen_NotLastDispatchedMessage()
        public
    {
        deployAll();

        vm.selectFork(mainnetFork);

        _allowAnyAddressToSendCCIP();

        vm.expectRevert(
            "AbstractMessageIdAuthHook: message not latest dispatched"
        );

        ccipHookMainnet.postDispatch(testMetadata, encodedMessage);
    }

    // /* ============ ISM.verifyMessageId ============ */

    function testFork_verifyMessageId() public {
        deployAll();

        vm.selectFork(optimismFork);

        vm.startPrank(
            OP_ROUTER_ADDRESS
        );
        
        Client.Any2EVMMessage memory message = _encodeCCIPReceiveMessage();

        vm.expectEmit(true, false, false, true, address(ccipISMOptimism));
        emit ReceivedMessage(messageId);

        vm.expectEmit(true, true, false, true, address(ccipISMOptimism));
        emit MessageReceived(
            messageId,
            MAINNET_CHAIN_SELECTOR,
            address(ccipHookMainnet),
            messageId
        );

        ccipISMOptimism.ccipReceive(message);

        // assertTrue(ccipISMOptimism.verifiedMessages(messageId).isBitSet(255));

        vm.stopPrank();
    }

    function testFork_verifyMessageId_RevertWhen_NotAuthorized() public {
        deployAll();

        vm.selectFork(optimismFork);

        vm.expectRevert(
            "AbstractMessageIdAuthorizedIsm: sender is not the hook"
        );
        ccipISMOptimism.verifyMessageId(messageId);
    }

    function testFork_verifyMessageId_RevertWhen_SenderNotAllowed() public {
        deployAll();

        vm.selectFork(optimismFork);

        vm.startPrank(
            OP_ROUTER_ADDRESS
        );

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );
        
        Client.EVMTokenAmount[] memory empty_tokens;

        Client.Any2EVMMessage memory message = Client.Any2EVMMessage(
            messageId,
            MAINNET_CHAIN_SELECTOR,
            abi.encode(address(ccipISMOptimism)),
            encodedHookData,
            empty_tokens      
        );
        
        bytes4 selector = bytes4(keccak256("SenderNotAllowlisted(address)"));
        vm.expectRevert(abi.encodeWithSelector(selector, address(ccipISMOptimism)));

        ccipISMOptimism.ccipReceive(message);

        vm.stopPrank();
    }

    function testFork_verifyMessageId_RevertWhen_SourceChainNotAllowed() public {
        deployAll();

        vm.selectFork(optimismFork);

        vm.startPrank(
            OP_ROUTER_ADDRESS
        );

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );
        
        Client.EVMTokenAmount[] memory empty_tokens;

        Client.Any2EVMMessage memory message = Client.Any2EVMMessage(
            messageId,
            OPTIMISM_CHAIN_SELECTOR,
            abi.encode(address(ccipHookMainnet)),
            encodedHookData,
            empty_tokens      
        );
        
        bytes4 selector = bytes4(keccak256("SourceChainNotAllowlisted(uint64)"));
        vm.expectRevert(abi.encodeWithSelector(selector, OPTIMISM_CHAIN_SELECTOR));

        ccipISMOptimism.ccipReceive(message);

        vm.stopPrank();
    }

    function testFork_verifyMessageId_RevertWhen_InvalidRouter() public {
        deployAll();

        vm.selectFork(optimismFork);

        vm.startPrank(
            MAINNET_ROUTER_ADDRESS
        );

        Client.Any2EVMMessage memory message = _encodeCCIPReceiveMessage();

        bytes4 selector = bytes4(keccak256("InvalidRouter(address)"));
        vm.expectRevert(abi.encodeWithSelector(selector, MAINNET_ROUTER_ADDRESS));

        ccipISMOptimism.ccipReceive(message);

        vm.stopPrank();
    }

    /* ============ ISM.verify ============ */

    function testFork_verify() public {
        deployAll();

        orchestrateRelayMessage(messageId);

        bool verified = ccipISMOptimism.verify(new bytes(0), encodedMessage);
        assertTrue(verified);
    }

    // sending over invalid message
    function testFork_verify_RevertWhen_HyperlaneInvalidMessage() public {
        deployAll();

        orchestrateRelayMessage(messageId);

        bytes memory invalidMessage = MessageUtils.formatMessage(
            HYPERLANE_VERSION,
            uint8(0),
            MAINNET_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            OPTIMISM_DOMAIN,
            TypeCasts.addressToBytes32(address(this)), // wrong recipient
            testMessage
        );

        bool verified = ccipISMOptimism.verify(new bytes(0), invalidMessage);
        assertFalse(verified);
    }

    // invalid messageID in postDispatch
    function testFork_verify_RevertWhen_InvalidOptimismMessageID() public {
        deployAll();

        bytes memory invalidMessage = MessageUtils.formatMessage(
            HYPERLANE_VERSION,
            uint8(0),
            MAINNET_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            OPTIMISM_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            testMessage
        );
        bytes32 _messageId = Message.id(invalidMessage);
        orchestrateRelayMessage(_messageId);

        bool verified = ccipISMOptimism.verify(new bytes(0), encodedMessage);
        assertFalse(verified);
    }

    /* ============ helper functions ============ */
    
    function _buildMetadata(
        uint64 _destinationChainSelector,
        address _receiver
    ) internal view returns (bytes memory) {
        bytes memory customMetadata = abi.encode(_destinationChainSelector, _receiver);
        return
            StandardHookMetadata.formatMetadata(
                0,
                0,
                msg.sender,
                customMetadata
            );
    }

    function _encodeTestMessage() internal view returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                HYPERLANE_VERSION,
                uint32(0),
                MAINNET_DOMAIN,
                TypeCasts.addressToBytes32(address(this)),
                OPTIMISM_DOMAIN,
                TypeCasts.addressToBytes32(address(testRecipient)),
                testMessage
            );
    }

    function _allowAnyAddressToSendCCIP() internal {
        EVM2EVMOnRamp onRamp = EVM2EVMOnRamp(0xCC19bC4D43d17eB6859F0d22BA300967C97780b0);
        vm.prank(0x44835bBBA9D40DEDa9b64858095EcFB2693c9449); // Current Owner
        onRamp.setAllowListEnabled(false); // Only authorized addresses can call CCIP send
    }

    function _encodeCCIPReceiveMessage() internal view returns (Client.Any2EVMMessage memory) {
        bytes memory encodedHookData = abi.encode(messageId);
        
        Client.EVMTokenAmount[] memory empty_tokens;

        return Client.Any2EVMMessage(
            messageId,
            MAINNET_CHAIN_SELECTOR,
            abi.encode(address(ccipHookMainnet)),
            encodedHookData,
            empty_tokens      
        );
    }

    function orchestrateRelayMessage(
        bytes32 _messageId
    ) internal {
        vm.selectFork(optimismFork);

        vm.startPrank(
            OP_ROUTER_ADDRESS
        );
        
        bytes memory encodedHookData = abi.encode(_messageId);

        Client.EVMTokenAmount[] memory empty_tokens;

         Client.Any2EVMMessage memory message = Client.Any2EVMMessage(
            messageId,
            MAINNET_CHAIN_SELECTOR,
            abi.encode(address(ccipHookMainnet)),
            encodedHookData,
            empty_tokens      
        );

        ccipISMOptimism.ccipReceive(message);

        vm.stopPrank();
    }
}
