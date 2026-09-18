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
import {ReverseMappingLib} from "../../libs/ReverseMapping.sol";
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
 * Hyperlane message ID and destination hook/ISM. On the destination, `verify`
 * authenticates the resulting VAA and compares that commitment with the
 * Hyperlane message being processed.
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
    using ReverseMappingLib for ReverseMappingLib.Uint16ReverseMappingStorage;

    // ============ Errors ============

    error InvalidMetadata();
    error InvalidRemoteDomain();
    error InvalidDomainIsm();
    error InvalidWormholeChainId();
    error InvalidRemoteWormholeChainId();
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
    error WrongDestinationDomain();
    error WrongDestinationHookIsm();
    error WrongConsistencyLevel();
    error WrongEmitterChainId();
    error WrongEmitterAddress();
    error WrongMessageId();
    error WormholeNonceMismatch();
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

    /// @notice Complete configuration for a remote hook/ISM route.
    /// @dev The hook/ISM address, Wormhole chain ID, and expected consistency
    /// level are installed atomically.
    struct RemoteRouterConfig {
        /// @notice Hyperlane domain of the remote hook/ISM.
        uint32 domainId;
        /// @notice Remote hook/ISM address encoded as `bytes32`.
        bytes32 domainIsm;
        /// @notice Wormhole chain containing the remote hook/ISM.
        uint16 wormholeChainId;
        /// @notice Consistency level required in VAAs from the remote hook/ISM.
        uint8 expectedConsistencyLevel;
    }

    // ============ Immutables ============

    /// @notice Wormhole Core contract deployed on this chain.
    ICoreBridge public immutable wormholeCoreBridge;

    /// @notice Wormhole chain ID of this chain, read from Core.
    uint16 public immutable wormholeChainId;

    /// @notice Wormhole consistency level for Hyperlane commitments published
    /// by this hook.
    /// @dev For a custom policy, this is `CustomConsistencyLevelLib.CUSTOM`.
    uint8 public immutable consistencyLevel;

    /// @notice Wormhole Custom Consistency Level (CCL) contract for this hook.
    /// @dev Zero address when a standard consistency level is used.
    ICustomConsistencyLevel public immutable customConsistencyLevelContract;

    /// @notice Starting Wormhole consistency level for a custom policy.
    /// @dev Guardians wait `additionalBlocks` after reaching this level.
    /// Zero when the publication uses a standard consistency level.
    uint8 public immutable customBaseConsistencyLevel;

    /// @notice Extra blocks Guardians wait after `customBaseConsistencyLevel`.
    /// @dev Zero when a standard consistency level is used.
    uint16 public immutable additionalBlocks;

    // ============ Storage ============

    /// @notice One-to-one mapping between Hyperlane domains and Wormhole chains.
    ReverseMappingLib.Uint16ReverseMappingStorage private remoteChainIds;

    /// @notice Expected VAA consistency level for each Hyperlane domain.
    /// @dev A route is valid only when `Router.routers` and `remoteChainIds`
    /// also contain that domain.
    mapping(uint32 domainId => uint8 level) private expectedConsistencyLevels;

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
        if (wormholeChainId == 0) {
            revert InvalidWormholeChainId();
        }

        _validateAndConfigureConsistencyLevel(_consistencyLevelConfig);
        consistencyLevel = _consistencyLevelConfig.consistencyLevel;
        customConsistencyLevelContract = ICustomConsistencyLevel(
            _consistencyLevelConfig.customConsistencyLevelContract
        );
        customBaseConsistencyLevel = _consistencyLevelConfig
            .customBaseConsistencyLevel;
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

        return _verifyVaaForMessage(encodedVaa, message);
    }

    // ============ Router ============

    /// @notice Returns the Wormhole chain ID and expected consistency level
    /// for a Hyperlane domain, or zero values if it is not enrolled.
    function remoteRouterConfigs(
        uint32 domainId
    ) public view returns (uint16 remoteWormholeChainId, uint8 expectedLevel) {
        return (
            remoteChainIds.reverseKeyOf(domainId),
            expectedConsistencyLevels[domainId]
        );
    }

    /// @notice Returns the Hyperlane domain assigned to a Wormhole chain ID.
    /// @dev `enrolled` distinguishes domain ID zero from an unassigned chain.
    function domainIdForRemoteWormholeChainId(
        uint16 remoteWormholeChainId
    ) public view returns (bool enrolled, uint32 hyperlaneDomainId) {
        ReverseMappingLib.ReverseEntry memory entry = remoteChainIds.keyOf(
            remoteWormholeChainId
        );

        return (entry.assigned, entry.key);
    }

    /// @notice Enrolls remote hook/ISM addresses, Wormhole chain IDs, and
    /// expected VAA consistency levels atomically.
    function enrollRemoteRouters(
        RemoteRouterConfig[] calldata newRemoteConfigs
    ) external onlyOwner {
        for (uint256 i; i < newRemoteConfigs.length; ++i) {
            _enrollWormholeRemoteRouter(newRemoteConfigs[i]);
        }
    }

    /// @dev Installs the remote hook/ISM address in `Router` together with its
    /// Wormhole chain ID and expected VAA consistency level.
    function _enrollWormholeRemoteRouter(
        RemoteRouterConfig calldata newRemoteConfig
    ) internal {
        uint32 domainId = newRemoteConfig.domainId;
        bytes32 domainIsm = newRemoteConfig.domainIsm;

        if (domainId == localDomain) {
            revert InvalidRemoteDomain();
        }

        // Wormhole emitter identities can use the full 32 bytes on non-EVM chains.
        if (domainIsm == bytes32(0)) {
            revert InvalidDomainIsm();
        }

        if (newRemoteConfig.wormholeChainId == 0) {
            revert InvalidWormholeChainId();
        }

        if (newRemoteConfig.wormholeChainId == wormholeChainId) {
            revert InvalidRemoteWormholeChainId();
        }

        // `assign` rejects another domain's chain ID and releases this
        // domain's previous chain ID when it changes.
        remoteChainIds.assign(domainId, newRemoteConfig.wormholeChainId);
        Router._enrollRemoteRouter(domainId, domainIsm);
        expectedConsistencyLevels[domainId] = newRemoteConfig
            .expectedConsistencyLevel;

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

    /// @dev Removes both chain-ID directions and the consistency policy before
    /// removing the remote hook/ISM from `Router`.
    function _unenrollRemoteRouter(uint32 domainId) internal override {
        bytes32 domainIsm = _mustHaveRemoteRouter(domainId);
        uint16 remoteWormholeChainId = remoteChainIds.remove(domainId);

        delete expectedConsistencyLevels[domainId];
        Router._unenrollRemoteRouter(domainId);

        emit WormholeRemoteRouterUnenrolled(
            domainId,
            domainIsm,
            remoteWormholeChainId
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
        if (!_isLatestDispatched(messageId)) {
            revert MessageNotDispatched();
        }

        if (publishedMessages[messageId]) {
            revert MessageAlreadyPublished();
        }

        uint256 coreFee = _quoteDispatch(metadata, message);
        if (msg.value < coreFee) {
            revert InsufficientFee(coreFee, msg.value);
        }

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
                    _mustHaveRemoteRouter(destination),
                    messageId
                ),
                consistencyLevel
            );
    }

    // ============ VAA validation ============

    /**
     * @dev Verifies Guardian signatures through Core, then binds the VAA to
     * the Hyperlane message, this destination, and an enrolled remote hook/ISM.
     */
    function _verifyVaaForMessage(
        bytes memory encodedVaa,
        bytes calldata message
    ) internal view returns (bool) {
        CoreBridgeVM memory vaa;
        bool valid;
        string memory reason;
        // Wormhole Core verifies without consuming the VAA:
        // https://github.com/wormhole-foundation/wormhole/blob/2df4000c5bd228e5ce3a3d87f0475837071587f9/ethereum/contracts/Messages.sol#L15-L20
        // The Mailbox prevents repeat delivery of the committed message ID.
        (vaa, valid, reason) = wormholeCoreBridge.parseAndVerifyVM(encodedVaa);
        if (!valid) {
            revert InvalidVaa(reason);
        }

        WormholeMessage.Message memory wormholeMessage = WormholeMessage.decode(
            vaa.payload
        );
        if (wormholeMessage.messageId != message.id()) {
            revert WrongMessageId();
        }

        if (message.destination() != localDomain) {
            revert WrongDestinationDomain();
        }

        if (
            wormholeMessage.destinationHookIsm !=
            address(this).addressToBytes32()
        ) {
            revert WrongDestinationHookIsm();
        }

        if (vaa.nonce != message.nonce()) {
            revert WormholeNonceMismatch();
        }

        // Bind the VAA emitter to the route enrolled for its origin domain.
        uint32 originDomain = message.origin();
        bytes32 expectedEmitter = _mustHaveRemoteRouter(originDomain);
        (
            uint16 expectedWormholeChainId,
            uint8 expectedConsistencyLevel
        ) = remoteRouterConfigs(originDomain);

        if (vaa.emitterChainId != expectedWormholeChainId) {
            revert WrongEmitterChainId();
        }

        if (vaa.emitterAddress != expectedEmitter) {
            revert WrongEmitterAddress();
        }

        if (vaa.consistencyLevel != expectedConsistencyLevel) {
            revert WrongConsistencyLevel();
        }

        return true;
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
        if (metadata.length < 64) {
            revert InvalidMetadata();
        }

        uint256 offset;
        assembly {
            offset := calldataload(metadata.offset)
        }
        if (offset != 32) {
            revert InvalidMetadata();
        }

        encodedVaa = abi.decode(metadata, (bytes));
        uint256 paddedVaaLength = (encodedVaa.length + 31) & ~uint256(31);
        if (metadata.length != 64 + paddedVaaLength) {
            revert InvalidMetadata();
        }
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
                config.customBaseConsistencyLevel,
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
                    config.customBaseConsistencyLevel
                )
            ) {
                revert InvalidCustomConsistencyLevelConfig();
            }
            return;
        }

        // A non-custom level must not carry unused custom-level settings.
        if (
            config.customConsistencyLevelContract != address(0) ||
            config.customBaseConsistencyLevel != 0 ||
            config.additionalBlocks != 0
        ) {
            revert UnexpectedCustomConsistencyLevelConfig();
        }
    }
}
