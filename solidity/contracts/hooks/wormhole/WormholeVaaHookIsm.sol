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
import {CoreBridgeVM, ICoreBridge} from "wormhole-sdk/interfaces/ICoreBridge.sol";
import {ICustomConsistencyLevel} from "wormhole-sdk/interfaces/ICustomConsistencyLevel.sol";
import {CustomConsistencyLib} from "wormhole-sdk/libraries/CustomConsistency.sol";

// ============ Internal Imports ============
import {Router} from "../../client/Router.sol";
import {AbstractCcipReadIsm} from "../../isms/ccip-read/AbstractCcipReadIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {IEvmCoreBridge} from "../../interfaces/wormhole/IEvmCoreBridge.sol";
import {IWormholeVaaService} from "../../interfaces/wormhole/IWormholeVaaService.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {WormholeMessage} from "../../libs/WormholeMessage.sol";
import {AbstractPostDispatchHook} from "../libs/AbstractPostDispatchHook.sol";
import {StandardHookMetadata} from "../libs/StandardHookMetadata.sol";
import {CustomConsistencyLevelLib, WormholeConsistencyLevelConfig} from "./libs/CustomConsistencyLevel.sol";

/**
 * @title WormholeVaaHookIsm
 * @notice Combined Hyperlane hook and ISM that authenticates messages through
 * Wormhole Guardian-signed VAAs supplied using Hyperlane's CCIP-read flow.
 * @dev The origin hook publishes a Wormhole message committing to the
 * Hyperlane message ID, origin and destination domains, destination hook/ISM,
 * and nonce. On the destination, `verify` authenticates the resulting VAA and
 * compares that commitment with the Hyperlane message being processed.
 */
// `Router` already provides enumerable remote-domain storage.
// solhint-disable-next-line hyperlane/enumerable-domain-mapping
contract WormholeVaaHookIsm is
    Router,
    AbstractPostDispatchHook,
    AbstractCcipReadIsm
{
    using Message for bytes;
    using StandardHookMetadata for bytes;
    using TypeCasts for address;
    using TypeCasts for bytes32;

    // ============ Errors ============

    error InvalidMetadata();
    error InvalidRemoteDomain();
    error InvalidDomainIsm();
    error InvalidWormholeChainId();
    error InvalidRemoteWormholeChainId();
    error WormholeChainIdAlreadyEnrolled();
    error WormholeChainIdChangeRequiresUnenrollment();
    error CompleteWormholeEnrollmentRequired();
    error InvalidWormholeCore();
    error InvalidWormholeEvmChainId();
    error InvalidConsistencyLevelConfig();
    error InvalidCustomConsistencyLevelContract();
    error InvalidCustomConsistencyLevelConfig();
    error UnexpectedCustomConsistencyLevelConfig();
    error MessageNotDispatched();
    error MessageAlreadyPublished();
    error InsufficientFee(uint256 required, uint256 provided);
    error InvalidVaa(string reason);
    error WrongOriginDomain();
    error WrongDestinationDomain();
    error WrongDestinationRouter();
    error WrongConsistencyLevel();
    error WrongEmitterChainId();
    error WrongEmitterAddress();
    error WrongMessageId();
    error WormholeNonceMismatch();
    error HyperlaneNonceMismatch();
    error HyperlaneHandleUnsupported();

    // ============ Events ============

    /// @notice Emitted for every remote hook/ISM enrollment or replacement.
    event WormholeRemoteRouterEnrolled(
        uint32 indexed domainId,
        bytes32 indexed domainIsm,
        uint16 wormholeChainId,
        uint8 expectedConsistencyLevel
    );

    /// @notice Emitted after a remote hook/ISM, Wormhole chain ID, and expected
    /// VAA consistency level are removed.
    event WormholeRemoteRouterUnenrolled(
        uint32 indexed domainId,
        bytes32 indexed domainIsm,
        uint16 wormholeChainId
    );

    /// @notice Correlates a Hyperlane message with the Wormhole Core message
    /// containing its commitment.
    event WormholeMessagePublished(
        bytes32 indexed messageId,
        uint32 indexed destinationDomain,
        uint64 sequence,
        uint32 nonce
    );

    // ============ Types ============

    /// @notice Complete remote hook/ISM enrollment input.
    /// @dev The hook/ISM address, Wormhole chain ID, and expected consistency
    /// level are installed atomically.
    struct RemoteRouterEnrollment {
        /// @notice Hyperlane domain of the remote hook/ISM.
        uint32 domainId;
        /// @notice Remote hook/ISM address encoded as `bytes32`.
        bytes32 domainIsm;
        /// @notice Wormhole chain containing the remote hook/ISM.
        uint16 wormholeChainId;
        /// @notice Consistency level required in VAAs from the remote hook/ISM.
        uint8 expectedConsistencyLevel;
    }

    /// @notice Wormhole authentication settings for one Hyperlane domain ID.
    /// @dev The corresponding emitter address is stored by `Router.routers`.
    struct RemoteRouterConfig {
        /// @notice Wormhole chain from which the remote VAA must originate.
        uint16 wormholeChainId;
        /// @notice Consistency level required in VAAs from the remote hook/ISM.
        uint8 expectedConsistencyLevel;
    }

    /// @notice Reverse lookup from a Wormhole chain to its Hyperlane domain ID.
    /// @dev The explicit flag allows Hyperlane domain ID zero without sentinel
    /// arithmetic.
    struct WormholeChainEnrollment {
        /// @notice Whether this Wormhole chain ID is assigned to a domain.
        bool enrolled;
        /// @notice Hyperlane domain assigned to this Wormhole chain ID.
        uint32 hyperlaneDomainId;
    }

    // ============ Immutables ============

    /// @notice Wormhole Core contract deployed on this chain.
    ICoreBridge public immutable wormholeCoreBridge;

    /// @notice Wormhole chain ID of this chain, read from Core.
    uint16 public immutable wormholeChainId;

    /// @notice Consistency level used when publishing Hyperlane message
    /// commitments through the local Wormhole Core contract.
    uint8 public immutable consistencyLevel;

    /// @notice Wormhole CCL contract used when `consistencyLevel == 203`.
    /// @dev `address(0)` for non-custom consistency levels.
    ICustomConsistencyLevel public immutable customConsistencyLevelContract;

    /// @notice Guardian consistency sentinel underlying the custom level.
    /// @dev `0` for non-custom consistency levels.
    uint8 public immutable baseConsistencyLevel;

    /// @notice Number of blocks Guardians wait after the custom base level.
    /// @dev `0` for non-custom consistency levels.
    uint16 public immutable additionalBlocks;

    // ============ Storage ============

    /// @notice Wormhole chain ID and expected VAA consistency level for each
    /// Hyperlane domain ID.
    /// @dev Together with the emitter address in `Router.routers`, this binds a
    /// VAA to exactly one enrolled remote hook/ISM and its expected consistency level.
    mapping(uint32 domainId => RemoteRouterConfig config)
        public remoteRouterConfigs;

    /// @notice Enrollment for each Wormhole chain ID.
    mapping(uint16 wormholeChainId => WormholeChainEnrollment enrollment)
        public wormholeChainEnrollments;

    /// @notice Whether each Hyperlane message ID has been published through
    /// Wormhole Core by this contract.
    mapping(bytes32 messageId => bool published) public publishedMessages;

    // ============ Constructor ============

    constructor(
        address _mailbox,
        address _wormholeCoreBridge,
        WormholeConsistencyLevelConfig memory _consistencyLevelConfig,
        string[] memory _urls
    ) Router(_mailbox) {
        if (!Address.isContract(_wormholeCoreBridge)) {
            revert InvalidWormholeCore();
        }

        wormholeCoreBridge = ICoreBridge(_wormholeCoreBridge);
        if (IEvmCoreBridge(_wormholeCoreBridge).evmChainId() != block.chainid) {
            revert InvalidWormholeEvmChainId();
        }

        wormholeChainId = wormholeCoreBridge.chainId();
        if (wormholeChainId == 0) revert InvalidWormholeChainId();

        _validateAndConfigureConsistencyLevel(_consistencyLevelConfig);
        consistencyLevel = _consistencyLevelConfig.consistencyLevel;
        customConsistencyLevelContract = ICustomConsistencyLevel(
            _consistencyLevelConfig.customConsistencyLevelContract
        );
        baseConsistencyLevel = _consistencyLevelConfig.baseConsistencyLevel;
        additionalBlocks = _consistencyLevelConfig.additionalBlocks;

        // MailboxClient's constructor made the deployer the owner.
        setUrls(_urls);
    }

    // ============ IPostDispatchHook ============

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.WORMHOLE);
    }

    /// @inheritdoc AbstractPostDispatchHook
    /// @dev Wormhole Core fees are paid exclusively in native tokens.
    function supportsMetadata(
        bytes calldata metadata
    ) public view override returns (bool) {
        return
            metadata.feeToken(address(0)) == address(0) &&
            super.supportsMetadata(metadata);
    }

    // ============ IInterchainSecurityModule ============

    /// @inheritdoc IInterchainSecurityModule
    function verify(
        bytes calldata metadata,
        bytes calldata message
    ) external view override returns (bool) {
        bytes memory encodedVaa = _decodeCcipReadResponse(metadata);
        WormholeMessage.Message memory wormholeMessage = _verifyAndDecodeVaa(
            encodedVaa
        );

        if (wormholeMessage.originDomain != message.origin()) {
            revert WrongOriginDomain();
        }
        if (wormholeMessage.destinationDomain != message.destination()) {
            revert WrongDestinationDomain();
        }
        if (wormholeMessage.messageId != message.id()) {
            revert WrongMessageId();
        }
        if (wormholeMessage.nonce != message.nonce()) {
            revert HyperlaneNonceMismatch();
        }
        return true;
    }

    // ============ Router ============

    /// @notice Enrolls a remote hook/ISM address, Wormhole chain ID, and
    /// expected VAA consistency level.
    function enrollRemoteRouter(
        RemoteRouterEnrollment calldata newRemoteConfig
    ) external onlyOwner {
        _enrollWormholeRemoteRouter(newRemoteConfig);
    }

    /// @notice Batch version of `enrollRemoteRouter`.
    function enrollRemoteRouters(
        RemoteRouterEnrollment[] calldata newRemoteConfigs
    ) external onlyOwner {
        for (uint256 i; i < newRemoteConfigs.length; ++i) {
            _enrollWormholeRemoteRouter(newRemoteConfigs[i]);
        }
    }

    /// @dev Installs the remote hook/ISM address in `Router` together with its
    /// Wormhole chain ID and expected VAA consistency level.
    function _enrollWormholeRemoteRouter(
        RemoteRouterEnrollment calldata newRemoteConfig
    ) internal {
        uint32 domainId = newRemoteConfig.domainId;
        bytes32 domainIsm = newRemoteConfig.domainIsm;

        if (domainId == localDomain) revert InvalidRemoteDomain();
        // TypeCasts rejects non-canonical bytes32 values that do not fit address.
        if (domainIsm.bytes32ToAddress() == address(0)) {
            revert InvalidDomainIsm();
        }
        if (newRemoteConfig.wormholeChainId == 0)
            revert InvalidWormholeChainId();
        if (newRemoteConfig.wormholeChainId == wormholeChainId) {
            revert InvalidRemoteWormholeChainId();
        }

        WormholeChainEnrollment
            memory currentChainEnrollment = wormholeChainEnrollments[
                newRemoteConfig.wormholeChainId
            ];
        if (
            currentChainEnrollment.enrolled &&
            currentChainEnrollment.hyperlaneDomainId != domainId
        ) {
            revert WormholeChainIdAlreadyEnrolled();
        }

        RemoteRouterConfig memory currentRemoteConfig = remoteRouterConfigs[
            domainId
        ];
        if (
            routers(domainId) != bytes32(0) &&
            currentRemoteConfig.wormholeChainId !=
            newRemoteConfig.wormholeChainId
        ) {
            revert WormholeChainIdChangeRequiresUnenrollment();
        }

        Router._enrollRemoteRouter(domainId, domainIsm);
        remoteRouterConfigs[domainId] = RemoteRouterConfig({
            wormholeChainId: newRemoteConfig.wormholeChainId,
            expectedConsistencyLevel: newRemoteConfig.expectedConsistencyLevel
        });
        wormholeChainEnrollments[
            newRemoteConfig.wormholeChainId
        ] = WormholeChainEnrollment({
            enrolled: true,
            hyperlaneDomainId: domainId
        });

        emit WormholeRemoteRouterEnrolled(
            domainId,
            domainIsm,
            newRemoteConfig.wormholeChainId,
            newRemoteConfig.expectedConsistencyLevel
        );
    }

    /// @dev Rejects Router's address-only enrollment because it would omit the
    /// Wormhole chain ID and expected VAA consistency level.
    function _enrollRemoteRouter(uint32, bytes32) internal pure override {
        revert CompleteWormholeEnrollmentRequired();
    }

    /// @dev Deletes the Wormhole-chain reverse lookup and domain configuration
    /// before removing the remote hook/ISM from `Router`.
    function _unenrollRemoteRouter(uint32 domainId) internal override {
        bytes32 domainIsm = _mustHaveRemoteRouter(domainId);
        RemoteRouterConfig memory config = remoteRouterConfigs[domainId];

        delete wormholeChainEnrollments[config.wormholeChainId];
        delete remoteRouterConfigs[domainId];
        Router._unenrollRemoteRouter(domainId);

        emit WormholeRemoteRouterUnenrolled(
            domainId,
            domainIsm,
            config.wormholeChainId
        );
    }

    /// @dev Wormhole authenticates through `verify`; this contract never
    /// receives Hyperlane messages through `Router.handle`.
    function _handle(uint32, bytes32, bytes calldata) internal pure override {
        revert HyperlaneHandleUnsupported();
    }

    // ============ Hook ============

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata,
        bytes calldata message
    ) internal view override returns (uint256) {
        _mustHaveRemoteRouter(message.destination());
        return wormholeCoreBridge.messageFee();
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        bytes32 messageId = message.id();
        if (!_isLatestDispatched(messageId)) revert MessageNotDispatched();
        if (publishedMessages[messageId]) revert MessageAlreadyPublished();

        uint256 coreFee = _quoteDispatch(metadata, message);
        if (msg.value < coreFee) revert InsufficientFee(coreFee, msg.value);

        // Effect before the Core call; a later failure reverts this write.
        publishedMessages[messageId] = true;
        uint64 publishedSequence = _publish(message, messageId, coreFee);

        emit WormholeMessagePublished(
            messageId,
            message.destination(),
            publishedSequence,
            message.nonce()
        );

        // Refund only this call's excess; forced balance is never swept.
        _refund(metadata, message, msg.value - coreFee);
    }

    function _publish(
        bytes calldata message,
        bytes32 messageId,
        uint256 coreFee
    ) private returns (uint64) {
        uint32 destination = message.destination();
        return
            wormholeCoreBridge.publishMessage{value: coreFee}(
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
     * @dev Verifies Guardian signatures through Core, then binds the VAA to
     * this destination and an enrolled remote hook/ISM.
     */
    function _verifyAndDecodeVaa(
        bytes memory encodedVaa
    ) internal view returns (WormholeMessage.Message memory wormholeMessage) {
        CoreBridgeVM memory vaa;
        bool valid;
        string memory reason;
        (vaa, valid, reason) = wormholeCoreBridge.parseAndVerifyVM(encodedVaa);
        if (!valid) revert InvalidVaa(reason);

        wormholeMessage = WormholeMessage.decode(vaa.payload);
        if (wormholeMessage.destinationDomain != localDomain) {
            revert WrongDestinationDomain();
        }
        if (
            wormholeMessage.destinationRouter !=
            address(this).addressToBytes32()
        ) {
            revert WrongDestinationRouter();
        }
        if (vaa.nonce != wormholeMessage.nonce) {
            revert WormholeNonceMismatch();
        }

        uint8 expectedConsistencyLevel = _authenticateRemoteRouter(
            wormholeMessage.originDomain,
            vaa.emitterChainId,
            vaa.emitterAddress
        );
        if (vaa.consistencyLevel != expectedConsistencyLevel) {
            revert WrongConsistencyLevel();
        }
    }

    /**
     * @dev Authenticates all three parts of a remote route: its Hyperlane
     * domain ID, Wormhole chain ID, and emitter address.
     */
    function _authenticateRemoteRouter(
        uint32 originDomain,
        uint16 emitterChainId,
        bytes32 emitterAddress
    ) internal view returns (uint8) {
        bytes32 expectedEmitter = _mustHaveRemoteRouter(originDomain);
        RemoteRouterConfig memory config = remoteRouterConfigs[originDomain];

        if (emitterChainId != config.wormholeChainId) {
            revert WrongEmitterChainId();
        }
        if (emitterAddress != expectedEmitter) {
            revert WrongEmitterAddress();
        }
        return config.expectedConsistencyLevel;
    }

    // ============ AbstractCcipReadIsm ============

    /// @inheritdoc AbstractCcipReadIsm
    function _offchainLookupCalldata(
        bytes calldata message
    ) internal pure override returns (bytes memory) {
        return abi.encodeCall(IWormholeVaaService.getWormholeVaa, (message));
    }

    /**
     * @dev CCIP-read returns the ABI-encoded output of
     * `getWormholeVaa(bytes)`: one dynamic `bytes` value with a canonical head.
     */
    function _decodeCcipReadResponse(
        bytes calldata metadata
    ) internal pure returns (bytes memory encodedVaa) {
        if (metadata.length < 64) revert InvalidMetadata();

        uint256 offset;
        assembly {
            offset := calldataload(metadata.offset)
        }
        if (offset != 32) revert InvalidMetadata();

        encodedVaa = abi.decode(metadata, (bytes));
        uint256 paddedVaaLength = (encodedVaa.length + 31) & ~uint256(31);
        if (metadata.length != 64 + paddedVaaLength) revert InvalidMetadata();
    }

    // ============ Consistency level configuration ============

    /**
     * @dev Validates an allowed consistency level or installs this deployment's
     * custom consistency configuration in Wormhole's CCL contract.
     */
    function _validateAndConfigureConsistencyLevel(
        WormholeConsistencyLevelConfig memory config
    ) private {
        _validateConsistencyLevelConfig(config);

        if (config.consistencyLevel != CustomConsistencyLevelLib.CUSTOM) {
            return;
        }

        ICustomConsistencyLevel customConsistencyLevel = ICustomConsistencyLevel(
                config.customConsistencyLevelContract
            );
        bytes32 encodedConfig = CustomConsistencyLib
            .encodeAdditionalBlocksConfig(
                config.baseConsistencyLevel,
                config.additionalBlocks
            );

        // Store this hook/ISM's custom configuration in the local CCL contract.
        customConsistencyLevel.configure(encodedConfig);
    }

    function _validateConsistencyLevelConfig(
        WormholeConsistencyLevelConfig memory config
    ) private view {
        // Accept both Wormhole finalized encodings while rejecting arbitrary
        // values that are likely configuration mistakes.
        if (
            !CustomConsistencyLevelLib.isAllowedConsistencyLevel(
                config.consistencyLevel
            )
        ) {
            revert InvalidConsistencyLevelConfig();
        }

        if (config.consistencyLevel == CustomConsistencyLevelLib.CUSTOM) {
            if (!Address.isContract(config.customConsistencyLevelContract)) {
                revert InvalidCustomConsistencyLevelContract();
            }

            // Guardian CCL accepts only its instant, safe, and finalized
            // sentinels as custom base levels.
            if (
                !CustomConsistencyLevelLib.isAllowedCustomBaseConsistencyLevel(
                    config.baseConsistencyLevel
                )
            ) {
                revert InvalidCustomConsistencyLevelConfig();
            }
            return;
        }

        // A non-custom level must not carry unused custom-level settings.
        if (
            config.customConsistencyLevelContract != address(0) ||
            config.baseConsistencyLevel != 0 ||
            config.additionalBlocks != 0
        ) {
            revert UnexpectedCustomConsistencyLevelConfig();
        }
    }
}
