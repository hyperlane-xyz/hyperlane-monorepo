// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

import {OptionsBuilder} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import {Origin as LayerZeroOrigin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {AddressCast} from "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/AddressCast.sol";
import {GUID} from "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/GUID.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {LayerZeroMessage} from "../../libs/LayerZeroMessage.sol";
import {Message} from "../../libs/Message.sol";
import {AbstractLayerZeroV2HookIsm} from "./AbstractLayerZeroV2HookIsm.sol";

// LayerZero callback gas is only defined for explicitly enrolled routes.
// solhint-disable-next-line hyperlane/enumerable-domain-mapping
contract LayerZeroV2CallbackHookIsm is
    AbstractLayerZeroV2HookIsm,
    IInterchainSecurityModule
{
    using AddressCast for bytes32;
    using Message for bytes;
    using OptionsBuilder for bytes;

    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NULL);

    // ============ Types ============

    struct Authorization {
        uint32 originDomain;
        bool authorized;
    }

    // ============ Storage ============

    mapping(bytes32 messageId => Authorization authorization)
        public authorizations;
    mapping(uint32 domain => uint128 gasLimit) public callbackGasLimits;

    // ============ Events ============

    event LayerZeroCallbackGasLimitSet(uint32 indexed domain, uint128 gasLimit);
    event LayerZeroAuthorizationReceived(
        bytes32 indexed messageId,
        uint32 indexed originDomain,
        uint32 indexed srcEid,
        bytes32 guid,
        uint64 nonce
    );

    // ============ Errors ============

    error InvalidLayerZeroCallbackGasLimit();
    error UnauthorizedLayerZeroEndpoint(address caller);
    error UnexpectedLayerZeroCallbackValue(uint256 value);
    error WrongLayerZeroPayloadOrigin(uint32 actual, uint32 expected);
    error WrongLayerZeroPayloadDestination(uint32 actual, uint32 expected);
    error WrongLayerZeroGuid(bytes32 actual, bytes32 expected);
    error ConflictingLayerZeroAuthorization(bytes32 messageId);
    error UnexpectedHyperlaneMetadata();
    error LayerZeroConfigLengthMismatch();

    // ============ Constructor ============

    constructor(
        address mailbox_,
        address endpoint_
    ) AbstractLayerZeroV2HookIsm(mailbox_, endpoint_) {}

    // ============ Route Configuration ============

    function enrollLayerZeroRemoteRouter(
        RemoteRouterEnrollment calldata enrollment,
        uint128 callbackGasLimit
    ) external onlyOwner {
        _enrollAndValidateLayerZeroRemoteRouter(enrollment, callbackGasLimit);
    }

    function enrollLayerZeroRemoteRouters(
        RemoteRouterEnrollment[] calldata enrollments,
        uint128[] calldata callbackGasLimits_
    ) external onlyOwner {
        if (enrollments.length != callbackGasLimits_.length) {
            revert LayerZeroEnrollmentLengthMismatch();
        }
        for (uint256 i = 0; i < enrollments.length; ++i) {
            _enrollAndValidateLayerZeroRemoteRouter(
                enrollments[i],
                callbackGasLimits_[i]
            );
        }
    }

    function updateLayerZeroRemoteRouterConfig(
        RemoteRouterConfigUpdate calldata update_,
        uint128 callbackGasLimit
    ) external onlyOwner {
        _updateAndValidateLayerZeroRemoteRouterConfig(
            update_,
            callbackGasLimit
        );
    }

    /// @notice Atomically updates multiple routes whose selected libraries are
    /// unchanged, including each route's callback gas limit.
    /// @dev The arrays are positional; any failed update or validation reverts
    /// the entire batch.
    function updateLayerZeroRemoteRouterConfigs(
        RemoteRouterConfigUpdate[] calldata updates,
        uint128[] calldata callbackGasLimits_
    ) external onlyOwner {
        if (updates.length != callbackGasLimits_.length) {
            revert LayerZeroConfigLengthMismatch();
        }
        for (uint256 i = 0; i < updates.length; ++i) {
            _updateAndValidateLayerZeroRemoteRouterConfig(
                updates[i],
                callbackGasLimits_[i]
            );
        }
    }

    function _enrollAndValidateLayerZeroRemoteRouter(
        RemoteRouterEnrollment calldata enrollment,
        uint128 callbackGasLimit
    ) internal {
        _enrollLayerZeroRemoteRouter(enrollment);
        _setCallbackGasLimit(enrollment.domain, callbackGasLimit);
        _validateLayerZeroRemoteRouter(enrollment.domain);
    }

    function _updateAndValidateLayerZeroRemoteRouterConfig(
        RemoteRouterConfigUpdate calldata update_,
        uint128 callbackGasLimit
    ) internal {
        _updateLayerZeroRemoteRouterConfig(update_);
        _setCallbackGasLimit(update_.domain, callbackGasLimit);
        _validateLayerZeroRemoteRouter(update_.domain);
    }

    function _setCallbackGasLimit(uint32 domain, uint128 gasLimit) internal {
        if (remoteConfigs[domain].eid == 0) {
            revert UnknownLayerZeroRoute(domain);
        }
        if (gasLimit == 0) revert InvalidLayerZeroCallbackGasLimit();
        callbackGasLimits[domain] = gasLimit;
        emit LayerZeroCallbackGasLimitSet(domain, gasLimit);
    }

    // ============ LayerZero Receiver Interface ============

    /// @notice Receives a packet that Endpoint V2 has already authenticated
    /// and cleared, then records its Hyperlane message authorization.
    /// @dev This is the callback variant's required ILayerZeroReceiver entry
    /// point. The Endpoint caller, enrolled EID/peer, payload, and GUID are all
    /// checked here because Executor-supplied delivery data is untrusted.
    function lzReceive(
        LayerZeroOrigin calldata origin,
        bytes32 guid,
        bytes calldata payload,
        address,
        bytes calldata
    ) external payable override {
        if (msg.sender != address(endpoint)) {
            revert UnauthorizedLayerZeroEndpoint(msg.sender);
        }
        if (msg.value != 0) revert UnexpectedLayerZeroCallbackValue(msg.value);

        uint32 originDomain = _originDomain(origin.srcEid, origin.sender);
        (
            uint32 payloadOrigin,
            uint32 payloadDestination,
            bytes32 messageId
        ) = LayerZeroMessage.decode(payload);
        if (payloadOrigin != originDomain) {
            revert WrongLayerZeroPayloadOrigin(payloadOrigin, originDomain);
        }
        if (payloadDestination != localDomain) {
            revert WrongLayerZeroPayloadDestination(
                payloadDestination,
                localDomain
            );
        }

        _validateGuid(origin, guid);
        _recordAuthorization(messageId, originDomain);
        emit LayerZeroAuthorizationReceived(
            messageId,
            originDomain,
            origin.srcEid,
            guid,
            origin.nonce
        );
    }

    function _recordAuthorization(
        bytes32 messageId,
        uint32 originDomain
    ) internal {
        Authorization memory current = authorizations[messageId];
        if (current.authorized) {
            if (current.originDomain != originDomain) {
                revert ConflictingLayerZeroAuthorization(messageId);
            }
            return;
        }
        authorizations[messageId] = Authorization({
            originDomain: originDomain,
            authorized: true
        });
    }

    function _validateGuid(
        LayerZeroOrigin calldata origin,
        bytes32 guid
    ) internal view {
        bytes32 expectedGuid = GUID.generate(
            origin.nonce,
            origin.srcEid,
            origin.sender.toAddress(),
            localEid,
            bytes32(uint256(uint160(address(this))))
        );
        if (guid != expectedGuid) revert WrongLayerZeroGuid(guid, expectedGuid);
    }

    // ============ Hyperlane ISM Interface ============

    function verify(
        bytes calldata metadata,
        bytes calldata message
    ) external view override returns (bool) {
        if (metadata.length != 0) revert UnexpectedHyperlaneMetadata();
        if (message.destination() != localDomain) return false;
        Authorization memory authorization = authorizations[message.id()];
        return
            authorization.authorized &&
            authorization.originDomain == message.origin();
    }

    // ============ Variant Overrides ============

    function _AbstractLayerZeroV2HookIsm_options(
        uint32 destination
    ) internal view override returns (bytes memory) {
        uint128 gasLimit = callbackGasLimits[destination];
        if (gasLimit == 0) revert InvalidLayerZeroCallbackGasLimit();
        return
            OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimit, 0);
    }

    function _AbstractLayerZeroV2HookIsm_onRemoteRouterUnenrolled(
        uint32 domain
    ) internal override {
        delete callbackGasLimits[domain];
    }

    function _AbstractLayerZeroV2HookIsm_isVariantRouteConfigured(
        uint32 domain
    ) internal view override returns (bool) {
        return callbackGasLimits[domain] != 0;
    }
}
