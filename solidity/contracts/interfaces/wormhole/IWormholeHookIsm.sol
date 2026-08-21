// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @notice Complete remote-router enrollment input shared by both variants.
 * @dev This is a transaction input, not a storage layout. `Router._routers`
 * stays the source of truth for the router address; the Wormhole policy lives
 * in `AbstractWormholeHookIsm.remoteRouterConfigs`.
 */
struct RemoteRouterEnrollment {
    uint32 domain;
    bytes32 router;
    uint16 wormholeChainId;
    uint8 expectedConsistencyLevel;
}

/**
 * @title IWormholeHookIsm
 * @notice Events and errors shared by `WormholeExecutorHookIsm` and
 * `WormholeVaaHookIsm`.
 */
interface IWormholeHookIsm {
    // ============ Events ============

    /// @notice Emitted for every remote-router enrollment or replacement.
    event WormholeRemoteRouterEnrolled(
        uint32 indexed domain,
        bytes32 indexed router,
        uint16 wormholeChainId,
        uint8 expectedConsistencyLevel
    );

    /// @notice Correlates a Hyperlane message with its Wormhole publication.
    event WormholeMessagePublished(
        bytes32 indexed messageId,
        uint32 indexed destinationDomain,
        uint64 sequence,
        uint32 nonce
    );

    // ============ Enrollment errors ============

    error InvalidRemoteDomain();
    error InvalidRemoteRouter();
    error InvalidWormholeChainId();
    error InvalidRemoteWormholeChainId();
    error WormholeChainIdAlreadyEnrolled();
    error WormholeChainIdChangeRequiresUnenrollment();
    error IncompleteRemoteRouterConfig();
    error RichEnrollmentRequired();

    // ============ Construction errors ============

    error InvalidWormholeCore();
    error InvalidWormholeEvmChainId();
    error InvalidCustomConsistencyLevel();
    error InvalidCustomConsistencyLevelConfig();
    error UnexpectedCustomConsistencyLevelConfig();

    // ============ Dispatch errors ============

    error MessageNotDispatched();
    error MessageAlreadyPublished();
    error InsufficientFee(uint256 required, uint256 provided);
    error UnexpectedPublishedSequence(uint64 expected, uint64 actual);
    error ExtraFeesNotHandled();

    // ============ Verification errors ============

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
}
