// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

import {IReceiveUlnE2} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/interfaces/IReceiveUlnE2.sol";
import {Origin as LayerZeroOrigin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {AddressCast} from "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/AddressCast.sol";
import {GUID} from "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/GUID.sol";
import {PacketV1Codec} from "@layerzerolabs/lz-evm-protocol-v2/contracts/messagelib/libs/PacketV1Codec.sol";
import {AbstractCcipReadIsm} from "../../isms/ccip-read/AbstractCcipReadIsm.sol";
import {ILayerZeroPacketService} from "../../interfaces/layerzero/ILayerZeroPacketService.sol";
import {LayerZeroMessage} from "../../libs/LayerZeroMessage.sol";
import {LayerZeroMetadata} from "../../libs/LayerZeroMetadata.sol";
import {Message} from "../../libs/Message.sol";
import {AbstractLayerZeroV2HookIsm} from "./AbstractLayerZeroV2HookIsm.sol";

contract LayerZeroV2CcipReadHookIsm is
    AbstractCcipReadIsm,
    AbstractLayerZeroV2HookIsm
{
    using AddressCast for bytes32;
    using LayerZeroMetadata for bytes;
    using PacketV1Codec for bytes;

    // ============ Constants ============

    // Standard Executors reject missing or zero-gas lzReceive options. One gas
    // keeps the pathway quotable while making callback execution impossible;
    // this variant consumes the verified packet only through Endpoint.clear.
    bytes22 internal constant PULL_EXECUTOR_OPTIONS =
        hex"00030100110100000000000000000000000000000001";
    uint256 internal constant PACKET_MESSAGE_OFFSET = 113;
    uint8 internal constant PACKET_VERSION = 1;

    // ============ Types ============

    struct PacketContext {
        address receiveLibrary;
        uint32 originDomain;
        uint32 sourceEid;
        bytes32 sender;
        uint64 nonce;
        bytes32 guid;
        bytes32 payloadHash;
        bytes message;
        bytes header;
    }

    // ============ Events ============

    event LayerZeroPayloadConsumed(
        bytes32 indexed messageId,
        uint32 indexed originDomain,
        uint32 indexed srcEid,
        bytes32 guid,
        uint64 nonce,
        address receiveLibrary
    );

    // ============ Errors ============

    error PullLayerZeroCallbackUnsupported();
    error UnauthorizedMailboxCaller(address caller);
    error MessageNotBeingProcessed(bytes32 messageId);
    error WrongHyperlaneDestination(uint32 destination);
    error WrongPacketSourceEid(uint32 actual, uint32 expected);
    error WrongPacketSender(bytes32 actual, bytes32 expected);
    error WrongPacketDestinationEid(uint32 actual, uint32 expected);
    error WrongPacketReceiver(bytes32 actual, bytes32 expected);
    error WrongPacketMessage();
    error WrongPacketGuid(bytes32 actual, bytes32 expected);
    error InvalidReceiveLibrary(address libraryAddress);
    error ConflictingPayloadHash(bytes32 current, bytes32 expected);
    error InvalidLayerZeroPacketLength(uint256 length);
    error InvalidLayerZeroPacketVersion(uint8 version);

    // ============ Constructor ============

    constructor(
        address mailbox_,
        address endpoint_,
        string[] memory urls_
    ) AbstractLayerZeroV2HookIsm(mailbox_, endpoint_) {
        setUrls(urls_);
    }

    // ============ Route Configuration ============

    function enrollLayerZeroRemoteRouter(
        RemoteRouterEnrollment calldata enrollment
    ) external onlyOwner {
        _enrollAndValidateLayerZeroRemoteRouter(enrollment);
    }

    function enrollLayerZeroRemoteRouters(
        RemoteRouterEnrollment[] calldata enrollments
    ) external onlyOwner {
        for (uint256 i = 0; i < enrollments.length; ++i) {
            _enrollAndValidateLayerZeroRemoteRouter(enrollments[i]);
        }
    }

    function updateLayerZeroRemoteRouterConfig(
        RemoteRouterConfigUpdate calldata update_
    ) external onlyOwner {
        _updateAndValidateLayerZeroRemoteRouterConfig(update_);
    }

    /// @notice Atomically updates multiple routes whose selected libraries are
    /// unchanged.
    /// @dev Any failed update or validation reverts the entire batch.
    function updateLayerZeroRemoteRouterConfigs(
        RemoteRouterConfigUpdate[] calldata updates
    ) external onlyOwner {
        for (uint256 i = 0; i < updates.length; ++i) {
            _updateAndValidateLayerZeroRemoteRouterConfig(updates[i]);
        }
    }

    function _enrollAndValidateLayerZeroRemoteRouter(
        RemoteRouterEnrollment calldata enrollment
    ) internal {
        _enrollLayerZeroRemoteRouter(enrollment);
        _validateLayerZeroRemoteRouter(enrollment.domain);
    }

    function _updateAndValidateLayerZeroRemoteRouterConfig(
        RemoteRouterConfigUpdate calldata update_
    ) internal {
        _updateLayerZeroRemoteRouterConfig(update_);
        _validateLayerZeroRemoteRouter(update_.domain);
    }

    // ============ LayerZero Receiver Interface ============

    /// @notice Rejects push delivery for the pull variant.
    /// @dev The shared base implements ILayerZeroReceiver because Endpoint V2
    /// needs allowInitializePath for first-packet verification. This variant
    /// deliberately consumes authenticated packets only through
    /// Mailbox.process -> verify -> Endpoint.clear, so callback delivery must
    /// remain disabled.
    function lzReceive(
        LayerZeroOrigin calldata,
        bytes32,
        bytes calldata,
        address,
        bytes calldata
    ) external payable override {
        revert PullLayerZeroCallbackUnsupported();
    }

    // ============ Hyperlane ISM Interface ============

    function verify(
        bytes calldata metadata,
        bytes calldata message
    ) external override returns (bool) {
        bytes32 messageId = Message.id(message);
        if (msg.sender != address(mailbox)) {
            revert UnauthorizedMailboxCaller(msg.sender);
        }

        if (!_isProcessing(messageId)) {
            revert MessageNotBeingProcessed(messageId);
        }

        if (Message.destination(message) != localDomain) {
            revert WrongHyperlaneDestination(Message.destination(message));
        }

        PacketContext memory context = _validatePacket(
            metadata,
            message,
            messageId
        );

        _consumePacket(context);
        emit LayerZeroPayloadConsumed(
            messageId,
            context.originDomain,
            context.sourceEid,
            context.guid,
            context.nonce,
            context.receiveLibrary
        );

        return true;
    }

    // ============ Packet Validation and Consumption ============

    function _validatePacket(
        bytes calldata metadata,
        bytes calldata hyperlaneMessage,
        bytes32 messageId
    ) internal view returns (PacketContext memory context) {
        bytes calldata packet;
        (context.receiveLibrary, packet) = metadata.decode();
        _validatePacketEncoding(packet);
        context.originDomain = Message.origin(hyperlaneMessage);
        RemoteLayerZeroConfig memory remote = _mustHaveRemoteConfig(
            context.originDomain
        );
        context.sourceEid = packet.srcEid();
        if (context.sourceEid != remote.eid) {
            revert WrongPacketSourceEid(context.sourceEid, remote.eid);
        }
        bytes32 expectedSender = _mustHaveRemoteRouter(context.originDomain);
        context.sender = packet.sender();
        if (context.sender != expectedSender) {
            revert WrongPacketSender(context.sender, expectedSender);
        }
        uint32 destinationEid = packet.dstEid();
        if (destinationEid != localEid) {
            revert WrongPacketDestinationEid(destinationEid, localEid);
        }
        bytes32 expectedReceiver = bytes32(uint256(uint160(address(this))));
        bytes32 packetReceiver = packet.receiver();
        if (packetReceiver != expectedReceiver) {
            revert WrongPacketReceiver(packetReceiver, expectedReceiver);
        }

        context.message = LayerZeroMessage.encode(
            context.originDomain,
            localDomain,
            messageId
        );
        if (keccak256(packet.message()) != keccak256(context.message)) {
            revert WrongPacketMessage();
        }
        context.nonce = packet.nonce();
        context.guid = packet.guid();
        bytes32 expectedGuid = GUID.generate(
            context.nonce,
            context.sourceEid,
            context.sender.toAddress(),
            destinationEid,
            packetReceiver
        );
        if (context.guid != expectedGuid) {
            revert WrongPacketGuid(context.guid, expectedGuid);
        }
        if (
            !endpoint.isValidReceiveLibrary(
                address(this),
                context.sourceEid,
                context.receiveLibrary
            )
        ) {
            revert InvalidReceiveLibrary(context.receiveLibrary);
        }

        context.payloadHash = packet.payloadHash();
        context.header = packet.header();
    }

    function _validatePacketEncoding(bytes calldata packet) internal pure {
        if (packet.length != PACKET_MESSAGE_OFFSET + LayerZeroMessage.LENGTH) {
            revert InvalidLayerZeroPacketLength(packet.length);
        }
        uint8 version = packet.version();
        if (version != PACKET_VERSION) {
            revert InvalidLayerZeroPacketVersion(version);
        }
    }

    function _consumePacket(PacketContext memory context) internal {
        bytes32 currentPayloadHash = endpoint.inboundPayloadHash(
            address(this),
            context.sourceEid,
            context.sender,
            context.nonce
        );
        if (currentPayloadHash == bytes32(0)) {
            IReceiveUlnE2(context.receiveLibrary).commitVerification(
                context.header,
                context.payloadHash
            );
            currentPayloadHash = endpoint.inboundPayloadHash(
                address(this),
                context.sourceEid,
                context.sender,
                context.nonce
            );
        }
        if (currentPayloadHash != context.payloadHash) {
            revert ConflictingPayloadHash(
                currentPayloadHash,
                context.payloadHash
            );
        }

        LayerZeroOrigin memory origin = LayerZeroOrigin({
            srcEid: context.sourceEid,
            sender: context.sender,
            nonce: context.nonce
        });
        endpoint.clear(address(this), origin, context.guid, context.message);
    }

    // ============ Hyperlane CCIP-Read Interface ============

    function _offchainLookupCalldata(
        bytes calldata message
    ) internal pure override returns (bytes memory) {
        return
            abi.encodeCall(
                ILayerZeroPacketService.getLayerZeroPacket,
                (message)
            );
    }

    // ============ Variant Overrides ============

    function _AbstractLayerZeroV2HookIsm_options(
        uint32
    ) internal pure override returns (bytes memory) {
        return abi.encodePacked(PULL_EXECUTOR_OPTIONS);
    }

    function _AbstractLayerZeroV2HookIsm_onRemoteRouterUnenrolled(
        uint32
    ) internal pure override {}

    function _AbstractLayerZeroV2HookIsm_isVariantRouteConfigured(
        uint32
    ) internal pure override returns (bool) {
        return true;
    }
}
