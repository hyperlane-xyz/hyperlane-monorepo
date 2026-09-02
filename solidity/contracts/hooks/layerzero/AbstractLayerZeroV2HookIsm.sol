// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ILayerZeroEndpointV2, MessagingFee as LayerZeroMessagingFee, MessagingParams as LayerZeroMessagingParams, MessagingReceipt as LayerZeroMessagingReceipt, Origin as LayerZeroOrigin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {ILayerZeroReceiver} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroReceiver.sol";
import {SetConfigParam as LayerZeroSetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import {Router} from "../../client/Router.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {Message} from "../../libs/Message.sol";
import {LayerZeroMessage} from "../../libs/LayerZeroMessage.sol";
import {StandardHookMetadata} from "../libs/StandardHookMetadata.sol";
import {AbstractPostDispatchHook} from "../libs/AbstractPostDispatchHook.sol";

// LayerZero EID mappings are a translation table, not Hyperlane domain config.
// solhint-disable-next-line hyperlane/enumerable-domain-mapping
abstract contract AbstractLayerZeroV2HookIsm is
    Router,
    AbstractPostDispatchHook,
    ILayerZeroReceiver
{
    using Message for bytes;
    using StandardHookMetadata for bytes;

    // ============ Types ============

    struct RemoteLayerZeroConfig {
        uint32 eid;
    }

    struct RemoteRouterEnrollment {
        uint32 domain;
        bytes32 router;
        uint32 eid;
        address sendLibrary;
        address receiveLibrary;
        uint256 receiveLibraryGracePeriod;
        address receiveLibraryTimeout;
        uint256 receiveLibraryTimeoutExpiry;
        LayerZeroSetConfigParam[] sendConfig;
        LayerZeroSetConfigParam[] receiveConfig;
    }

    struct RemoteRouterConfigUpdate {
        uint32 domain;
        bytes32 router;
        address receiveLibraryTimeout;
        uint256 receiveLibraryTimeoutExpiry;
        LayerZeroSetConfigParam[] sendConfig;
        LayerZeroSetConfigParam[] receiveConfig;
    }

    // ============ Storage ============

    ILayerZeroEndpointV2 public immutable endpoint;
    uint32 public immutable localEid;

    mapping(uint32 domain => RemoteLayerZeroConfig remoteConfig)
        public remoteConfigs;
    mapping(uint32 eid => uint64 domainPlusOne) public domainsByEid;
    mapping(bytes32 messageId => bool wasSent) public sent;

    // ============ Events ============

    event LayerZeroRemoteRouterEnrolled(
        uint32 indexed domain,
        uint32 indexed eid,
        bytes32 router
    );
    event LayerZeroRemoteRouterUnenrolled(
        uint32 indexed domain,
        uint32 indexed eid,
        bytes32 router
    );
    event LayerZeroAuthorizationSent(
        bytes32 indexed messageId,
        uint32 indexed destination,
        uint32 indexed dstEid,
        bytes32 guid,
        uint64 nonce,
        uint256 nativeFee
    );
    event LayerZeroSendLibrarySet(
        uint32 indexed eid,
        address indexed libraryAddress
    );
    event LayerZeroReceiveLibrarySet(
        uint32 indexed eid,
        address indexed libraryAddress,
        uint256 gracePeriod
    );
    event LayerZeroReceiveLibraryTimeoutSet(
        uint32 indexed eid,
        address indexed libraryAddress,
        uint256 expiry
    );
    event LayerZeroConfigSet(address indexed libraryAddress);

    // ============ Errors ============

    error InvalidLayerZeroEndpoint();
    error InvalidLocalEid();
    error UnsupportedNativeTokenEndpoint(address nativeToken);
    error IncompleteLayerZeroRoute(uint32 domain);
    error UnknownLayerZeroRoute(uint32 domain);
    error InvalidRemoteDomain(uint32 domain);
    error InvalidRemoteEid(uint32 eid);
    error NonCanonicalLayerZeroPeer(bytes32 peer);
    error LayerZeroEidAlreadyEnrolled(uint32 eid, uint32 domain);
    error LayerZeroEidChangeRequiresUnenrollment(uint32 domain);
    error UnregisteredLayerZeroLibrary(address libraryAddress);
    error DefaultLayerZeroLibrary(uint32 eid);
    error InvalidLayerZeroConfigEid(uint32 eid);
    error InvalidLayerZeroReceiveLibraryTimeout();
    error InvalidLayerZeroReceiveLibraryGracePeriod();
    error LayerZeroEnrollmentLengthMismatch();
    error UnsupportedLayerZeroMetadata();
    error MessageNotLatestDispatched(bytes32 messageId);
    error LayerZeroAuthorizationAlreadySent(bytes32 messageId);
    error InsufficientLayerZeroFee(uint256 required, uint256 supplied);
    error UnsupportedLayerZeroTokenFee(uint256 fee);
    error HyperlaneHandleUnsupported();

    // ============ Constructor ============

    constructor(address mailbox_, address endpoint_) Router(mailbox_) {
        if (!Address.isContract(endpoint_)) {
            revert InvalidLayerZeroEndpoint();
        }
        endpoint = ILayerZeroEndpointV2(endpoint_);
        uint32 eid_ = endpoint.eid();
        if (eid_ == 0) revert InvalidLocalEid();
        localEid = eid_;
        address nativeToken_ = endpoint.nativeToken();
        if (nativeToken_ != address(0)) {
            revert UnsupportedNativeTokenEndpoint(nativeToken_);
        }
    }

    // ============ Hyperlane Hook Interface ============

    function hookType() external pure returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.LAYER_ZERO);
    }

    function supportsMetadata(
        bytes calldata metadata
    ) public view override returns (bool) {
        return
            super.supportsMetadata(metadata) &&
            metadata.feeToken(address(0)) == address(0) &&
            metadata.msgValue(0) == 0;
    }

    function _validateMetadata(bytes calldata metadata) internal view {
        if (!supportsMetadata(metadata)) revert UnsupportedLayerZeroMetadata();
    }

    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view override returns (uint256) {
        _validateMetadata(metadata);
        LayerZeroMessagingFee memory fee = endpoint.quote(
            _lzNativeFeeQuoteParams(message),
            address(this)
        );
        if (fee.lzTokenFee != 0) {
            revert UnsupportedLayerZeroTokenFee(fee.lzTokenFee);
        }
        return fee.nativeFee;
    }

    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        bytes32 messageId = message.id();
        if (!_isLatestDispatched(messageId)) {
            revert MessageNotLatestDispatched(messageId);
        }
        if (sent[messageId]) {
            revert LayerZeroAuthorizationAlreadySent(messageId);
        }
        _validateMetadata(metadata);
        sent[messageId] = true;

        LayerZeroMessagingParams memory params = _lzNativeFeeQuoteParams(
            message
        );
        LayerZeroMessagingFee memory fee = endpoint.quote(
            params,
            address(this)
        );
        if (fee.lzTokenFee != 0) {
            revert UnsupportedLayerZeroTokenFee(fee.lzTokenFee);
        }
        if (msg.value < fee.nativeFee) {
            revert InsufficientLayerZeroFee(fee.nativeFee, msg.value);
        }
        address refundAddress = metadata.refundAddress(message.senderAddress());
        LayerZeroMessagingReceipt memory receipt = endpoint.send{
            value: fee.nativeFee
        }(params, refundAddress);
        emit LayerZeroAuthorizationSent(
            messageId,
            message.destination(),
            params.dstEid,
            receipt.guid,
            receipt.nonce,
            fee.nativeFee
        );

        _refund(metadata, message, msg.value - fee.nativeFee);
    }

    /// @dev Shared by quote and send; always disables LZ-token payment.
    function _lzNativeFeeQuoteParams(
        bytes calldata message
    ) internal view returns (LayerZeroMessagingParams memory) {
        uint32 destination = message.destination();
        RemoteLayerZeroConfig memory remote = _mustHaveRemoteConfig(
            destination
        );
        return
            LayerZeroMessagingParams({
                dstEid: remote.eid,
                receiver: _mustHaveRemoteRouter(destination),
                message: LayerZeroMessage.encode(
                    localDomain,
                    destination,
                    message.id()
                ),
                options: _AbstractLayerZeroV2HookIsm_options(destination),
                payInLzToken: false
            });
    }

    // ============ LayerZero Receiver Interface ============

    /// @notice Allows Endpoint V2 to initialize an inbound message path.
    /// @dev Endpoint.verify calls this when the path's lazy inbound nonce is
    /// zero. Without it, the first packet from a peer cannot be committed.
    /// Requiring an exact enrolled EID/peer binding prevents an arbitrary
    /// sender from initializing a path to this OApp.
    function allowInitializePath(
        LayerZeroOrigin calldata origin
    ) external view returns (bool) {
        uint64 encoded = domainsByEid[origin.srcEid];
        if (encoded == 0) return false;
        uint32 domain = uint32(encoded - 1);
        return routers(domain) == origin.sender;
    }

    /// @notice Reports whether this OApp requires ordered message execution.
    /// @dev LayerZero Executors query this receiver method. Returning zero opts
    /// out of application-level ordered execution; Endpoint V2 still assigns,
    /// verifies, and clears packets using their protocol nonces.
    function nextNonce(uint32, bytes32) external pure returns (uint64) {
        return 0;
    }

    // ============ Route Configuration ============

    /// @dev Prevents inherited partial enrollment. LayerZero routes must use
    /// the rich enrollment APIs exposed by the concrete variants.
    function _enrollRemoteRouter(uint32, bytes32) internal pure override {
        revert IncompleteLayerZeroRoute(0);
    }

    function _enrollLayerZeroRemoteRouter(
        RemoteRouterEnrollment calldata enrollment
    ) internal {
        if (enrollment.domain == localDomain) {
            revert InvalidRemoteDomain(enrollment.domain);
        }

        if (enrollment.eid == 0 || enrollment.eid == localEid) {
            revert InvalidRemoteEid(enrollment.eid);
        }

        if (
            enrollment.router == bytes32(0) ||
            uint256(enrollment.router) > type(uint160).max
        ) {
            revert NonCanonicalLayerZeroPeer(enrollment.router);
        }
        _validateReceiveLibraryTimeout(
            enrollment.receiveLibraryTimeout,
            enrollment.receiveLibraryTimeoutExpiry
        );

        RemoteLayerZeroConfig memory current = remoteConfigs[enrollment.domain];
        if (current.eid != 0 && current.eid != enrollment.eid) {
            revert LayerZeroEidChangeRequiresUnenrollment(enrollment.domain);
        }
        uint64 existing = domainsByEid[enrollment.eid];
        if (existing != 0 && uint32(existing - 1) != enrollment.domain) {
            revert LayerZeroEidAlreadyEnrolled(
                enrollment.eid,
                uint32(existing - 1)
            );
        }

        super._enrollRemoteRouter(enrollment.domain, enrollment.router);
        remoteConfigs[enrollment.domain] = RemoteLayerZeroConfig({
            eid: enrollment.eid
        });
        domainsByEid[enrollment.eid] = uint64(enrollment.domain) + 1;
        emit LayerZeroRemoteRouterEnrolled(
            enrollment.domain,
            enrollment.eid,
            enrollment.router
        );
        bool sendLibraryChanged = endpoint.isDefaultSendLibrary(
            address(this),
            enrollment.eid
        ) ||
            endpoint.getSendLibrary(address(this), enrollment.eid) !=
            enrollment.sendLibrary;
        if (sendLibraryChanged) {
            _setSendLibrary(enrollment.eid, enrollment.sendLibrary);
        }

        (address currentReceiveLibrary, bool isDefaultReceiveLibrary) = endpoint
            .getReceiveLibrary(address(this), enrollment.eid);
        bool receiveLibraryChanged = isDefaultReceiveLibrary ||
            currentReceiveLibrary != enrollment.receiveLibrary;
        if (receiveLibraryChanged) {
            _setReceiveLibrary(
                enrollment.eid,
                enrollment.receiveLibrary,
                enrollment.receiveLibraryGracePeriod
            );
        } else if (enrollment.receiveLibraryGracePeriod != 0) {
            revert InvalidLayerZeroReceiveLibraryGracePeriod();
        }
        _setEnrollmentLayerZeroConfig(
            enrollment.eid,
            enrollment.sendLibrary,
            enrollment.sendConfig
        );
        _setEnrollmentLayerZeroConfig(
            enrollment.eid,
            enrollment.receiveLibrary,
            enrollment.receiveConfig
        );
        if (enrollment.receiveLibraryTimeout != address(0)) {
            _setReceiveLibraryTimeout(
                enrollment.eid,
                enrollment.receiveLibraryTimeout,
                enrollment.receiveLibraryTimeoutExpiry
            );
        } else if (!receiveLibraryChanged) {
            _clearReceiveLibraryTimeout(
                enrollment.eid,
                enrollment.receiveLibrary
            );
        }
    }

    function _updateLayerZeroRemoteRouterConfig(
        RemoteRouterConfigUpdate calldata update_
    ) internal {
        RemoteLayerZeroConfig memory remote = _mustHaveRemoteConfig(
            update_.domain
        );
        if (
            update_.router == bytes32(0) ||
            uint256(update_.router) > type(uint160).max
        ) {
            revert NonCanonicalLayerZeroPeer(update_.router);
        }
        _validateReceiveLibraryTimeout(
            update_.receiveLibraryTimeout,
            update_.receiveLibraryTimeoutExpiry
        );

        bytes32 currentRouter = routers(update_.domain);
        if (currentRouter != update_.router) {
            super._enrollRemoteRouter(update_.domain, update_.router);
            emit LayerZeroRemoteRouterEnrolled(
                update_.domain,
                remote.eid,
                update_.router
            );
        }

        address sendLibrary = endpoint.getSendLibrary(
            address(this),
            remote.eid
        );
        (address receiveLibrary, ) = endpoint.getReceiveLibrary(
            address(this),
            remote.eid
        );
        _setEnrollmentLayerZeroConfig(
            remote.eid,
            sendLibrary,
            update_.sendConfig
        );
        _setEnrollmentLayerZeroConfig(
            remote.eid,
            receiveLibrary,
            update_.receiveConfig
        );
        if (update_.receiveLibraryTimeout != address(0)) {
            _setReceiveLibraryTimeout(
                remote.eid,
                update_.receiveLibraryTimeout,
                update_.receiveLibraryTimeoutExpiry
            );
        } else {
            _clearReceiveLibraryTimeout(remote.eid, receiveLibrary);
        }
    }

    function _unenrollRemoteRouter(uint32 domain) internal override {
        RemoteLayerZeroConfig memory remote = remoteConfigs[domain];
        if (remote.eid == 0) revert UnknownLayerZeroRoute(domain);
        bytes32 router = _mustHaveRemoteRouter(domain);
        delete remoteConfigs[domain];
        delete domainsByEid[remote.eid];
        _AbstractLayerZeroV2HookIsm_onRemoteRouterUnenrolled(domain);
        super._unenrollRemoteRouter(domain);
        emit LayerZeroRemoteRouterUnenrolled(domain, remote.eid, router);
    }

    // ============ LayerZero Endpoint Configuration ============

    function _validateConfigurationTarget(
        uint32 eid,
        address libraryAddress
    ) internal view {
        if (domainsByEid[eid] == 0) revert InvalidLayerZeroConfigEid(eid);
        if (
            libraryAddress == address(0) ||
            !endpoint.isRegisteredLibrary(libraryAddress)
        ) {
            revert UnregisteredLayerZeroLibrary(libraryAddress);
        }
    }

    function _setSendLibrary(uint32 eid, address libraryAddress) internal {
        _validateConfigurationTarget(eid, libraryAddress);
        endpoint.setSendLibrary(address(this), eid, libraryAddress);
        emit LayerZeroSendLibrarySet(eid, libraryAddress);
    }

    function _setReceiveLibrary(
        uint32 eid,
        address libraryAddress,
        uint256 gracePeriod
    ) internal {
        _validateConfigurationTarget(eid, libraryAddress);
        endpoint.setReceiveLibrary(
            address(this),
            eid,
            libraryAddress,
            gracePeriod
        );
        emit LayerZeroReceiveLibrarySet(eid, libraryAddress, gracePeriod);
    }

    function _setReceiveLibraryTimeout(
        uint32 eid,
        address libraryAddress,
        uint256 expiry
    ) internal {
        _validateConfigurationTarget(eid, libraryAddress);
        endpoint.setReceiveLibraryTimeout(
            address(this),
            eid,
            libraryAddress,
            expiry
        );
        emit LayerZeroReceiveLibraryTimeoutSet(eid, libraryAddress, expiry);
    }

    function _clearReceiveLibraryTimeout(
        uint32 eid,
        address receiveLibrary
    ) internal {
        (, uint256 expiry) = endpoint.receiveLibraryTimeout(address(this), eid);
        if (expiry != 0) {
            _setReceiveLibraryTimeout(eid, receiveLibrary, 0);
        }
    }

    function _validateReceiveLibraryTimeout(
        address libraryAddress,
        uint256 expiry
    ) internal pure {
        if ((libraryAddress == address(0)) != (expiry == 0)) {
            revert InvalidLayerZeroReceiveLibraryTimeout();
        }
    }

    function _setLayerZeroConfig(
        address libraryAddress,
        LayerZeroSetConfigParam[] calldata params
    ) internal {
        if (!endpoint.isRegisteredLibrary(libraryAddress)) {
            revert UnregisteredLayerZeroLibrary(libraryAddress);
        }
        for (uint256 i = 0; i < params.length; ++i) {
            if (domainsByEid[params[i].eid] == 0) {
                revert InvalidLayerZeroConfigEid(params[i].eid);
            }
        }
        endpoint.setConfig(address(this), libraryAddress, params);
        emit LayerZeroConfigSet(libraryAddress);
    }

    function _setEnrollmentLayerZeroConfig(
        uint32 eid,
        address libraryAddress,
        LayerZeroSetConfigParam[] calldata params
    ) internal {
        if (params.length == 0) return;
        for (uint256 i = 0; i < params.length; ++i) {
            if (params[i].eid != eid) {
                revert InvalidLayerZeroConfigEid(params[i].eid);
            }
        }
        _setLayerZeroConfig(libraryAddress, params);
    }

    // ============ Route Validation and Lookup ============

    function _validateLayerZeroRemoteRouter(uint32 domain) internal view {
        RemoteLayerZeroConfig memory remote = remoteConfigs[domain];
        _validateRouteConfiguration(domain, remote.eid);
    }

    function _validateRouteConfiguration(
        uint32 domain,
        uint32 eid
    ) internal view {
        if (eid == 0 || routers(domain) == bytes32(0)) {
            revert IncompleteLayerZeroRoute(domain);
        }
        if (endpoint.isDefaultSendLibrary(address(this), eid)) {
            revert DefaultLayerZeroLibrary(eid);
        }
        (, bool isDefaultReceive) = endpoint.getReceiveLibrary(
            address(this),
            eid
        );
        if (isDefaultReceive) revert DefaultLayerZeroLibrary(eid);
        if (!_AbstractLayerZeroV2HookIsm_isVariantRouteConfigured(domain)) {
            revert IncompleteLayerZeroRoute(domain);
        }
    }

    function _originDomain(
        uint32 srcEid,
        bytes32 sender
    ) internal view returns (uint32 domain) {
        uint64 encoded = domainsByEid[srcEid];
        if (encoded == 0) revert InvalidRemoteEid(srcEid);
        domain = uint32(encoded - 1);
        if (_mustHaveRemoteRouter(domain) != sender) {
            revert NonCanonicalLayerZeroPeer(sender);
        }
    }

    function _mustHaveRemoteConfig(
        uint32 domain
    ) internal view returns (RemoteLayerZeroConfig memory remote) {
        remote = remoteConfigs[domain];
        if (remote.eid == 0) revert UnknownLayerZeroRoute(domain);
    }

    // ============ Hyperlane Message Recipient ============

    function _handle(uint32, bytes32, bytes calldata) internal pure override {
        revert HyperlaneHandleUnsupported();
    }

    // ============ Variant Overrides ============

    function _AbstractLayerZeroV2HookIsm_options(
        uint32 destination
    ) internal view virtual returns (bytes memory);

    function _AbstractLayerZeroV2HookIsm_onRemoteRouterUnenrolled(
        uint32 domain
    ) internal virtual;

    function _AbstractLayerZeroV2HookIsm_isVariantRouteConfigured(
        uint32 domain
    ) internal view virtual returns (bool);
}
