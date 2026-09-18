// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.20;

import {Test, StdStorage, stdStorage} from "forge-std/Test.sol";

import {ILayerZeroEndpointV2, Origin as LayerZeroOrigin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {SetConfigParam as LayerZeroSetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import {MessageLibManager} from "@layerzerolabs/lz-evm-protocol-v2/contracts/MessageLibManager.sol";
import {GUID} from "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/GUID.sol";
import {IReceiveUlnE2} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/interfaces/IReceiveUlnE2.sol";
import {ReceiveUlnBase} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/ReceiveUlnBase.sol";
import {UlnConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/UlnBase.sol";
import {LayerZeroV2OffchainLookupHookIsm} from "contracts/hooks/layerzero/LayerZeroV2OffchainLookupHookIsm.sol";
import {IPostDispatchHook} from "contracts/interfaces/hooks/IPostDispatchHook.sol";
import {LayerZeroMessage} from "contracts/libs/LayerZeroMessage.sol";
import {Message} from "contracts/libs/Message.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {TestMailbox} from "contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "contracts/test/TestPostDispatchHook.sol";
import {TestRecipient} from "contracts/test/TestRecipient.sol";

contract LayerZeroV2OffchainLookupHookIsmForkTest is Test {
    using Message for bytes;
    using TypeCasts for address;
    using stdStorage for StdStorage;

    uint32 internal constant ETHEREUM_DOMAIN = 1;
    uint32 internal constant ARBITRUM_DOMAIN = 42_161;
    uint32 internal constant ETHEREUM_ENDPOINT_ID = 30_101;
    uint32 internal constant ARBITRUM_ENDPOINT_ID = 30_110;
    uint256 internal constant ETHEREUM_FORK_BLOCK = 25_878_200;

    ILayerZeroEndpointV2 internal constant ENDPOINT =
        ILayerZeroEndpointV2(0x1a44076050125825900e736c501f859c50fE728c);
    address internal constant SEND_ULN_302 =
        0xbB2Ea70C9E858123480642Cf96acbcCE1372dCe1;
    address internal constant RECEIVE_ULN_302 =
        0xc02Ab410f0734EFa3F14628780e6e695156024C2;

    TestMailbox internal mailbox;
    LayerZeroV2OffchainLookupHookIsm internal router;

    function setUp() public {
        vm.createSelectFork("mainnet", ETHEREUM_FORK_BLOCK);

        assertEq(ENDPOINT.eid(), ETHEREUM_ENDPOINT_ID);
        assertEq(ENDPOINT.nativeToken(), address(0));
        assertTrue(ENDPOINT.isRegisteredLibrary(SEND_ULN_302));
        assertTrue(ENDPOINT.isRegisteredLibrary(RECEIVE_ULN_302));

        mailbox = new TestMailbox(ETHEREUM_DOMAIN);
        TestPostDispatchHook noopHook = new TestPostDispatchHook();
        mailbox.setDefaultHook(address(noopHook));
        mailbox.setRequiredHook(address(noopHook));
        string[] memory urls = new string[](1);
        urls[0] = "https://example.com/layerzero";
        router = new LayerZeroV2OffchainLookupHookIsm(
            address(mailbox),
            address(ENDPOINT),
            urls
        );
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        router.enrollLayerZeroRemoteRouter(
            LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig({
                domainId: ARBITRUM_DOMAIN,
                domainIsm: address(0xBEEF).addressToBytes32(),
                endpointId: ARBITRUM_ENDPOINT_ID,
                sendLibrary: SEND_ULN_302,
                receiveLibrary: RECEIVE_ULN_302,
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            })
        );
    }

    function testProductionEndpointReplacementAndQuote() public {
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);

        assertEq(
            ENDPOINT.getSendLibrary(address(router), ARBITRUM_ENDPOINT_ID),
            SEND_ULN_302
        );
        (address receiveLibrary, bool isDefault) = ENDPOINT.getReceiveLibrary(
            address(router),
            ARBITRUM_ENDPOINT_ID
        );
        assertEq(receiveLibrary, RECEIVE_ULN_302);
        assertFalse(isDefault);

        bytes memory executorConfig = ENDPOINT.getConfig(
            address(router),
            SEND_ULN_302,
            ARBITRUM_ENDPOINT_ID,
            1
        );
        (uint32 maxMessageSize, address executor) = abi.decode(
            executorConfig,
            (uint32, address)
        );
        assertGt(maxMessageSize, 1);
        bytes memory updatedExecutorConfig = abi.encode(
            maxMessageSize - 1,
            executor
        );
        LayerZeroSetConfigParam[]
            memory sendConfig = new LayerZeroSetConfigParam[](1);
        sendConfig[0] = LayerZeroSetConfigParam({
            eid: ARBITRUM_ENDPOINT_ID,
            configType: 1,
            config: updatedExecutorConfig
        });

        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig
            memory newRemoteConfig = LayerZeroV2OffchainLookupHookIsm
                .RemoteRouterConfig({
                    domainId: ARBITRUM_DOMAIN,
                    domainIsm: address(0xCAFE).addressToBytes32(),
                    endpointId: ARBITRUM_ENDPOINT_ID,
                    sendLibrary: SEND_ULN_302,
                    receiveLibrary: RECEIVE_ULN_302,
                    sendConfig: sendConfig,
                    receiveConfig: emptyConfig
                });
        router.enrollLayerZeroRemoteRouter(newRemoteConfig);

        assertEq(
            ENDPOINT.getConfig(
                address(router),
                SEND_ULN_302,
                ARBITRUM_ENDPOINT_ID,
                1
            ),
            updatedExecutorConfig
        );
        assertEq(
            router.routers(ARBITRUM_DOMAIN),
            address(0xCAFE).addressToBytes32()
        );
        (address timeoutLibrary, uint256 timeoutExpiry) = ENDPOINT
            .receiveLibraryTimeout(address(router), ARBITRUM_ENDPOINT_ID);
        assertEq(timeoutLibrary, address(0));
        assertEq(timeoutExpiry, 0);

        newRemoteConfig.sendConfig = emptyConfig;
        router.enrollLayerZeroRemoteRouter(newRemoteConfig);
        assertEq(
            ENDPOINT.getConfig(
                address(router),
                SEND_ULN_302,
                ARBITRUM_ENDPOINT_ID,
                1
            ),
            executorConfig
        );
        (timeoutLibrary, timeoutExpiry) = ENDPOINT.receiveLibraryTimeout(
            address(router),
            ARBITRUM_ENDPOINT_ID
        );
        assertEq(timeoutLibrary, address(0));
        assertEq(timeoutExpiry, 0);

        bytes memory message = mailbox.buildOutboundMessage(
            ARBITRUM_DOMAIN,
            address(0x1234).addressToBytes32(),
            bytes("fork quote")
        );
        assertGt(router.quoteDispatch("", message), 0);
    }

    function testProductionEndpointUnenrollmentClearsCustomConfig() public {
        bytes memory defaultExecutorConfig = ENDPOINT.getConfig(
            address(router),
            SEND_ULN_302,
            ARBITRUM_ENDPOINT_ID,
            1
        );
        (uint32 maxMessageSize, address executor) = abi.decode(
            defaultExecutorConfig,
            (uint32, address)
        );
        LayerZeroSetConfigParam[]
            memory sendConfig = new LayerZeroSetConfigParam[](1);
        sendConfig[0] = LayerZeroSetConfigParam({
            eid: ARBITRUM_ENDPOINT_ID,
            configType: 1,
            config: abi.encode(maxMessageSize - 1, executor)
        });
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig
            memory config = LayerZeroV2OffchainLookupHookIsm
                .RemoteRouterConfig({
                    domainId: ARBITRUM_DOMAIN,
                    domainIsm: address(0xBEEF).addressToBytes32(),
                    endpointId: ARBITRUM_ENDPOINT_ID,
                    sendLibrary: SEND_ULN_302,
                    receiveLibrary: RECEIVE_ULN_302,
                    sendConfig: sendConfig,
                    receiveConfig: emptyConfig
                });
        router.unenrollRemoteRouter(ARBITRUM_DOMAIN);
        router.enrollLayerZeroRemoteRouter(config);

        router.unenrollRemoteRouter(ARBITRUM_DOMAIN);
        address blockedLibrary = MessageLibManager(address(ENDPOINT))
            .blockedLibrary();
        assertEq(
            ENDPOINT.getSendLibrary(address(router), ARBITRUM_ENDPOINT_ID),
            blockedLibrary
        );
        (address receiveLibrary, ) = ENDPOINT.getReceiveLibrary(
            address(router),
            ARBITRUM_ENDPOINT_ID
        );
        assertEq(receiveLibrary, blockedLibrary);
        (, uint256 expiry) = ENDPOINT.receiveLibraryTimeout(
            address(router),
            ARBITRUM_ENDPOINT_ID
        );
        assertEq(expiry, 0);
        assertEq(
            ENDPOINT.getConfig(
                address(router),
                SEND_ULN_302,
                ARBITRUM_ENDPOINT_ID,
                1
            ),
            defaultExecutorConfig
        );

        config.sendConfig = emptyConfig;
        router.enrollLayerZeroRemoteRouter(config);
        assertEq(
            ENDPOINT.getConfig(
                address(router),
                SEND_ULN_302,
                ARBITRUM_ENDPOINT_ID,
                1
            ),
            defaultExecutorConfig
        );
    }

    function testProductionEndpointOffchainLookupDispatch() public {
        bytes memory message = mailbox.buildOutboundMessage(
            ARBITRUM_DOMAIN,
            address(0x1234).addressToBytes32(),
            bytes("fork pull quote")
        );
        uint256 fee = router.quoteDispatch("", message);
        assertGt(fee, 0);
        vm.deal(address(this), fee);
        mailbox.dispatch{value: fee}(
            ARBITRUM_DOMAIN,
            address(0x1234).addressToBytes32(),
            bytes("fork pull quote"),
            "",
            IPostDispatchHook(address(router))
        );
        assertTrue(router.publishedAuthorizationPackets(message.id()));
    }

    function testProductionEndpointEnrollmentWithoutDefaultReceiveLibrary()
        public
    {
        assertTrue(
            ENDPOINT.defaultReceiveLibrary(ARBITRUM_ENDPOINT_ID) != address(0)
        );
        stdstore
            .target(address(ENDPOINT))
            .sig("defaultReceiveLibrary(uint32)")
            .with_key(uint256(ARBITRUM_ENDPOINT_ID))
            .checked_write(address(0));

        string[] memory urls = new string[](1);
        urls[0] = "https://example.com/layerzero";
        LayerZeroV2OffchainLookupHookIsm newRouter = new LayerZeroV2OffchainLookupHookIsm(
                address(mailbox),
                address(ENDPOINT),
                urls
            );
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        newRouter.enrollLayerZeroRemoteRouter(
            LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig({
                domainId: ARBITRUM_DOMAIN,
                domainIsm: address(0xBEEF).addressToBytes32(),
                endpointId: ARBITRUM_ENDPOINT_ID,
                sendLibrary: SEND_ULN_302,
                receiveLibrary: RECEIVE_ULN_302,
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            })
        );

        (address receiveLibrary, bool isDefault) = ENDPOINT.getReceiveLibrary(
            address(newRouter),
            ARBITRUM_ENDPOINT_ID
        );
        assertEq(receiveLibrary, RECEIVE_ULN_302);
        assertFalse(isDefault);

        newRouter.unenrollRemoteRouter(ARBITRUM_DOMAIN);
        newRouter.enrollLayerZeroRemoteRouter(
            LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig({
                domainId: ARBITRUM_DOMAIN,
                domainIsm: address(0xBEEF).addressToBytes32(),
                endpointId: ARBITRUM_ENDPOINT_ID,
                sendLibrary: SEND_ULN_302,
                receiveLibrary: RECEIVE_ULN_302,
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            })
        );
        (receiveLibrary, isDefault) = ENDPOINT.getReceiveLibrary(
            address(newRouter),
            ARBITRUM_ENDPOINT_ID
        );
        assertEq(receiveLibrary, RECEIVE_ULN_302);
        assertFalse(isDefault);
    }

    function testProductionReceiveUlnPullVerification() public {
        address[] memory requiredDvns = new address[](1);
        requiredDvns[0] = address(this);
        UlnConfig memory ulnConfig = UlnConfig({
            confirmations: 1,
            requiredDVNCount: 1,
            optionalDVNCount: type(uint8).max,
            optionalDVNThreshold: 0,
            requiredDVNs: requiredDvns,
            optionalDVNs: new address[](0)
        });
        LayerZeroSetConfigParam[]
            memory receiveConfig = new LayerZeroSetConfigParam[](1);
        receiveConfig[0] = LayerZeroSetConfigParam({
            eid: ARBITRUM_ENDPOINT_ID,
            configType: 2,
            config: abi.encode(ulnConfig)
        });
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        router.enrollLayerZeroRemoteRouter(
            LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig({
                domainId: ARBITRUM_DOMAIN,
                domainIsm: address(0xBEEF).addressToBytes32(),
                endpointId: ARBITRUM_ENDPOINT_ID,
                sendLibrary: SEND_ULN_302,
                receiveLibrary: RECEIVE_ULN_302,
                sendConfig: emptyConfig,
                receiveConfig: receiveConfig
            })
        );

        TestRecipient recipient = new TestRecipient();
        recipient.setInterchainSecurityModule(address(router));
        bytes memory hyperlaneMessage = mailbox.buildInboundMessage(
            ARBITRUM_DOMAIN,
            address(recipient).addressToBytes32(),
            address(0xCAFE).addressToBytes32(),
            bytes("fork inbound verification")
        );
        bytes memory payload = LayerZeroMessage.encode(
            ARBITRUM_DOMAIN,
            ETHEREUM_DOMAIN,
            hyperlaneMessage.id()
        );
        bytes32 remoteSender = address(0xBEEF).addressToBytes32();
        bytes32 localReceiver = address(router).addressToBytes32();
        uint64 nonce = 1;
        bytes32 guid = GUID.generate(
            nonce,
            ARBITRUM_ENDPOINT_ID,
            address(0xBEEF),
            ETHEREUM_ENDPOINT_ID,
            localReceiver
        );
        bytes memory header = abi.encodePacked(
            uint8(1),
            nonce,
            ARBITRUM_ENDPOINT_ID,
            remoteSender,
            ETHEREUM_ENDPOINT_ID,
            localReceiver
        );
        bytes memory packet = abi.encodePacked(header, guid, payload);
        bytes32 payloadHash = keccak256(abi.encodePacked(guid, payload));
        bytes memory metadata = abi.encode(RECEIVE_ULN_302, packet);

        vm.expectRevert(ReceiveUlnBase.LZ_ULN_Verifying.selector);
        mailbox.process(metadata, hyperlaneMessage);

        IReceiveUlnE2(RECEIVE_ULN_302).verify(header, payloadHash, 1);
        mailbox.process(metadata, hyperlaneMessage);

        assertTrue(mailbox.delivered(hyperlaneMessage.id()));
        assertEq(
            ENDPOINT.inboundPayloadHash(
                address(router),
                ARBITRUM_ENDPOINT_ID,
                remoteSender,
                nonce
            ),
            bytes32(0)
        );
    }

    function testProductionEndpointSinglePacketClearFitsBudget() public {
        bytes32 remoteSender = address(0xBEEF).addressToBytes32();
        LayerZeroOrigin memory origin = LayerZeroOrigin({
            srcEid: ARBITRUM_ENDPOINT_ID,
            sender: remoteSender,
            nonce: 1
        });
        bytes32 guid = GUID.generate(
            origin.nonce,
            origin.srcEid,
            address(0xBEEF),
            ETHEREUM_ENDPOINT_ID,
            address(router).addressToBytes32()
        );
        bytes memory payload = LayerZeroMessage.encode(
            ARBITRUM_DOMAIN,
            ETHEREUM_DOMAIN,
            bytes32(uint256(1))
        );

        // Isolate the production Endpoint's clear cost from DVN verification.
        vm.prank(RECEIVE_ULN_302);
        ENDPOINT.verify(
            origin,
            address(router),
            keccak256(abi.encodePacked(guid, payload))
        );

        vm.startPrank(address(router));
        uint256 gasBefore = gasleft();
        ENDPOINT.clear(address(router), origin, guid, payload);
        uint256 clearGasUsed = gasBefore - gasleft();
        vm.stopPrank();

        emit log_named_uint("Endpoint.clear single-packet gas", clearGasUsed);
        assertLt(clearGasUsed, 100_000);
        assertEq(
            ENDPOINT.inboundPayloadHash(
                address(router),
                ARBITRUM_ENDPOINT_ID,
                remoteSender,
                origin.nonce
            ),
            bytes32(0)
        );
    }
}
