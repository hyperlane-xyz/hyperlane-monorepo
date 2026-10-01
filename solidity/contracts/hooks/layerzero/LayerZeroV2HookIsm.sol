// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IReceiveUlnE2} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/interfaces/IReceiveUlnE2.sol";
import {ILayerZeroEndpointV2, MessagingFee as LayerZeroMessagingFee, MessagingParams as LayerZeroMessagingParams, MessagingReceipt as LayerZeroMessagingReceipt, Origin as LayerZeroOrigin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {ILayerZeroReceiver} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroReceiver.sol";
import {SetConfigParam as LayerZeroSetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import {MessageLibManager} from "@layerzerolabs/lz-evm-protocol-v2/contracts/MessageLibManager.sol";
import {PacketV1Codec} from "@layerzerolabs/lz-evm-protocol-v2/contracts/messagelib/libs/PacketV1Codec.sol";
import {ExecutorConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/SendLibBase.sol";
import {UlnConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/UlnBase.sol";

// ============ Internal Imports ============
import {Router} from "../../client/Router.sol";
import {AbstractCcipReadIsm} from "../../isms/ccip-read/AbstractCcipReadIsm.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {ILayerZeroPacketService} from "../../interfaces/layerzero/ILayerZeroPacketService.sol";
import {LayerZeroMessage} from "../../libs/LayerZeroMessage.sol";
import {LayerZeroMetadata} from "../../libs/LayerZeroMetadata.sol";
import {Message} from "../../libs/Message.sol";
import {ReverseMappingLib} from "../../libs/ReverseMapping.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {AbstractPostDispatchHook} from "../libs/AbstractPostDispatchHook.sol";
import {StandardHookMetadata} from "../libs/StandardHookMetadata.sol";
import {LayerZeroConfigTypeLib} from "./libs/LayerZeroConfigType.sol";

/**
 * @title LayerZeroV2HookIsm
 * @notice Combined Hyperlane hook and ISM that authenticates messages against
 * LayerZero V2 DVN-verified packets obtained through offchain lookup.
 * @dev The origin hook sends a LayerZero packet committing to the Hyperlane
 * message ID. On the destination, `verify` checks the packet against the
 * enrolled peer and commits DVN verification through the receive library if
 * the Endpoint has not already stored its payload hash. LayerZero execution
 * is not required for Hyperlane delivery.
 */
// `Router` already provides enumerable remote-domain storage.
// solhint-disable-next-line hyperlane/enumerable-domain-mapping
contract LayerZeroV2HookIsm is
    Router,
    AbstractPostDispatchHook,
    AbstractCcipReadIsm,
    ILayerZeroReceiver
{
    // Message and PacketV1Codec both define sender/nonce accessors. Use
    // Message's static calls to keep the LayerZero packet accessors unambiguous.
    using StandardHookMetadata for bytes;
    using LayerZeroMetadata for bytes;
    using PacketV1Codec for bytes;
    using TypeCasts for address;
    using ReverseMappingLib for ReverseMappingLib.Uint32ReverseMappingStorage;

    // ============ Constants ============

    // Standard Executors reject missing or zero-gas lzReceive options. One
    // gas keeps the pathway quotable without funding callback execution.
    // LayerZero OptionsBuilder.newOptions().addExecutorLzReceiveOption(1, 0):
    // 0003 = type-3 options, 01 = Executor worker, 0011 = 17-byte option,
    // 01 = lzReceive, and the final 16 bytes encode uint128(1) gas.
    // The zero native value is omitted by ExecutorOptions.encodeLzReceiveOption.
    bytes22 internal constant PULL_EXECUTOR_OPTIONS =
        hex"00030100110100000000000000000000000000000001";

    // Optional Endpoint.clear gas cap. 50k exceeds the 26,610 gas measured
    // for a single-packet clear in the Ethereum fork test (block 25,878,200),
    // while bounding cleanup work when a long nonce backlog accumulates.
    uint256 internal constant CLEAR_GAS_LIMIT = 50_000;
    uint256 internal constant PACKET_MESSAGE_OFFSET = 113;
    uint8 internal constant PACKET_VERSION = 1;

    // ============ Errors ============

    error InvalidLayerZeroEndpoint();
    error InvalidLocalEndpointId();
    error UnsupportedNativeTokenEndpoint(address nativeToken);
    error IncompleteLayerZeroRoute(uint32 domainId);
    error UnknownLayerZeroRoute(uint32 domainId);
    error InvalidRemoteDomain(uint32 domainId);
    error InvalidRemoteEndpointId(uint32 endpointId);
    error InvalidLayerZeroPeer(bytes32 peer);
    error LayerZeroEndpointIdAssignedToAnotherDomain(
        uint32 endpointId,
        uint32 assignedDomainId
    );
    error UnregisteredLayerZeroLibrary(address libraryAddress);
    error MessageNotLatestDispatched(bytes32 messageId);
    error LayerZeroAuthorizationAlreadySent(bytes32 messageId);
    error UnsupportedLayerZeroTokenFee(uint256 fee);
    error HyperlaneHandleUnsupported();

    error UnauthorizedCaller(address caller);
    error MessageNotBeingProcessed(bytes32 messageId);
    error WrongPacketSourceEndpointId(uint32 actual, uint32 expected);
    error WrongPacketSender(bytes32 actual, bytes32 expected);
    error WrongPacketDestinationEndpointId(uint32 actual, uint32 expected);
    error WrongPacketReceiver(bytes32 actual, bytes32 expected);
    error WrongPacketMessage();
    error WrongPacketGuid(bytes32 actual, bytes32 expected);
    error InvalidReceiveLibrary(address libraryAddress);
    error ConflictingPayloadHash(bytes32 current, bytes32 expected);
    error InvalidLayerZeroPacketLength(uint256 length);
    error InvalidLayerZeroPacketVersion(uint8 version);
    error MessageNotDelivered(bytes32 messageId);

    // ============ Events ============

    /// @notice Emitted when a remote hook/ISM and its endpoint ID are enrolled.
    event LayerZeroRemoteRouterEnrolled(
        uint32 indexed domainId,
        uint32 indexed endpointId,
        bytes32 domainIsm
    );

    /// @notice Emitted after a remote hook/ISM and endpoint-ID binding are removed.
    event LayerZeroRemoteRouterUnenrolled(
        uint32 indexed domainId,
        uint32 indexed endpointId,
        bytes32 domainIsm
    );

    /// @notice Correlates a Hyperlane message with its outbound LayerZero packet.
    event LayerZeroAuthorizationSent(
        bytes32 indexed messageId,
        uint32 indexed destination,
        uint32 indexed dstEndpointId,
        bytes32 guid,
        uint64 nonce,
        uint256 nativeFee
    );

    /// @notice Emitted when the outbound message library is explicitly selected.
    event LayerZeroSendLibrarySet(
        uint32 indexed endpointId,
        address indexed libraryAddress
    );

    /// @notice Emitted when the inbound verification library is selected.
    event LayerZeroReceiveLibrarySet(
        uint32 indexed endpointId,
        address indexed libraryAddress
    );

    /// @notice Emitted when the packet matches the Hyperlane message and the
    /// Endpoint stores its payload hash, either before or during this call.
    event LayerZeroPayloadVerified(
        bytes32 indexed messageId,
        uint32 indexed originDomain,
        uint32 indexed srcEndpointId,
        bytes32 guid,
        uint64 nonce
    );

    /// @notice Emitted when bounded Endpoint cleanup fails after verification.
    event LayerZeroPayloadClearFailed(
        bytes32 indexed messageId,
        uint32 indexed originDomain,
        uint32 indexed srcEndpointId,
        bytes32 guid,
        uint64 nonce
    );

    // ============ Types ============

    /// @notice Complete remote hook/ISM configuration and LayerZero pathway policy.
    /// @dev Send settings govern outbound packets to this peer; receive settings
    /// govern inbound packets from it. Both directions are configured locally.
    struct RemoteRouterConfig {
        /// @notice Hyperlane domain of the remote hook/ISM.
        uint32 domainId;
        /// @notice Remote hook/ISM address encoded as `bytes32`.
        bytes32 domainIsm;
        /// @notice LayerZero endpoint ID of the remote chain.
        uint32 endpointId;
        /// @notice Library the local Endpoint uses to encode outbound packets,
        /// quote fees, and assign DVN/Executor work for this destination.
        address sendLibrary;
        /// @notice Library that checks DVN attestations for inbound packets
        /// from this source before committing them to the local Endpoint.
        /// Must support `IReceiveUlnE2.commitVerification` for pull verification.
        address receiveLibrary;
        /// @notice Executor policy applied only to outbound packets.
        /// An all-zero value selects the send library's default.
        ExecutorConfig executorConfig;
        /// @notice DVN and confirmation policy applied in both directions.
        /// An all-zero value selects each library's mutable, owner-controlled
        /// default and therefore extends trust to that library's governance.
        UlnConfig ulnConfig;
    }

    /// @dev Fields retained for packet verification and cleanup.
    struct PacketContext {
        /// @dev Receive library supplied in metadata; checked against Endpoint
        /// policy only if the payload hash has not already been committed.
        address receiveLibrary;
        /// @dev Hyperlane domain ID of the chain that dispatched the message.
        uint32 originDomain;
        /// @dev Packet source endpoint ID; must match the enrolled route.
        uint32 sourceEndpointId;
        /// @dev Packet sender as `bytes32`; must match the enrolled hook/ISM
        /// without truncating non-EVM address bytes.
        bytes32 sender;
        /// @dev LayerZero's per-path packet nonce.
        uint64 nonce;
        /// @dev Packet GUID recomputed from the nonce and route identity.
        bytes32 guid;
        /// @dev Exact hash expected in the destination Endpoint.
        bytes32 payloadHash;
        /// @dev Authorization payload encoded in the packet.
        bytes message;
        /// @dev Packet header passed to the receive library if commitment is needed.
        bytes header;
    }

    // ============ Immutables ============

    /// @notice Local LayerZero Endpoint V2 used for quotes, sends, and verification.
    ILayerZeroEndpointV2 public immutable endpointContract;
    /// @notice LayerZero endpoint ID reported by the local Endpoint at deployment.
    uint32 public immutable localEndpointId;

    // ============ Storage ============

    /// @dev One-to-one Hyperlane domain and LayerZero endpoint ID assignments.
    ReverseMappingLib.Uint32ReverseMappingStorage private remoteEndpointIds;

    /// @notice Most recent Hyperlane message ID whose authorization packet was
    /// successfully sent by this hook.
    bytes32 public latestPublishedAuthorizationMessageId;

    // ============ Constructor ============

    constructor(
        address _mailboxAddress,
        address _endpointAddress,
        string[] memory _urls
    ) Router(_mailboxAddress) {
        if (!Address.isContract(_endpointAddress)) {
            revert InvalidLayerZeroEndpoint();
        }

        endpointContract = ILayerZeroEndpointV2(_endpointAddress);
        localEndpointId = endpointContract.eid();
        if (localEndpointId == 0) {
            revert InvalidLocalEndpointId();
        }

        address nativeTokenAddress = endpointContract.nativeToken();
        if (nativeTokenAddress != address(0)) {
            revert UnsupportedNativeTokenEndpoint(nativeTokenAddress);
        }

        setUrls(_urls);
    }

    // ============ IPostDispatchHook ============

    /// @notice Identifies this deployment as a LayerZero post-dispatch hook.
    function hookType() external pure returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.LAYER_ZERO);
    }

    /// @notice Accepts valid hook metadata using native fees.
    /// @dev `msgValue` is intentionally ignored because aggregations pass the
    /// same metadata to every child. This hook always encodes zero destination
    /// native value; transaction `msg.value` pays its LayerZero messaging fee.
    function supportsMetadata(
        bytes calldata metadata
    ) public view override returns (bool) {
        return
            super.supportsMetadata(metadata) &&
            metadata.feeToken(address(0)) == address(0);
    }

    // ============ IInterchainSecurityModule ============

    /// @notice Authenticates the LayerZero packet for a message being processed
    /// by the Mailbox, then returns true without requiring Executor delivery.
    /// @dev Packet and route checks precede any receive-library or Endpoint call.
    function verify(
        bytes calldata metadata,
        bytes calldata message
    ) external override returns (bool) {
        bytes32 messageId = Message.id(message);
        // Prevent direct callers from clearing the packet before Mailbox
        // delivery. `clear` deletes the Endpoint payload hash after ULN has
        // deleted the DVN attestations, which would leave the corresponding
        // Hyperlane message without a proof and therefore undeliverable.
        if (!_isProcessing(messageId)) {
            revert MessageNotBeingProcessed(messageId);
        }

        // Offchain metadata is untrusted. Bind its packet to the enrolled
        // source, this receiver, and the exact Hyperlane message ID.
        PacketContext memory context = _validatePacket(
            metadata,
            message,
            messageId
        );

        // A matching Endpoint payload hash proves prior verification;
        // otherwise the receive library checks DVN attestations and commits it.
        _commitPacketVerification(context);
        emit LayerZeroPayloadVerified(
            messageId,
            context.originDomain,
            context.sourceEndpointId,
            context.guid,
            context.nonce
        );

        // Keep the Endpoint's payload/nonce backlog short when affordable;
        // packet authentication above is sufficient for Hyperlane delivery.
        _tryClearPacket(context, messageId);

        return true;
    }

    // ============ Router ============

    /// @notice Returns the LayerZero endpoint ID assigned to a Hyperlane domain.
    /// @dev Returns zero if the domain has no LayerZero route.
    function remoteLzEndpointIds(
        uint32 domainId
    ) public view returns (uint32 endpointId) {
        return remoteEndpointIds.reverseKeyOf(domainId);
    }

    /// @notice Returns the Hyperlane domain assigned to a LayerZero endpoint ID.
    /// @dev `enrolled` distinguishes domain ID zero from an unassigned endpoint.
    function domainIdForRemoteLayerZeroEndpointId(
        uint32 endpointId
    ) public view returns (bool enrolled, uint32 hyperlaneDomainId) {
        ReverseMappingLib.ReverseEntry memory entry = remoteEndpointIds.keyOf(
            endpointId
        );

        return (entry.assigned, entry.key);
    }

    /// @notice Installs or replaces remote routes and their LayerZero policies atomically.
    /// @dev All-zero configs select the library defaults. An abandoned
    /// endpoint ID is blocked, but an unchanged path stays selected.
    function enrollRemoteRouters(
        RemoteRouterConfig[] calldata newRemoteConfigs
    ) external onlyOwner {
        for (uint256 i = 0; i < newRemoteConfigs.length; ++i) {
            _validateRemoteRouterConfig(newRemoteConfigs[i]);
            _configureLayerZeroPath(newRemoteConfigs[i]);
            _enrollLayerZeroRemoteRouter(newRemoteConfigs[i]);
        }
    }

    /// @dev Prevents inherited partial enrollment. LayerZero routes must use
    /// this contract's enrollment function to configure the Endpoint too.
    function _enrollRemoteRouter(
        uint32 domainId,
        bytes32
    ) internal pure override {
        revert IncompleteLayerZeroRoute(domainId);
    }

    /// @dev Records the Hyperlane peer and its one-to-one endpoint ID binding.
    function _enrollLayerZeroRemoteRouter(
        RemoteRouterConfig calldata newRemoteConfig
    ) internal {
        // The reverse lookup lets incoming packets find the Hyperlane domain.
        super._enrollRemoteRouter(
            newRemoteConfig.domainId,
            newRemoteConfig.domainIsm
        );
        remoteEndpointIds.assign(
            newRemoteConfig.domainId,
            newRemoteConfig.endpointId
        );

        emit LayerZeroRemoteRouterEnrolled(
            newRemoteConfig.domainId,
            newRemoteConfig.endpointId,
            newRemoteConfig.domainIsm
        );
    }

    /// @dev Installs the complete LayerZero policy. If the endpoint ID changes,
    /// the previous path is blocked before the new path is configured.
    function _configureLayerZeroPath(
        RemoteRouterConfig calldata newRemoteConfig
    ) internal {
        uint32 previousEndpointId = remoteEndpointIds.reverseKeyOf(
            newRemoteConfig.domainId
        );
        if (
            previousEndpointId != 0 &&
            previousEndpointId != newRemoteConfig.endpointId
        ) {
            // Endpoint library selections outlive our route mappings. Block
            // both libraries so the retired path cannot continue accepting
            // DVN commitments after this domain moves to another endpoint ID.
            address blockedLibrary = MessageLibManager(
                address(endpointContract)
            ).blockedLibrary();
            _setSendLibrary(previousEndpointId, blockedLibrary);
            _setReceiveLibrary(previousEndpointId, blockedLibrary);
        }

        _setSendLibrary(
            newRemoteConfig.endpointId,
            newRemoteConfig.sendLibrary
        );
        _setReceiveLibrary(
            newRemoteConfig.endpointId,
            newRemoteConfig.receiveLibrary
        );
        _setLayerZeroConfig(newRemoteConfig);
    }

    /// @dev Rejects endpoint IDs assigned to another domain and invalid policy.
    function _validateRemoteRouterConfig(
        RemoteRouterConfig calldata newRemoteConfig
    ) internal view {
        if (newRemoteConfig.domainId == localDomain) {
            revert InvalidRemoteDomain(newRemoteConfig.domainId);
        }

        if (
            newRemoteConfig.endpointId == 0 ||
            newRemoteConfig.endpointId == localEndpointId
        ) {
            revert InvalidRemoteEndpointId(newRemoteConfig.endpointId);
        }

        if (newRemoteConfig.domainIsm == bytes32(0)) {
            revert InvalidLayerZeroPeer(newRemoteConfig.domainIsm);
        }

        ReverseMappingLib.ReverseEntry
            memory currentEndpoint = remoteEndpointIds.keyOf(
                newRemoteConfig.endpointId
            );
        if (
            currentEndpoint.assigned &&
            currentEndpoint.key != newRemoteConfig.domainId
        ) {
            revert LayerZeroEndpointIdAssignedToAnotherDomain(
                newRemoteConfig.endpointId,
                currentEndpoint.key
            );
        }

        _validateRegisteredLibrary(newRemoteConfig.sendLibrary);
        _validateRegisteredLibrary(newRemoteConfig.receiveLibrary);
    }

    /// @dev Router's owner-gated unenrollment methods call this override.
    /// Endpoint library selections persist independently of Hyperlane's route,
    /// so both must be blocked when the route is removed. Library config may
    /// remain because every enrollment replaces it completely.
    function _unenrollRemoteRouter(uint32 domainId) internal override {
        uint32 endpointId = remoteEndpointIds.reverseKeyOf(domainId);
        if (endpointId == 0) {
            revert UnknownLayerZeroRoute(domainId);
        }

        bytes32 domainIsm = _mustHaveRemoteRouter(domainId);
        // Deleting Hyperlane's mappings alone would leave an initialized
        // Endpoint path able to accept DVN commitments, so block both libraries.
        address blockedLibrary = MessageLibManager(address(endpointContract))
            .blockedLibrary();
        _setSendLibrary(endpointId, blockedLibrary);
        _setReceiveLibrary(endpointId, blockedLibrary);

        // Free the endpoint ID for another domain and remove the Router peer.
        remoteEndpointIds.remove(domainId);
        super._unenrollRemoteRouter(domainId);

        emit LayerZeroRemoteRouterUnenrolled(domainId, endpointId, domainIsm);
    }

    /// @dev Rejects unknown domains before quoting or authenticating packets.
    function _mustHaveRemoteEndpointId(
        uint32 domainId
    ) internal view returns (uint32 endpointId) {
        endpointId = remoteEndpointIds.reverseKeyOf(domainId);
        if (endpointId == 0) {
            revert UnknownLayerZeroRoute(domainId);
        }
    }

    /// @dev LayerZero carries a message-ID authorization, not a Hyperlane
    /// application body; inbound delivery goes through `verify` instead.
    function _handle(uint32, bytes32, bytes calldata) internal pure override {
        revert HyperlaneHandleUnsupported();
    }

    // ============ Hook ============

    /// @dev LayerZero's quote includes the configured send library's DVN and
    /// Executor fees. The hook never pays in LayerZero tokens.
    function _quoteDispatch(
        bytes calldata,
        bytes calldata message
    ) internal view override returns (uint256) {
        bytes32 messageId = Message.id(message);
        return _quoteLzNativeFee(_lzNativeFeeQuoteParams(message, messageId));
    }

    function _quoteLzNativeFee(
        LayerZeroMessagingParams memory params
    ) internal view returns (uint256) {
        LayerZeroMessagingFee memory fee = endpointContract.quote(
            params,
            address(this)
        );
        if (fee.lzTokenFee != 0) {
            revert UnsupportedLayerZeroTokenFee(fee.lzTokenFee);
        }

        return fee.nativeFee;
    }

    /// @dev Sends one authorization packet for the latest Mailbox dispatch.
    /// The Endpoint validates the supplied fee and refunds any excess. The
    /// latest published ID write rolls back if sending or refunding fails.
    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        bytes32 messageId = Message.id(message);
        if (!_isLatestDispatched(messageId)) {
            revert MessageNotLatestDispatched(messageId);
        }

        if (latestPublishedAuthorizationMessageId == messageId) {
            revert LayerZeroAuthorizationAlreadySent(messageId);
        }

        LayerZeroMessagingParams memory params = _lzNativeFeeQuoteParams(
            message,
            messageId
        );

        // Effect before the Endpoint call; a later failure reverts this write.
        latestPublishedAuthorizationMessageId = messageId;

        address refundAddress = metadata.refundAddress(
            Message.senderAddress(message)
        );
        LayerZeroMessagingReceipt memory receipt = endpointContract.send{
            value: msg.value
        }(params, refundAddress);

        emit LayerZeroAuthorizationSent(
            messageId,
            Message.destination(message),
            params.dstEid,
            receipt.guid,
            receipt.nonce,
            receipt.fee.nativeFee
        );
    }

    /// @dev Builds the same message-ID commitment and one-gas Executor option
    /// for quoting and sending; payment is always in native currency.
    function _lzNativeFeeQuoteParams(
        bytes calldata message,
        bytes32 messageId
    ) internal view returns (LayerZeroMessagingParams memory) {
        uint32 destination = Message.destination(message);
        uint32 endpointId = _mustHaveRemoteEndpointId(destination);

        return
            LayerZeroMessagingParams({
                dstEid: endpointId,
                receiver: _mustHaveRemoteRouter(destination),
                message: LayerZeroMessage.encode(
                    localDomain,
                    destination,
                    messageId
                ),
                options: abi.encodePacked(PULL_EXECUTOR_OPTIONS),
                payInLzToken: false
            });
    }

    // ============ LayerZero Endpoint configuration ============

    /// @dev This contract requires explicit, registered message libraries.
    /// Registration alone does not prove compatibility with its ULN
    /// pull-verification path.
    function _validateRegisteredLibrary(address libraryAddress) internal view {
        if (
            libraryAddress == address(0) ||
            !endpointContract.isRegisteredLibrary(libraryAddress)
        ) {
            revert UnregisteredLayerZeroLibrary(libraryAddress);
        }
    }

    /// @dev Applies one symmetric ULN policy in both directions and the
    /// Executor policy only on sends. A shared library is configured once.
    function _setLayerZeroConfig(
        RemoteRouterConfig calldata remoteConfig
    ) internal {
        LayerZeroSetConfigParam[] memory sendParams = _sendConfigParams(
            remoteConfig
        );
        endpointContract.setConfig(
            address(this),
            remoteConfig.sendLibrary,
            sendParams
        );

        if (remoteConfig.receiveLibrary == remoteConfig.sendLibrary) {
            return;
        }

        LayerZeroSetConfigParam[] memory receiveParams = _receiveConfigParams(
            remoteConfig
        );
        endpointContract.setConfig(
            address(this),
            remoteConfig.receiveLibrary,
            receiveParams
        );
    }

    function _sendConfigParams(
        RemoteRouterConfig calldata remoteConfig
    ) internal pure returns (LayerZeroSetConfigParam[] memory params) {
        params = new LayerZeroSetConfigParam[](2);
        params[0] = LayerZeroSetConfigParam({
            eid: remoteConfig.endpointId,
            configType: LayerZeroConfigTypeLib.EXECUTOR,
            config: abi.encode(remoteConfig.executorConfig)
        });
        params[1] = LayerZeroSetConfigParam({
            eid: remoteConfig.endpointId,
            configType: LayerZeroConfigTypeLib.ULN,
            config: abi.encode(remoteConfig.ulnConfig)
        });
    }

    function _receiveConfigParams(
        RemoteRouterConfig calldata remoteConfig
    ) internal pure returns (LayerZeroSetConfigParam[] memory params) {
        params = new LayerZeroSetConfigParam[](1);
        params[0] = LayerZeroSetConfigParam({
            eid: remoteConfig.endpointId,
            configType: LayerZeroConfigTypeLib.ULN,
            config: abi.encode(remoteConfig.ulnConfig)
        });
    }

    /// @dev Selects the send library unless an enrolled path already uses it.
    /// Fresh paths still pin their library explicitly, even if it is the default.
    function _setSendLibrary(
        uint32 endpointId,
        address libraryAddress
    ) internal {
        if (
            remoteEndpointIds.keyOf(endpointId).assigned &&
            endpointContract.getSendLibrary(address(this), endpointId) ==
            libraryAddress
        ) {
            return;
        }

        endpointContract.setSendLibrary(
            address(this),
            endpointId,
            libraryAddress
        );

        emit LayerZeroSendLibrarySet(endpointId, libraryAddress);
    }

    /// @dev Selects the receive library unless an enrolled path already uses it.
    /// A zero grace period immediately invalidates the previous library on
    /// rotation, avoiding two concurrently authorized receive libraries.
    /// Operators must first drain in-flight packets or have them re-attested
    /// against the replacement library.
    function _setReceiveLibrary(
        uint32 endpointId,
        address libraryAddress
    ) internal {
        if (remoteEndpointIds.keyOf(endpointId).assigned) {
            (address currentLibrary, ) = endpointContract.getReceiveLibrary(
                address(this),
                endpointId
            );

            if (currentLibrary == libraryAddress) {
                return;
            }
        }

        endpointContract.setReceiveLibrary(
            address(this),
            endpointId,
            libraryAddress,
            0
        );

        emit LayerZeroReceiveLibrarySet(endpointId, libraryAddress);
    }

    // ============ ILayerZeroReceiver ============

    /// @notice Allows Endpoint V2 to initialize an inbound message path.
    /// @dev Endpoint.verify calls this when the path's lazy inbound nonce is
    /// zero. Without it, the first packet from a peer cannot be committed.
    /// Requiring an exact enrolled endpoint ID/peer binding prevents an arbitrary
    /// sender from initializing a path to this OApp.
    function allowInitializePath(
        LayerZeroOrigin calldata origin
    ) external view returns (bool) {
        ReverseMappingLib.ReverseEntry memory remoteEndpoint = remoteEndpointIds
            .keyOf(origin.srcEid);
        if (!remoteEndpoint.assigned) {
            return false;
        }

        return routers(remoteEndpoint.key) == origin.sender;
    }

    /// @notice Reports whether this OApp requires ordered message execution.
    /// @dev Required by `ILayerZeroReceiver`. Returning zero opts out of
    /// application-level ordered execution; Endpoint V2 still assigns,
    /// verifies, and clears packets using their protocol nonces.
    function nextNonce(uint32, bytes32) external pure returns (uint64) {
        return 0;
    }

    /// @notice Rejects LayerZero callback delivery until the corresponding
    /// Hyperlane message has been delivered.
    /// @dev Endpoint V2 clears before calling this receiver (LayerZero v2.0.2):
    /// https://github.com/LayerZero-Labs/LayerZero-v2/blob/9c741e7f9790639537b1710a203bcdfd73b0b9ac/packages/layerzero-v2/evm/protocol/contracts/EndpointV2.sol#L179-L181
    /// Reverting here rolls that clear back; `verify` can separately clear
    /// its authenticated packet.
    function lzReceive(
        LayerZeroOrigin calldata,
        bytes32,
        bytes calldata payload,
        address,
        bytes calldata
    ) external payable override {
        if (msg.sender != address(endpointContract)) {
            revert UnauthorizedCaller(msg.sender);
        }

        LayerZeroMessage.Message memory lzMessage = LayerZeroMessage.decode(
            payload
        );
        if (!mailbox.delivered(lzMessage.messageId)) {
            revert MessageNotDelivered(lzMessage.messageId);
        }
    }

    // ============ Packet verification ============

    /// @dev Metadata is untrusted. Bind its packet to the enrolled LayerZero
    /// path and the exact Hyperlane message before using it for verification.
    function _validatePacket(
        bytes calldata metadata,
        bytes calldata hyperlaneMessage,
        bytes32 messageId
    ) internal view returns (PacketContext memory context) {
        bytes calldata lzPacket;
        // The supplied receive library is only a hint; the Endpoint checks it
        // later if this packet still needs a verification commitment.
        (context.receiveLibrary, lzPacket) = metadata.decode();
        _validatePacketEncoding(lzPacket);

        // The endpoint ID identifies the origin chain; the sender must be its
        // enrolled hook/ISM. Both must match the Hyperlane message's origin.
        context.originDomain = Message.origin(hyperlaneMessage);
        uint32 expectedSourceEndpointId = _mustHaveRemoteEndpointId(
            context.originDomain
        );
        context.sourceEndpointId = lzPacket.srcEid();
        if (context.sourceEndpointId != expectedSourceEndpointId) {
            revert WrongPacketSourceEndpointId(
                context.sourceEndpointId,
                expectedSourceEndpointId
            );
        }

        bytes32 expectedSender = _mustHaveRemoteRouter(context.originDomain);
        context.sender = lzPacket.sender();
        if (context.sender != expectedSender) {
            revert WrongPacketSender(context.sender, expectedSender);
        }

        // Reject packets for another LayerZero endpoint or another OApp on
        // this endpoint, even if their source path and payload match.
        uint32 destinationEndpointId = lzPacket.dstEid();
        if (destinationEndpointId != localEndpointId) {
            revert WrongPacketDestinationEndpointId(
                destinationEndpointId,
                localEndpointId
            );
        }

        bytes32 expectedReceiver = address(this).addressToBytes32();
        bytes32 packetReceiver = lzPacket.receiver();
        if (packetReceiver != expectedReceiver) {
            revert WrongPacketReceiver(packetReceiver, expectedReceiver);
        }

        // The versioned payload commits to both Hyperlane domains and the ID
        // of the entire Hyperlane message, not just its body.
        context.message = LayerZeroMessage.encode(
            context.originDomain,
            localDomain,
            messageId
        );
        if (keccak256(lzPacket.message()) != keccak256(context.message)) {
            revert WrongPacketMessage();
        }

        context.nonce = lzPacket.nonce();
        context.guid = lzPacket.guid();
        // The GUID is part of the payload hash. Recompute it from the checked
        // path and nonce; GUID.generate would truncate non-EVM peer bytes.
        bytes32 expectedGuid = keccak256(
            abi.encodePacked(
                context.nonce,
                context.sourceEndpointId,
                context.sender,
                destinationEndpointId,
                packetReceiver
            )
        );
        if (context.guid != expectedGuid) {
            revert WrongPacketGuid(context.guid, expectedGuid);
        }

        // ULN commitment uses the packet header and hash of GUID + message.
        context.payloadHash = lzPacket.payloadHash();
        context.header = lzPacket.header();
    }

    /// @dev Accepts only the packet version and exact fixed-length payload
    /// used by `LayerZeroMessage`; rejects any trailing data.
    function _validatePacketEncoding(bytes calldata lzPacket) internal pure {
        if (
            lzPacket.length != PACKET_MESSAGE_OFFSET + LayerZeroMessage.LENGTH
        ) {
            revert InvalidLayerZeroPacketLength(lzPacket.length);
        }

        uint8 version = lzPacket.version();
        if (version != PACKET_VERSION) {
            revert InvalidLayerZeroPacketVersion(version);
        }
    }

    /// @dev A matching stored payload hash proves prior verification without
    /// consuming the packet. Otherwise the receive library checks the DVNs'
    /// recorded attestations and commits the hash to the Endpoint.
    /// ULN302 deletes those attestations on commitment, so calling
    /// `commitVerification` again without fresh attestations reverts:
    /// https://github.com/LayerZero-Labs/LayerZero-v2/blob/9c741e7f9790639537b1710a203bcdfd73b0b9ac/packages/layerzero-v2/evm/messagelib/contracts/uln/ReceiveUlnBase.sol#L59-L75
    /// Only the uncommitted path uses the metadata-supplied library address.
    function _commitPacketVerification(PacketContext memory context) internal {
        bytes32 currentPayloadHash = endpointContract.inboundPayloadHash(
            address(this),
            context.sourceEndpointId,
            context.sender,
            context.nonce
        );

        if (currentPayloadHash == bytes32(0)) {
            if (
                !endpointContract.isValidReceiveLibrary(
                    address(this),
                    context.sourceEndpointId,
                    context.receiveLibrary
                )
            ) {
                revert InvalidReceiveLibrary(context.receiveLibrary);
            }

            IReceiveUlnE2(context.receiveLibrary).commitVerification(
                context.header,
                context.payloadHash
            );
            currentPayloadHash = endpointContract.inboundPayloadHash(
                address(this),
                context.sourceEndpointId,
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
    }

    /// @dev Attempts Endpoint cleanup with bounded gas. `clear` calls `_clearPayload`,
    /// which scans from the lazy inbound nonce through this packet's nonce:
    /// https://github.com/LayerZero-Labs/LayerZero-v2/blob/9c741e7f9790639537b1710a203bcdfd73b0b9ac/packages/layerzero-v2/evm/protocol/contracts/EndpointV2.sol#L211-L215
    /// https://github.com/LayerZero-Labs/LayerZero-v2/blob/9c741e7f9790639537b1710a203bcdfd73b0b9ac/packages/layerzero-v2/evm/protocol/contracts/MessagingChannel.sol#L129-L141
    /// A long verified backlog can exhaust the budget. Failure must not block
    /// Hyperlane delivery.
    function _tryClearPacket(
        PacketContext memory context,
        bytes32 messageId
    ) internal {
        (bool cleared, ) = address(endpointContract).call{gas: CLEAR_GAS_LIMIT}(
            abi.encodeCall(
                ILayerZeroEndpointV2.clear,
                (address(this), _origin(context), context.guid, context.message)
            )
        );

        if (!cleared) {
            emit LayerZeroPayloadClearFailed(
                messageId,
                context.originDomain,
                context.sourceEndpointId,
                context.guid,
                context.nonce
            );
        }
    }

    function _origin(
        PacketContext memory context
    ) internal pure returns (LayerZeroOrigin memory) {
        return
            LayerZeroOrigin({
                srcEid: context.sourceEndpointId,
                sender: context.sender,
                nonce: context.nonce
            });
    }

    // ============ AbstractCcipReadIsm ============

    /// @dev Requests the packet for a Hyperlane message from the configured
    /// offchain lookup service. The response is untrusted until `verify` checks it.
    function _offchainLookupCalldata(
        bytes calldata message
    ) internal pure override returns (bytes memory) {
        return
            abi.encodeCall(
                ILayerZeroPacketService.getLayerZeroPacket,
                (message)
            );
    }
}
