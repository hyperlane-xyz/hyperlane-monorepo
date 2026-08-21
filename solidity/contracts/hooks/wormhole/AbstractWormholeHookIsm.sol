// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.19;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

// ============ Internal Imports ============
import {Router} from "../../client/Router.sol";
import {AbstractPostDispatchHook} from "../libs/AbstractPostDispatchHook.sol";
import {StandardHookMetadata} from "../libs/StandardHookMetadata.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {CoreBridgeVM, ICoreBridge} from "../../interfaces/wormhole/ICoreBridge.sol";
import {ICustomConsistencyLevel} from "../../interfaces/wormhole/ICustomConsistencyLevel.sol";
import {IWormholeHookIsm, RemoteRouterEnrollment} from "../../interfaces/wormhole/IWormholeHookIsm.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {WormholeMessage} from "../../libs/WormholeMessage.sol";
import {CustomConsistencyLevelLib, WormholeConsistencyLevelConfig} from "./libs/CustomConsistencyLevel.sol";

/**
 * @title AbstractWormholeHookIsm
 * @notice Combined Hyperlane hook and ISM that publishes dispatched message IDs
 * through Wormhole Core and authenticates Guardian-signed VAAs from enrolled
 * remote routers.
 * @dev One deployment per chain serves every enrolled remote domain. The same
 * local address is configured as an application's outbound hook and inbound
 * ISM.
 *
 * **Subclass contract**: `postDispatch`, `quoteDispatch`, and `verify` are
 * owned here and enforce the shared invariants (latest-dispatch binding,
 * one-shot publication, exact routing, payload, nonce, and VAA checks).
 * Subclasses extend only through:
 * - `_AbstractWormholeHookIsm_quoteExtraFees` / `_AbstractWormholeHookIsm_payExtraFees`
 *   — an additional fee/payment pair beyond Core's `messageFee()`
 * - `_AbstractWormholeHookIsm_verify` — the variant's verification mechanism
 * - `_AbstractWormholeHookIsm_onRemoteRouterUnenrolled` — variant config cleanup
 */
// `Router` already provides enumerable remote-domain storage.
// solhint-disable-next-line hyperlane/enumerable-domain-mapping
abstract contract AbstractWormholeHookIsm is
    Router,
    AbstractPostDispatchHook,
    IWormholeHookIsm
{
    using Message for bytes;
    using StandardHookMetadata for bytes;
    using TypeCasts for address;
    using TypeCasts for bytes32;

    // ============ Types ============

    /// @notice Wormhole authentication policy for one enrolled remote router.
    struct RemoteRouterConfig {
        uint16 wormholeChainId;
        uint8 expectedConsistencyLevel;
    }

    /// @dev Memory-only result shared by `quoteDispatch` and `postDispatch` so
    /// the quote can never drift from what the dispatch pays.
    struct DispatchFeeQuote {
        uint256 coreFee;
        uint256 extraFees;
        uint64 sequence;
        address refundAddress;
    }

    // ============ Immutables ============

    /// @notice Local Wormhole Core deployment.
    ICoreBridge public immutable wormhole;

    /// @notice Wormhole chain ID of this chain, read from Core.
    uint16 public immutable wormholeChainId;

    /// @notice Finality requested from Guardians for local publications.
    uint8 public immutable consistencyLevel;

    /// @notice Wormhole CCL contract used when `consistencyLevel == 203`.
    /// @dev Zero for standard finality levels.
    ICustomConsistencyLevel public immutable customConsistencyLevel;

    /// @notice Standard EVM level from which custom finality starts.
    /// @dev Zero for standard finality levels.
    uint8 public immutable baseConsistencyLevel;

    /// @notice Blocks waited after the custom base level is reached.
    /// @dev Zero for standard finality levels.
    uint16 public immutable additionalBlocks;

    // ============ Storage ============

    /// @notice Wormhole policy for each enrolled Hyperlane domain.
    /// @dev `Router._routers` remains the source of truth for router addresses.
    mapping(uint32 domain => RemoteRouterConfig config)
        public remoteRouterConfigs;

    /// @notice Reverse index rejecting one Wormhole chain ID claimed by two
    /// Hyperlane domains.
    /// @dev Stores `uint64(domain) + 1`, reserving zero as the absence
    /// sentinel without relying on assumptions about assigned domain values.
    mapping(uint16 wormholeChainId => uint64 domainPlusOne)
        public hyperlaneDomainPlusOne;

    /// @notice One-shot guard against republishing a Hyperlane message.
    mapping(bytes32 messageId => bool published) public publishedMessages;

    // ============ Constructor ============

    constructor(
        address mailbox_,
        address wormhole_,
        WormholeConsistencyLevelConfig memory consistencyLevelConfig_
    ) Router(mailbox_) {
        if (!Address.isContract(wormhole_)) revert InvalidWormholeCore();
        wormhole = ICoreBridge(wormhole_);
        if (wormhole.evmChainId() != block.chainid) {
            revert InvalidWormholeEvmChainId();
        }
        wormholeChainId = wormhole.chainId();
        if (wormholeChainId == 0) revert InvalidWormholeChainId();
        consistencyLevel = consistencyLevelConfig_.consistencyLevel;

        if (
            consistencyLevelConfig_.consistencyLevel ==
            CustomConsistencyLevelLib.CUSTOM
        ) {
            if (
                !Address.isContract(
                    consistencyLevelConfig_.customConsistencyLevel
                )
            ) {
                revert InvalidCustomConsistencyLevel();
            }

            if (
                !CustomConsistencyLevelLib.isStandardEvmLevel(
                    consistencyLevelConfig_.baseConsistencyLevel
                )
            ) {
                revert InvalidCustomConsistencyLevelConfig();
            }

            ICustomConsistencyLevel ccl = ICustomConsistencyLevel(
                consistencyLevelConfig_.customConsistencyLevel
            );
            bytes32 encoded = CustomConsistencyLevelLib.encodeAdditionalBlocks(
                consistencyLevelConfig_.baseConsistencyLevel,
                consistencyLevelConfig_.additionalBlocks
            );
            ccl.configure(encoded);
            if (ccl.getConfiguration(address(this)) != encoded) {
                revert InvalidCustomConsistencyLevelConfig();
            }

            customConsistencyLevel = ccl;
            baseConsistencyLevel = consistencyLevelConfig_.baseConsistencyLevel;
            additionalBlocks = consistencyLevelConfig_.additionalBlocks;
        } else {
            if (
                !CustomConsistencyLevelLib.isStandardEvmLevel(
                    consistencyLevelConfig_.consistencyLevel
                )
            ) {
                revert InvalidCustomConsistencyLevelConfig();
            }
            if (
                consistencyLevelConfig_.customConsistencyLevel != address(0) ||
                consistencyLevelConfig_.baseConsistencyLevel != 0 ||
                consistencyLevelConfig_.additionalBlocks != 0
            ) revert UnexpectedCustomConsistencyLevelConfig();
            customConsistencyLevel = ICustomConsistencyLevel(address(0));
            baseConsistencyLevel = 0;
            additionalBlocks = 0;
        }
    }

    // ============ IPostDispatchHook ============

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.WORMHOLE);
    }

    /// @inheritdoc AbstractPostDispatchHook
    /// @dev Fees are native-only and destination `msg.value` is unsupported in
    /// v1, so Executor relay instructions always encode zero destination value.
    // solhint-disable-next-line hyperlane/no-virtual-override
    function supportsMetadata(
        bytes calldata metadata
    ) public view virtual override returns (bool) {
        return
            metadata.feeToken(address(0)) == address(0) &&
            metadata.msgValue(0) == 0 &&
            super.supportsMetadata(metadata);
    }

    // ============ IInterchainSecurityModule ============

    /**
     * @notice Verifies that `message` was authenticated by this router.
     * @dev Stable wrapper; the variant supplies the mechanism through
     * `_AbstractWormholeHookIsm_verify`. `virtual` only so a variant that also
     * inherits `IInterchainSecurityModule` through another base can resolve the
     * duplicate declaration; the body must stay this delegation.
     */
    function verify(
        bytes calldata metadata,
        bytes calldata message
    ) external virtual returns (bool) {
        return _AbstractWormholeHookIsm_verify(metadata, message);
    }

    // ============ Enrollment ============

    /**
     * @dev Complete enrollment primitive. Concrete variants expose the external
     * entrypoints so a variant-specific delivery configuration can be installed
     * in the same transaction.
     */
    function _enrollWormholeRemoteRouter(
        RemoteRouterEnrollment calldata enrollment
    ) internal {
        uint32 domain = enrollment.domain;
        bytes32 router = enrollment.router;

        if (domain == localDomain) revert InvalidRemoteDomain();
        // TypeCasts rejects non-canonical bytes32 values that do not fit address.
        if (router.bytes32ToAddress() == address(0)) {
            revert InvalidRemoteRouter();
        }
        if (enrollment.wormholeChainId == 0) revert InvalidWormholeChainId();
        if (enrollment.wormholeChainId == wormholeChainId) {
            revert InvalidRemoteWormholeChainId();
        }

        uint64 reverse = hyperlaneDomainPlusOne[enrollment.wormholeChainId];
        if (reverse != 0 && uint32(reverse - 1) != domain) {
            revert WormholeChainIdAlreadyEnrolled();
        }

        RemoteRouterConfig memory old = remoteRouterConfigs[domain];
        if (
            routers(domain) != bytes32(0) &&
            old.wormholeChainId != enrollment.wormholeChainId
        ) {
            revert WormholeChainIdChangeRequiresUnenrollment();
        }

        Router._enrollRemoteRouter(domain, router);
        remoteRouterConfigs[domain] = RemoteRouterConfig({
            wormholeChainId: enrollment.wormholeChainId,
            expectedConsistencyLevel: enrollment.expectedConsistencyLevel
        });
        hyperlaneDomainPlusOne[enrollment.wormholeChainId] = uint64(domain) + 1;

        emit WormholeRemoteRouterEnrolled(
            domain,
            router,
            enrollment.wormholeChainId,
            enrollment.expectedConsistencyLevel
        );
    }

    /**
     * @dev Rejects the inherited two-argument enrollment so it cannot create a
     * route without Wormhole policy. `_enrollWormholeRemoteRouter` reaches the
     * base implementation through an explicit `Router._enrollRemoteRouter` call.
     */
    function _enrollRemoteRouter(uint32, bytes32) internal pure override {
        revert RichEnrollmentRequired();
    }

    /// @dev Clears Wormhole policy, the reverse index, and variant config
    /// before removing the router itself.
    function _unenrollRemoteRouter(uint32 domain) internal override {
        _mustHaveRemoteRouter(domain);
        RemoteRouterConfig memory config = remoteRouterConfigs[domain];
        delete hyperlaneDomainPlusOne[config.wormholeChainId];
        delete remoteRouterConfigs[domain];
        _AbstractWormholeHookIsm_onRemoteRouterUnenrolled(domain);
        Router._unenrollRemoteRouter(domain);
    }

    function _mustHaveRemoteRouterConfig(
        uint32 domain
    ) internal view returns (RemoteRouterConfig memory config) {
        _mustHaveRemoteRouter(domain);
        config = remoteRouterConfigs[domain];
        // Defensive invariant: complete enrollment always sets a nonzero ID.
        if (config.wormholeChainId == 0) revert IncompleteRemoteRouterConfig();
    }

    // ============ Quote and publication ============

    /// @dev Non-virtual so a subclass cannot bypass Core fee, route, sequence,
    /// or refund resolution. Subclasses contribute only incremental fees.
    function _quoteDispatchFees(
        bytes calldata metadata,
        bytes calldata message
    ) internal view returns (DispatchFeeQuote memory quote) {
        _mustHaveRemoteRouterConfig(message.destination());
        quote.coreFee = wormhole.messageFee();
        quote.sequence = wormhole.nextSequence(address(this));
        quote.refundAddress = metadata.refundAddress(message.senderAddress());
        quote.extraFees = _AbstractWormholeHookIsm_quoteExtraFees(
            metadata,
            message,
            quote.sequence,
            quote.refundAddress
        );
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view override returns (uint256) {
        DispatchFeeQuote memory quote = _quoteDispatchFees(metadata, message);
        return quote.coreFee + quote.extraFees;
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        bytes32 messageId = message.id();
        if (!_isLatestDispatched(messageId)) revert MessageNotDispatched();
        if (publishedMessages[messageId]) revert MessageAlreadyPublished();

        // Effect before all external calls. Every later failure reverts this write.
        publishedMessages[messageId] = true;

        DispatchFeeQuote memory quote = _quoteDispatchFees(metadata, message);
        uint256 required = quote.coreFee + quote.extraFees;
        if (msg.value < required) revert InsufficientFee(required, msg.value);

        uint64 publishedSequence = _publish(message, messageId, quote.coreFee);
        if (publishedSequence != quote.sequence) {
            revert UnexpectedPublishedSequence(
                quote.sequence,
                publishedSequence
            );
        }

        _AbstractWormholeHookIsm_payExtraFees(
            metadata,
            message,
            publishedSequence,
            quote.refundAddress,
            quote.extraFees
        );

        emit WormholeMessagePublished(
            messageId,
            message.destination(),
            publishedSequence,
            message.nonce()
        );

        // Refund only this call's excess; forced balance is never swept.
        _refund(metadata, message, msg.value - required);
    }

    /// @dev Leaf helper keeping `_postDispatch` within stack limits.
    function _publish(
        bytes calldata message,
        bytes32 messageId,
        uint256 coreFee
    ) private returns (uint64 publishedSequence) {
        uint32 destination = message.destination();
        publishedSequence = wormhole.publishMessage{value: coreFee}(
            message.nonce(),
            WormholeMessage.encode(
                localDomain,
                destination,
                _mustHaveRemoteRouter(destination),
                messageId,
                message.nonce()
            ),
            consistencyLevel
        );
    }

    // ============ VAA validation ============

    /**
     * @dev Verifies Guardian signatures through Core, then binds the payload to
     * this router and the enrolled origin router.
     */
    function _decodeAndValidateVaa(
        bytes memory encodedVaa
    )
        internal
        view
        returns (CoreBridgeVM memory vm_, WormholeMessage.Message memory wm)
    {
        bool valid;
        string memory reason;
        (vm_, valid, reason) = wormhole.parseAndVerifyVM(encodedVaa);
        if (!valid) revert InvalidVaa(reason);

        wm = WormholeMessage.decode(vm_.payload);
        if (wm.destinationDomain != localDomain) {
            revert WrongDestinationDomain();
        }
        if (wm.destinationRouter != address(this).addressToBytes32()) {
            revert WrongDestinationRouter();
        }
        if (vm_.nonce != wm.nonce) revert WormholeNonceMismatch();

        uint8 expectedConsistency = _authenticateRemoteRouter(
            wm.originDomain,
            vm_.emitterChainId,
            vm_.emitterAddress
        );
        if (vm_.consistencyLevel != expectedConsistency) {
            revert WrongConsistencyLevel();
        }
    }

    /**
     * @dev Binds a claimed Hyperlane origin to exactly one Wormhole chain ID
     * and one enrolled router address. Never derives the Hyperlane origin from
     * the Wormhole chain ID alone, and never accepts an arbitrary emitter on an
     * enrolled chain.
     */
    function _authenticateRemoteRouter(
        uint32 originDomain,
        uint16 emitterChainId,
        bytes32 emitterAddress
    ) internal view returns (uint8 expectedConsistencyLevel) {
        RemoteRouterConfig memory config = _mustHaveRemoteRouterConfig(
            originDomain
        );
        if (emitterChainId != config.wormholeChainId) {
            revert WrongEmitterChainId();
        }
        if (emitterAddress != routers(originDomain)) {
            revert WrongEmitterAddress();
        }
        expectedConsistencyLevel = config.expectedConsistencyLevel;
    }

    // ============ Router ============

    /// @dev Wormhole delivers through the variant's own path, never Hyperlane
    /// `handle`. `Router` is reused for enrollment and discovery only.
    function _handle(uint32, bytes32, bytes calldata) internal pure override {
        revert HyperlaneHandleUnsupported();
    }

    // ============ Extension points ============

    /// @dev Incremental fee beyond Core's `messageFee()`. Default: none.
    function _AbstractWormholeHookIsm_quoteExtraFees(
        bytes calldata,
        /*metadata*/
        bytes calldata,
        /*message*/
        uint64,
        /*sequence*/
        address /*refundAddress*/
    ) internal view virtual returns (uint256) {
        return 0;
    }

    /// @dev Pays the fee quoted above. The zero-only default makes it
    /// impossible to quote a nonzero extra fee without also implementing its
    /// payment.
    function _AbstractWormholeHookIsm_payExtraFees(
        bytes calldata,
        /*metadata*/
        bytes calldata,
        /*message*/
        uint64,
        /*sequence*/
        address,
        /*refundAddress*/
        uint256 extraFees
    ) internal virtual {
        if (extraFees != 0) revert ExtraFeesNotHandled();
    }

    /// @dev The variant's verification mechanism.
    function _AbstractWormholeHookIsm_verify(
        bytes calldata metadata,
        bytes calldata message
    ) internal view virtual returns (bool);

    /// @dev Variant-specific configuration cleanup on unenrollment.
    function _AbstractWormholeHookIsm_onRemoteRouterUnenrolled(
        uint32 /*domain*/
    ) internal virtual {}
}
