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
import {IEVM2AnyOnRamp} from "@chainlink/contracts-ccip/src/v0.8/ccip/interfaces/IEVM2AnyOnRamp.sol";

contract CCIPIsmTest is Test {
    using LibBit for uint256;
    using TypeCasts for address;
    using MessageUtils for bytes;

    uint256 internal mainnetFork;
    uint256 internal optimismFork;

    address internal constant MAINNET_ROUTER_ADDRESS =
        0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D; // Ethereum CCIP Router
    address internal constant OP_ROUTER_ADDRESS =
        0x3206695CaE29952f4b0c22a169725a865bc8Ce0f; // Optimism CCIP Router

    uint8 internal constant CHAINLINK_VERSION = 0;
    uint8 internal constant HYPERLANE_VERSION = 1;

    address internal alice = address(0x1);

    TestMailbox internal l1Mailbox;
    TestMailbox internal l2Mailbox;
    CCIPIsm internal ccipISMOptimism;
    CCIPHook internal ccipHookMainnet;

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

    event ReceivedMessage(bytes32 indexed messageId);

    function setUp() public {
        // block numbers to fork from, chain data is cached to ../../forge-cache/
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"), 21_818_432);
        optimismFork = vm.createFork(vm.rpcUrl("optimism"), 126_162_148);

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

        IRouterClient(MAINNET_ROUTER_ADDRESS).isChainSupported(
            OPTIMISM_CHAIN_SELECTOR
        );

        ccipHookMainnet = new CCIPHook(
            MAINNET_ROUTER_ADDRESS,
            OPTIMISM_CHAIN_SELECTOR,
            address(l1Mailbox),
            OPTIMISM_DOMAIN,
            TypeCasts.addressToBytes32(address(ccipISMOptimism))
        );

        vm.makePersistent(address(ccipHookMainnet), MAINNET_ROUTER_ADDRESS);
    }

    function deployCCIPHookAndISMOptimism() public {
        vm.selectFork(optimismFork);

        l2Mailbox = new TestMailbox(OPTIMISM_DOMAIN);

        ccipISMOptimism = new CCIPIsm(
            OP_ROUTER_ADDRESS,
            MAINNET_CHAIN_SELECTOR
        );

        vm.makePersistent(address(ccipISMOptimism), OP_ROUTER_ADDRESS);
    }

    function deployAll() public {
        deployCCIPHookAndISMOptimism();
        deployCCIPHookAndISMMainnet();

        vm.selectFork(optimismFork);
        ccipISMOptimism.setAuthorizedHook(
            TypeCasts.addressToBytes32(address(ccipHookMainnet))
        );

        // for sending value
        vm.deal(OP_ROUTER_ADDRESS, 2 ** 255);
    }

    ///////////////////////////////////////////////////////////////////
    ///                         FORK TESTS                          ///
    ///////////////////////////////////////////////////////////////////

    /* ============ hook.quoteDispatch ============ */

    function testFork_quoteDispatch() public {
        deployAll();

        vm.selectFork(mainnetFork);

        testMetadata = _buildMetadata(
            OPTIMISM_CHAIN_SELECTOR,
            address(ccipISMOptimism)
        );

        assert(ccipHookMainnet.quoteDispatch(testMetadata, encodedMessage) > 0);
    }

    /* ============ hook.postDispatch ============ */
    event Refund(uint256 amount);

    receive() external payable {
        emit Refund(msg.value);
    }

    function testFork_postDispatch() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes memory encodedHookData = abi.encode(messageId);

        l1Mailbox.updateLatestDispatchedId(messageId);

        uint256 quotedFee = ccipHookMainnet.quoteDispatch(
            testMetadata,
            encodedMessage
        );

        ccipHookMainnet.postDispatch{value: (quotedFee * 11) / 10}(
            testMetadata,
            encodedMessage
        );
    }

    function testFork_postDispatch_RevertWhen_NotEnoughValueSent() public {
        deployAll();

        vm.selectFork(mainnetFork);

        l1Mailbox.updateLatestDispatchedId(messageId);

        vm.expectRevert();

        ccipHookMainnet.postDispatch(testMetadata, encodedMessage);
    }

    function testFork_postDispatch_RevertWhen_NotLastDispatchedMessage()
        public
    {
        deployAll();

        vm.selectFork(mainnetFork);

        vm.expectRevert(
            "AbstractMessageIdAuthHook: message not latest dispatched"
        );

        ccipHookMainnet.postDispatch(testMetadata, encodedMessage);
    }

    // /* ============ ISM.verifyMessageId ============ */

    function testFork_verifyMessageId() public {
        deployAll();

        vm.selectFork(optimismFork);

        Client.Any2EVMMessage memory message = _encodeCCIPReceiveMessage();

        vm.prank(OP_ROUTER_ADDRESS);
        uint256 beforeCall = gasleft();
        ccipISMOptimism.ccipReceive(message);
        uint256 afterCall = gasleft();
        console.log("Gas used: ", beforeCall - afterCall);

        assertTrue(ccipISMOptimism.verifiedMessages(messageId).isBitSet(255));
    }

    function testFork_verifyMessageId_RevertWhen_SenderNotAllowed(
        address unauthorized
    ) public {
        Client.Any2EVMMessage memory message = _encodeCCIPReceiveMessage();
        vm.assume(unauthorized != abi.decode(message.sender, (address)));
        message.sender = abi.encode(unauthorized);

        deployAll();

        vm.selectFork(optimismFork);

        vm.prank(OP_ROUTER_ADDRESS);
        vm.expectRevert("Unauthorized hook");
        ccipISMOptimism.ccipReceive(message);
    }

    function testFork_verifyMessageId_RevertWhen_SourceChainNotAllowed(
        uint64 unallowed
    ) public {
        Client.Any2EVMMessage memory message = _encodeCCIPReceiveMessage();
        vm.assume(unallowed != message.sourceChainSelector);
        message.sourceChainSelector = unallowed;

        deployAll();

        vm.selectFork(optimismFork);
        vm.prank(OP_ROUTER_ADDRESS);
        vm.expectRevert("Unauthorized origin");
        ccipISMOptimism.ccipReceive(message);
    }

    function testFork_verifyMessageId_RevertWhen_InvalidRouter(
        address unauthorized
    ) public {
        Client.Any2EVMMessage memory message = _encodeCCIPReceiveMessage();
        vm.assume(unauthorized != OP_ROUTER_ADDRESS);

        deployAll();

        vm.selectFork(optimismFork);
        vm.startPrank(unauthorized);

        bytes4 selector = bytes4(keccak256("InvalidRouter(address)"));
        vm.expectRevert(abi.encodeWithSelector(selector, unauthorized));

        ccipISMOptimism.ccipReceive(message);
        vm.stopPrank();
    }

    function testFork_preVerifyMessageId_RevertWhen_UnauthorizedRouter(
        address unauthorized
    ) public {
        vm.assume(unauthorized != OP_ROUTER_ADDRESS);
        deployAll();

        vm.selectFork(optimismFork);

        vm.startPrank(unauthorized);

        vm.expectRevert(
            "AbstractMessageIdAuthorizedIsm: sender is not the hook"
        );
        ccipISMOptimism.preVerifyMessage(messageId, 0);

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

    /* ============ helper functions ============ */

    function _buildMetadata(
        uint64 _destinationChainSelector,
        address _receiver
    ) internal view returns (bytes memory) {
        bytes memory customMetadata = abi.encode(
            _destinationChainSelector,
            _receiver
        );
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

    function _encodeCCIPReceiveMessage()
        internal
        view
        returns (Client.Any2EVMMessage memory)
    {
        bytes memory encodedHookData = abi.encode(messageId);

        Client.EVMTokenAmount[] memory empty_tokens;

        return
            Client.Any2EVMMessage(
                messageId,
                MAINNET_CHAIN_SELECTOR,
                abi.encode(address(ccipHookMainnet)),
                encodedHookData,
                empty_tokens
            );
    }

    function orchestrateRelayMessage(bytes32 _messageId) internal {
        vm.selectFork(optimismFork);

        Client.Any2EVMMessage memory message = _encodeCCIPReceiveMessage();

        vm.prank(OP_ROUTER_ADDRESS);
        ccipISMOptimism.ccipReceive(message);
    }
}
