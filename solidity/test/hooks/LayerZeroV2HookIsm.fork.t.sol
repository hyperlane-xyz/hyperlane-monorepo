// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.20;

import {Test, Vm, StdStorage, stdStorage} from "forge-std/Test.sol";

import {ILayerZeroEndpointV2, Origin as LayerZeroOrigin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {MessageLibManager} from "@layerzerolabs/lz-evm-protocol-v2/contracts/MessageLibManager.sol";
import {Errors} from "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/Errors.sol";
import {GUID} from "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/GUID.sol";
import {ExecutorConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/SendLibBase.sol";
import {IReceiveUlnE2} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/interfaces/IReceiveUlnE2.sol";
import {ReceiveUlnBase} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/ReceiveUlnBase.sol";
import {UlnConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/UlnBase.sol";
import {LayerZeroV2HookIsm} from "contracts/hooks/layerzero/LayerZeroV2HookIsm.sol";
import {IPostDispatchHook} from "contracts/interfaces/hooks/IPostDispatchHook.sol";
import {StaticAggregationIsmFactory} from "contracts/isms/aggregation/StaticAggregationIsmFactory.sol";
import {LayerZeroMessage} from "contracts/libs/LayerZeroMessage.sol";
import {Message} from "contracts/libs/Message.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {TestMailbox} from "contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "contracts/test/TestPostDispatchHook.sol";
import {TestRecipient} from "contracts/test/TestRecipient.sol";

contract LayerZeroV2HookIsmForkTest is Test {
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
    LayerZeroV2HookIsm internal router;

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
        router = new LayerZeroV2HookIsm(
            address(mailbox),
            address(ENDPOINT),
            urls
        );
        _enrollSingleRoute(
            router,
            LayerZeroV2HookIsm.RemoteRouterConfig({
                domainId: ARBITRUM_DOMAIN,
                domainIsm: address(0xBEEF).addressToBytes32(),
                endpointId: ARBITRUM_ENDPOINT_ID,
                sendLibrary: SEND_ULN_302,
                receiveLibrary: RECEIVE_ULN_302,
                executorConfig: _defaultExecutorConfig(),
                sendUlnConfig: _defaultUlnConfig(),
                receiveUlnConfig: _defaultUlnConfig()
            })
        );
    }

    function _enrollSingleRoute(
        LayerZeroV2HookIsm targetRouter,
        LayerZeroV2HookIsm.RemoteRouterConfig memory config
    ) internal {
        LayerZeroV2HookIsm.RemoteRouterConfig[]
            memory configs = new LayerZeroV2HookIsm.RemoteRouterConfig[](1);
        configs[0] = config;
        targetRouter.enrollRemoteRouters(configs);
    }

    function _defaultExecutorConfig()
        internal
        pure
        returns (ExecutorConfig memory)
    {
        return ExecutorConfig({maxMessageSize: 0, executor: address(0)});
    }

    function _defaultUlnConfig() internal pure returns (UlnConfig memory) {
        return
            UlnConfig({
                confirmations: 0,
                requiredDVNCount: 0,
                optionalDVNCount: 0,
                optionalDVNThreshold: 0,
                requiredDVNs: new address[](0),
                optionalDVNs: new address[](0)
            });
    }

    function testProductionEndpointReplacementAndQuote() public {
        assertEq(
            ENDPOINT.getSendLibrary(address(router), ARBITRUM_ENDPOINT_ID),
            SEND_ULN_302
        );
        // SEND_ULN_302 is also the Endpoint default here; the path must still
        // be pinned explicitly rather than inherit the mutable default.
        assertEq(
            ENDPOINT.defaultSendLibrary(ARBITRUM_ENDPOINT_ID),
            SEND_ULN_302
        );
        assertFalse(
            ENDPOINT.isDefaultSendLibrary(address(router), ARBITRUM_ENDPOINT_ID)
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
        ExecutorConfig memory updatedExecutorConfig = ExecutorConfig({
            maxMessageSize: maxMessageSize - 1,
            executor: executor
        });

        LayerZeroV2HookIsm.RemoteRouterConfig
            memory newRemoteConfig = LayerZeroV2HookIsm.RemoteRouterConfig({
                domainId: ARBITRUM_DOMAIN,
                domainIsm: address(0xCAFE).addressToBytes32(),
                endpointId: ARBITRUM_ENDPOINT_ID,
                sendLibrary: SEND_ULN_302,
                receiveLibrary: RECEIVE_ULN_302,
                executorConfig: updatedExecutorConfig,
                sendUlnConfig: _defaultUlnConfig(),
                receiveUlnConfig: _defaultUlnConfig()
            });
        _enrollSingleRoute(router, newRemoteConfig);

        assertEq(
            ENDPOINT.getConfig(
                address(router),
                SEND_ULN_302,
                ARBITRUM_ENDPOINT_ID,
                1
            ),
            abi.encode(updatedExecutorConfig)
        );
        assertEq(
            router.routers(ARBITRUM_DOMAIN),
            address(0xCAFE).addressToBytes32()
        );
        (address timeoutLibrary, uint256 timeoutExpiry) = ENDPOINT
            .receiveLibraryTimeout(address(router), ARBITRUM_ENDPOINT_ID);
        assertEq(timeoutLibrary, address(0));
        assertEq(timeoutExpiry, 0);

        newRemoteConfig.executorConfig = _defaultExecutorConfig();
        _enrollSingleRoute(router, newRemoteConfig);
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

    function testProductionEndpointUnenrollmentRetainsInactiveConfig() public {
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
        ExecutorConfig memory customExecutorConfig = ExecutorConfig({
            maxMessageSize: maxMessageSize - 1,
            executor: executor
        });
        LayerZeroV2HookIsm.RemoteRouterConfig memory config = LayerZeroV2HookIsm
            .RemoteRouterConfig({
                domainId: ARBITRUM_DOMAIN,
                domainIsm: address(0xBEEF).addressToBytes32(),
                endpointId: ARBITRUM_ENDPOINT_ID,
                sendLibrary: SEND_ULN_302,
                receiveLibrary: RECEIVE_ULN_302,
                executorConfig: customExecutorConfig,
                sendUlnConfig: _defaultUlnConfig(),
                receiveUlnConfig: _defaultUlnConfig()
            });
        router.unenrollRemoteRouter(ARBITRUM_DOMAIN);
        _enrollSingleRoute(router, config);

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
            abi.encode(customExecutorConfig)
        );

        config.executorConfig = _defaultExecutorConfig();
        _enrollSingleRoute(router, config);
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

        vm.recordLogs();
        mailbox.dispatch{value: fee}(
            ARBITRUM_DOMAIN,
            address(0x1234).addressToBytes32(),
            bytes("fork pull quote"),
            "",
            IPostDispatchHook(address(router))
        );

        assertEq(router.latestPublishedAuthorizationMessageId(), message.id());

        // The packet the real Endpoint emits must be exactly the layout the
        // destination side validates and the inbound tests below construct.
        (bytes memory sentPacket, bytes memory sentOptions) = _packetSent();
        (, , bytes memory expectedPacket) = _encodePacket(
            1,
            ETHEREUM_ENDPOINT_ID,
            address(router),
            ARBITRUM_ENDPOINT_ID,
            address(0xBEEF),
            LayerZeroMessage.encode(
                ETHEREUM_DOMAIN,
                ARBITRUM_DOMAIN,
                message.id()
            )
        );
        assertEq(sentPacket, expectedPacket);
        assertEq(
            sentOptions,
            abi.encodePacked(
                uint16(3),
                uint8(1),
                uint16(17),
                uint8(1),
                uint128(1)
            )
        );
    }

    function _packetSent()
        internal
        returns (bytes memory packet, bytes memory options)
    {
        bytes32 topic = keccak256("PacketSent(bytes,bytes,address)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(ENDPOINT) &&
                logs[i].topics[0] == topic
            ) {
                (packet, options, ) = abi.decode(
                    logs[i].data,
                    (bytes, bytes, address)
                );
                return (packet, options);
            }
        }
        revert("no PacketSent event");
    }

    // PacketV1 layout: header (version, nonce, srcEid, sender, dstEid,
    // receiver), then GUID, then payload.
    function _encodePacket(
        uint64 nonce,
        uint32 srcEid,
        address sender,
        uint32 dstEid,
        address receiver,
        bytes memory payload
    )
        internal
        pure
        returns (bytes memory header, bytes32 guid, bytes memory packet)
    {
        guid = GUID.generate(
            nonce,
            srcEid,
            sender,
            dstEid,
            receiver.addressToBytes32()
        );
        header = abi.encodePacked(
            uint8(1),
            nonce,
            srcEid,
            sender.addressToBytes32(),
            dstEid,
            receiver.addressToBytes32()
        );
        packet = abi.encodePacked(header, guid, payload);
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
        LayerZeroV2HookIsm newRouter = new LayerZeroV2HookIsm(
            address(mailbox),
            address(ENDPOINT),
            urls
        );
        _enrollSingleRoute(
            newRouter,
            LayerZeroV2HookIsm.RemoteRouterConfig({
                domainId: ARBITRUM_DOMAIN,
                domainIsm: address(0xBEEF).addressToBytes32(),
                endpointId: ARBITRUM_ENDPOINT_ID,
                sendLibrary: SEND_ULN_302,
                receiveLibrary: RECEIVE_ULN_302,
                executorConfig: _defaultExecutorConfig(),
                sendUlnConfig: _defaultUlnConfig(),
                receiveUlnConfig: _defaultUlnConfig()
            })
        );

        (address receiveLibrary, bool isDefault) = ENDPOINT.getReceiveLibrary(
            address(newRouter),
            ARBITRUM_ENDPOINT_ID
        );
        assertEq(receiveLibrary, RECEIVE_ULN_302);
        assertFalse(isDefault);

        newRouter.unenrollRemoteRouter(ARBITRUM_DOMAIN);
        _enrollSingleRoute(
            newRouter,
            LayerZeroV2HookIsm.RemoteRouterConfig({
                domainId: ARBITRUM_DOMAIN,
                domainIsm: address(0xBEEF).addressToBytes32(),
                endpointId: ARBITRUM_ENDPOINT_ID,
                sendLibrary: SEND_ULN_302,
                receiveLibrary: RECEIVE_ULN_302,
                executorConfig: _defaultExecutorConfig(),
                sendUlnConfig: _defaultUlnConfig(),
                receiveUlnConfig: _defaultUlnConfig()
            })
        );
        (receiveLibrary, isDefault) = ENDPOINT.getReceiveLibrary(
            address(newRouter),
            ARBITRUM_ENDPOINT_ID
        );
        assertEq(receiveLibrary, RECEIVE_ULN_302);
        assertFalse(isDefault);
    }

    function testProductionEnrollmentAppliesIndependentUlnPolicies() public {
        address[] memory sendDvns = new address[](1);
        sendDvns[0] = address(0xA11CE);
        address[] memory receiveDvns = new address[](1);
        receiveDvns[0] = address(0xB0B);
        _enrollSingleRoute(
            router,
            LayerZeroV2HookIsm.RemoteRouterConfig({
                domainId: ARBITRUM_DOMAIN,
                domainIsm: address(0xBEEF).addressToBytes32(),
                endpointId: ARBITRUM_ENDPOINT_ID,
                sendLibrary: SEND_ULN_302,
                receiveLibrary: RECEIVE_ULN_302,
                executorConfig: _defaultExecutorConfig(),
                sendUlnConfig: _explicitUlnConfig(3, sendDvns),
                receiveUlnConfig: _explicitUlnConfig(7, receiveDvns)
            })
        );

        UlnConfig memory sendUln = abi.decode(
            ENDPOINT.getConfig(
                address(router),
                SEND_ULN_302,
                ARBITRUM_ENDPOINT_ID,
                2
            ),
            (UlnConfig)
        );
        UlnConfig memory receiveUln = abi.decode(
            ENDPOINT.getConfig(
                address(router),
                RECEIVE_ULN_302,
                ARBITRUM_ENDPOINT_ID,
                2
            ),
            (UlnConfig)
        );

        assertEq(sendUln.confirmations, 3);
        assertEq(sendUln.requiredDVNs[0], address(0xA11CE));
        assertEq(receiveUln.confirmations, 7);
        assertEq(receiveUln.requiredDVNs[0], address(0xB0B));
    }

    function _explicitUlnConfig(
        uint64 confirmations,
        address[] memory requiredDvns
    ) internal pure returns (UlnConfig memory) {
        return
            UlnConfig({
                confirmations: confirmations,
                requiredDVNCount: uint8(requiredDvns.length),
                optionalDVNCount: type(uint8).max,
                optionalDVNThreshold: 0,
                requiredDVNs: requiredDvns,
                optionalDVNs: new address[](0)
            });
    }

    struct InboundPacket {
        bytes hyperlaneMessage;
        bytes header;
        bytes payload;
        bytes32 guid;
        bytes32 payloadHash;
        bytes metadata;
    }

    function _enrollInboundRoute() internal {
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
        _enrollSingleRoute(
            router,
            LayerZeroV2HookIsm.RemoteRouterConfig({
                domainId: ARBITRUM_DOMAIN,
                domainIsm: address(0xBEEF).addressToBytes32(),
                endpointId: ARBITRUM_ENDPOINT_ID,
                sendLibrary: SEND_ULN_302,
                receiveLibrary: RECEIVE_ULN_302,
                executorConfig: _defaultExecutorConfig(),
                sendUlnConfig: _defaultUlnConfig(),
                receiveUlnConfig: ulnConfig
            })
        );
    }

    function _inboundPacket(
        address recipient,
        uint64 nonce
    ) internal view returns (InboundPacket memory inbound) {
        inbound.hyperlaneMessage = mailbox.buildInboundMessage(
            ARBITRUM_DOMAIN,
            recipient.addressToBytes32(),
            address(0xCAFE).addressToBytes32(),
            abi.encodePacked("fork inbound verification ", nonce)
        );
        inbound.payload = LayerZeroMessage.encode(
            ARBITRUM_DOMAIN,
            ETHEREUM_DOMAIN,
            inbound.hyperlaneMessage.id()
        );
        bytes memory packet;
        (inbound.header, inbound.guid, packet) = _encodePacket(
            nonce,
            ARBITRUM_ENDPOINT_ID,
            address(0xBEEF),
            ETHEREUM_ENDPOINT_ID,
            address(router),
            inbound.payload
        );
        inbound.payloadHash = keccak256(
            abi.encodePacked(inbound.guid, inbound.payload)
        );
        inbound.metadata = abi.encode(RECEIVE_ULN_302, packet);
    }

    function testProductionReceiveUlnVerificationAndPostDeliveryCleanup()
        public
    {
        _enrollInboundRoute();
        TestRecipient recipient = new TestRecipient();
        recipient.setInterchainSecurityModule(address(router));
        InboundPacket memory inbound = _inboundPacket(address(recipient), 1);
        bytes32 remoteSender = address(0xBEEF).addressToBytes32();
        uint64 nonce = 1;

        vm.expectRevert(ReceiveUlnBase.LZ_ULN_Verifying.selector);
        mailbox.process(inbound.metadata, inbound.hyperlaneMessage);

        IReceiveUlnE2(RECEIVE_ULN_302).verify(
            inbound.header,
            inbound.payloadHash,
            1
        );

        // Direct verification may commit the packet repeatedly but never
        // consumes it.
        assertTrue(router.verify(inbound.metadata, inbound.hyperlaneMessage));
        assertTrue(router.verify(inbound.metadata, inbound.hyperlaneMessage));
        assertFalse(mailbox.delivered(inbound.hyperlaneMessage.id()));
        assertEq(
            ENDPOINT.inboundPayloadHash(
                address(router),
                ARBITRUM_ENDPOINT_ID,
                remoteSender,
                nonce
            ),
            inbound.payloadHash
        );

        LayerZeroOrigin memory origin = LayerZeroOrigin({
            srcEid: ARBITRUM_ENDPOINT_ID,
            sender: remoteSender,
            nonce: nonce
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2HookIsm.MessageNotDelivered.selector,
                inbound.hyperlaneMessage.id()
            )
        );
        ENDPOINT.lzReceive(
            origin,
            address(router),
            inbound.guid,
            inbound.payload,
            ""
        );
        assertEq(
            ENDPOINT.inboundPayloadHash(
                address(router),
                ARBITRUM_ENDPOINT_ID,
                remoteSender,
                nonce
            ),
            inbound.payloadHash
        );

        mailbox.process(inbound.metadata, inbound.hyperlaneMessage);

        assertTrue(mailbox.delivered(inbound.hyperlaneMessage.id()));
        assertEq(
            ENDPOINT.inboundPayloadHash(
                address(router),
                ARBITRUM_ENDPOINT_ID,
                remoteSender,
                nonce
            ),
            inbound.payloadHash
        );

        ENDPOINT.lzReceive(
            origin,
            address(router),
            inbound.guid,
            inbound.payload,
            ""
        );
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

    function testProductionReceiveUlnSameIsmRepeatedInAggregationDelivers()
        public
    {
        _enrollInboundRoute();
        TestRecipient recipient = new TestRecipient();
        address[] memory modules = new address[](2);
        modules[0] = address(router);
        modules[1] = address(router);
        recipient.setInterchainSecurityModule(
            new StaticAggregationIsmFactory().deploy(modules, 2)
        );
        InboundPacket memory inbound = _inboundPacket(address(recipient), 1);
        IReceiveUlnE2(RECEIVE_ULN_302).verify(
            inbound.header,
            inbound.payloadHash,
            1
        );
        bytes memory metadata = abi.encodePacked(
            uint32(16),
            uint32(16 + inbound.metadata.length),
            uint32(16),
            uint32(16 + inbound.metadata.length),
            inbound.metadata
        );

        mailbox.process(metadata, inbound.hyperlaneMessage);

        assertTrue(mailbox.delivered(inbound.hyperlaneMessage.id()));
    }

    // Verification never depends on nonce order; only optional cleanup does.
    function testProductionOutOfOrderDeliveryAndPostDeliveryCleanup() public {
        _enrollInboundRoute();
        TestRecipient recipient = new TestRecipient();
        recipient.setInterchainSecurityModule(address(router));
        InboundPacket memory first = _inboundPacket(address(recipient), 1);
        InboundPacket memory second = _inboundPacket(address(recipient), 2);
        bytes32 remoteSender = address(0xBEEF).addressToBytes32();
        IReceiveUlnE2(RECEIVE_ULN_302).verify(
            first.header,
            first.payloadHash,
            1
        );
        IReceiveUlnE2(RECEIVE_ULN_302).verify(
            second.header,
            second.payloadHash,
            1
        );

        // Deliver nonce 2 while nonce 1 is still uncommitted.
        mailbox.process(second.metadata, second.hyperlaneMessage);

        assertTrue(mailbox.delivered(second.hyperlaneMessage.id()));
        assertEq(
            ENDPOINT.inboundPayloadHash(
                address(router),
                ARBITRUM_ENDPOINT_ID,
                remoteSender,
                2
            ),
            second.payloadHash
        );

        // Endpoint cleanup walks every earlier nonce, so it waits for nonce 1.
        LayerZeroOrigin memory secondOrigin = LayerZeroOrigin({
            srcEid: ARBITRUM_ENDPOINT_ID,
            sender: remoteSender,
            nonce: 2
        });
        vm.expectRevert(
            abi.encodeWithSelector(Errors.LZ_InvalidNonce.selector, uint64(1))
        );
        ENDPOINT.lzReceive(
            secondOrigin,
            address(router),
            second.guid,
            second.payload,
            ""
        );

        mailbox.process(first.metadata, first.hyperlaneMessage);
        ENDPOINT.lzReceive(
            secondOrigin,
            address(router),
            second.guid,
            second.payload,
            ""
        );
        ENDPOINT.lzReceive(
            LayerZeroOrigin({
                srcEid: ARBITRUM_ENDPOINT_ID,
                sender: remoteSender,
                nonce: 1
            }),
            address(router),
            first.guid,
            first.payload,
            ""
        );

        assertEq(
            ENDPOINT.inboundPayloadHash(
                address(router),
                ARBITRUM_ENDPOINT_ID,
                remoteSender,
                1
            ),
            bytes32(0)
        );
        assertEq(
            ENDPOINT.inboundPayloadHash(
                address(router),
                ARBITRUM_ENDPOINT_ID,
                remoteSender,
                2
            ),
            bytes32(0)
        );
    }
}
