// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.0;

import {Test, console} from "forge-std/Test.sol";
import {LibBit} from "../../contracts/libs/LibBit.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {IMailbox} from "../../contracts/interfaces/IMailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MessageUtils} from "./IsmTestUtils.sol";
import {ArbitrumOrbitIsm} from "../../contracts/isms/hook/ArbitrumOrbitIsm.sol";
import {ArbitrumOrbitHook} from "../../contracts/hooks/ArbitrumOrbitHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {IInbox} from "@arbitrum/nitro-contracts/src/bridge/Inbox.sol";
import {IArbSys} from "@openzeppelin/contracts/vendor/arbitrum/IArbSys.sol";

interface IArbRetryableTx {
    function redeem(bytes32 ticketId) external returns (bytes32);
}

contract ArbitrumOrbitIsmTest is Test {
    uint256 private mainnetFork;
    uint256 private arbitrumFork;
    uint256 private testMsgValue = 4.2e18;
    bytes private encodedMessage;
    bytes private testMessage = abi.encodePacked("Hello from the other chain!");
    bytes32 private messageId;

    // ========== DEPENDENCIES ==========

    TestRecipient private testRecipient;
    IInbox private baseInbox;
    IMailbox private baseMailbox;
    ArbitrumOrbitIsm private arbISM;
    ArbitrumOrbitHook private arbHook;

    // ========== CONSTANTS ==========

    uint8 private constant ARBITRUM_VERSION = 0;
    uint8 private constant HYPERLANE_VERSION = 1;
    uint256 private constant DEFAULT_GAS_LIMIT = 1_920_000;
    uint32 private constant MAINNET_DOMAIN = 1;
    uint32 private constant ARBITRUM_DOMAIN = 42161;
    address private constant BASE_INBOX =
        0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f;
    // From https://docs.hyperlane.xyz/docs/reference/contract-addresses.
    address private constant MAILBOX =
        0xc005dc82818d67AF737725bD4bf75435d065D239;
    address private constant IGP = 0x9e6B1022bE9BBF5aFd152483DAD9b88911bC8611;

    event InboxMessageDelivered(uint256 indexed messageNum, bytes data);
    event RetryableTicketCreated(uint256 indexed ticketId);
    event ReceivedMessage(bytes32 indexed messageId);

    ///////////////////////////////////////////////////////////////////
    ///                         SET UP                              ///
    ///////////////////////////////////////////////////////////////////

    function deployArbitrumOrbitHook() public {
        vm.selectFork(mainnetFork);
        baseInbox = IInbox(BASE_INBOX);
        baseMailbox = IMailbox(MAILBOX);
        arbHook = new ArbitrumOrbitHook(
            address(baseMailbox),
            ARBITRUM_DOMAIN,
            TypeCasts.addressToBytes32(address(arbISM)),
            BASE_INBOX,
            IGP
        );
    }

    function deployArbitrumOrbitIsm() public {
        vm.selectFork(arbitrumFork);
        arbISM = new ArbitrumOrbitIsm();
    }

    function deployAll() public {
        deployArbitrumOrbitIsm();
        deployArbitrumOrbitHook();
        vm.selectFork(arbitrumFork);
        arbISM.setAuthorizedHook(TypeCasts.addressToBytes32(address(arbHook)));
        vm.selectFork(mainnetFork);
    }

    function _encodeTestMessage() private view returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                HYPERLANE_VERSION,
                uint32(0),
                MAINNET_DOMAIN,
                TypeCasts.addressToBytes32(address(this)),
                ARBITRUM_DOMAIN,
                TypeCasts.addressToBytes32(address(testRecipient)),
                testMessage
            );
    }

    function setUp() public {
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"), 18_879_980);
        arbitrumFork = vm.createFork(vm.rpcUrl("arbitrum"), 164_400_000);
        testRecipient = new TestRecipient();
        encodedMessage = _encodeTestMessage();
        messageId = Message.id(encodedMessage);
        deployAll();

        vm.deal(address(this), 100 ether);
    }

    ///////////////////////////////////////////////////////////////////
    ///                         TESTS                               ///
    ///////////////////////////////////////////////////////////////////

    function _dispatchVerification(bytes memory metadata) private {
        // Assert retryable ticket created.
        vm.expectEmit(false, false, false, false);
        bytes memory data;
        emit InboxMessageDelivered(0, data);
        vm.expectEmit(false, false, false, false);
        emit RetryableTicketCreated(0);

        baseMailbox.dispatch{
            value: arbHook.quoteDispatch(metadata, testMessage)
        }(
            ARBITRUM_DOMAIN,
            TypeCasts.addressToBytes32(address(testRecipient)),
            testMessage,
            metadata,
            arbHook
        );
    }

    function test_DispatchNoMaxFeePerGas() public {
        bytes memory metadata = StandardHookMetadata.formatMetadata(
            testMsgValue,
            10_000_000,
            address(this),
            ""
        );
        _dispatchVerification(metadata);
    }

    function test_DispatchOraclizedGas() public {
        uint256 maxFeePerGas = 0.5e9;
        bytes memory metadata = StandardHookMetadata.formatMetadata(
            testMsgValue,
            10_000_000,
            address(this),
            abi.encodePacked(maxFeePerGas)
        );
        _dispatchVerification(metadata);
    }

    /// Test we can receive the message on the destination chain.
    function test_Verify() public {
        vm.selectFork(arbitrumFork);

        // 1. verify message id

        // Mocking cross chain sender check because unknown error.
        // Seems related, from LibArbitrumL2.sol which the ISM depends on:
        // """WARNING: There is currently a bug in Arbitrum that causes this contract to
        // fail to detect cross-chain calls when deployed behind a proxy. This will be
        // fixed when the network is upgraded to Arbitrum Nitro, currently scheduled for
        // August 31st 2022."""
        address ARBSYS = 0x0000000000000000000000000000000000000064;
        vm.mockCall(
            ARBSYS,
            abi.encodeWithSelector(IArbSys.wasMyCallersAddressAliased.selector),
            abi.encode(true)
        );
        vm.mockCall(
            ARBSYS,
            abi.encodeWithSelector(
                IArbSys.myCallersAddressWithoutAliasing.selector
            ),
            abi.encode(address(arbHook))
        );
        vm.expectEmit(true, false, false, false);
        emit ReceivedMessage(messageId);

        arbISM.verifyMessageId(messageId);

        // 2. relay
        assertTrue(arbISM.verify("", encodedMessage));
    }

    function test_UnauthorizedVerify() public {
        vm.selectFork(arbitrumFork);
        assertFalse(arbISM.verify("", encodedMessage));
    }
}
