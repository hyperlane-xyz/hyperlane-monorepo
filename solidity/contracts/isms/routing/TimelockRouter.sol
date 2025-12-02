// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

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

// ============ Internal Imports ============
import {Router} from "../../client/Router.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {StandardHookMetadata} from "../../hooks/libs/StandardHookMetadata.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

/**
 * @title TimelockRouter
 * @notice Combined hook and ISM for time-delayed message verification.
 * @dev This contract serves three roles:
 * 1. Hook: On origin chain, sends message IDs to destination routers
 * 2. Router: On destination chain, receives message IDs and stores readyAt time
 * 3. ISM: On destination chain, verifies messages after the timelock window
 *
 * ## Timelock Security Model
 * TimelockRouter implements a pure timelock mechanism - messages cannot be processed
 * until a fixed time window has passed. This provides a window for off-chain watchers
 * to observe messages before they are delivered.
 *
 * ## Creating Optimistic Security via Threshold Aggregation
 * A complete optimistic system uses THRESHOLD-BASED aggregation to provide two
 * independent paths to finality:
 *
 * Structure: 1/2 aggregation of [2/2 aggregation of (pausable + timelock), finality proof]
 *
 * ```solidity
 * // 1. Deploy base components
 * TimelockRouter timelockRouter = new TimelockRouter(mailbox, 1 hours);
 * PausableIsm pausableIsm = new PausableIsm(watcherAddress);
 * MultisigIsm multisigIsm = new MultisigIsm(...); // or ZkProofIsm, any finality ISM
 *
 * // 2. Inner aggregation (2/2): BOTH pausable AND timelock must pass
 * address[] memory innerModules = new address[](2);
 * innerModules[0] = address(pausableIsm);      // Must not be paused
 * innerModules[1] = address(timelockRouter);   // Must pass timelock
 * uint8[] memory innerThresholds = new uint8[](1);
 * innerThresholds[0] = 2;  // Require BOTH (2 out of 2)
 * StaticAggregationIsm innerAgg = new StaticAggregationIsm(innerModules, innerThresholds[0]);
 *
 * // 3. Outer aggregation (1/2): EITHER optimistic path OR finality proof
 * address[] memory outerModules = new address[](2);
 * outerModules[0] = address(innerAgg);         // Fast optimistic path
 * outerModules[1] = address(multisigIsm);      // Slow finality path
 * uint8[] memory outerThresholds = new uint8[](1);
 * outerThresholds[0] = 1;  // Require EITHER (1 out of 2)
 * StaticAggregationIsm optimisticIsm = new StaticAggregationIsm(outerModules, outerThresholds[0]);
 *
 * // 4. Configure WarpRoute
 * warpRoute.setHook(address(timelockRouter));
 * warpRoute.setInterchainSecurityModule(address(optimisticIsm));
 * ```
 *
 * **How Dual-Path Optimistic Security Works:**
 *
 * Path 1 (Fast Optimistic): Inner aggregation passes if BOTH conditions met:
 *   - PausableISM.verify() passes (not paused)
 *   - TimelockRouter.verify() passes (timelock expired)
 *   Result: Message delivered after timelock, unless paused by watcher
 *
 * Path 2 (Slow Finality): Bypass optimistic layer entirely:
 *   - MultisigISM.verify() passes (valid signatures from validators)
 *   Result: Message delivered immediately with cryptographic proof
 *
 * Outer aggregation (1/2 threshold): Message passes if EITHER path succeeds
 *
 * **Benefits:**
 * - Normal case: Fast optimistic path (low cost, 1 hour latency)
 * - Emergency case: Slow finality path bypasses paused optimistic layer
 * - Redundancy: Two independent security mechanisms
 *
 * **Watcher Workflow:**
 * - Watchers monitor preverified messages during timelock window
 * - If fraud detected: watcher calls `pausableIsm.pause()`
 * - Paused messages cannot be processed (PausableISM.verify reverts)
 * - After investigation: watcher calls `pausableIsm.unpause()` or keeps paused
 *
 * ## Hook and ISM Wrapping
 * Through MailboxClient inheritance, TimelockRouter can be configured with:
 * - A wrapped hook: Set via `setHook()` to add additional post-dispatch behavior
 *   (e.g., gas payment with IGP, merkle tree indexing)
 * - A wrapped ISM: Set via `setInterchainSecurityModule()` to add additional verification
 *   (e.g., multisig verification, aggregation with other security modules)
 *
 * This allows TimelockRouter to serve as a composable timelock layer while
 * delegating to other hooks/ISMs for additional functionality.
 */
contract TimelockRouter is
    Router,
    IPostDispatchHook,
    IInterchainSecurityModule
{
    using Message for bytes;
    using StandardHookMetadata for bytes;
    using TypeCasts for address;

    // ============ Events ============
    event MessageQueued(bytes32 indexed messageId, uint48 readyAt);

    // ============ Errors ============
    error MessageNotReadyUntil(uint48 readyAt);

    // ============ Immutables ============
    uint48 public immutable timelockWindow;

    // ============ Storage ============
    /// @dev Mapping of message ID => timestamp when message is ready for verification
    mapping(bytes32 => uint48) public readyAt;

    // ============ Constructor ============
    constructor(address _mailbox, uint48 _timelockWindow) Router(_mailbox) {
        timelockWindow = _timelockWindow;
    }

    // ============ IPostDispatchHook Implementation ============

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.ID_AUTH_ISM);
    }

    /// @inheritdoc IPostDispatchHook
    function supportsMetadata(
        bytes calldata metadata
    ) public pure returns (bool) {
        return
            metadata.length == 0 ||
            metadata.variant() == StandardHookMetadata.VARIANT;
    }

    /// @inheritdoc IPostDispatchHook
    function postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) external payable {
        require(
            supportsMetadata(metadata),
            "TimelockRouter: invalid metadata variant"
        );

        // Send message ID to destination router for preverification
        _Router_dispatch(
            message.destination(),
            msg.value,
            abi.encode(message.id())
        );
    }

    /// @inheritdoc IPostDispatchHook
    function quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) external view returns (uint256) {
        require(
            supportsMetadata(metadata),
            "TimelockRouter: invalid metadata variant"
        );

        uint32 destination = message.destination();
        bytes memory payload = abi.encode(message.id());

        return
            _Router_quoteDispatch(
                destination,
                payload,
                metadata,
                address(this)
            );
    }

    // ============ Router Implementation ============

    /// @inheritdoc Router
    function _handle(
        uint32 /* _origin */,
        bytes32 /* _sender */,
        bytes calldata _message
    ) internal override {
        // Decode the message ID from the payload
        bytes32 messageId = abi.decode(_message, (bytes32));

        // Mark message as preverified with readyAt time
        require(
            readyAt[messageId] == 0,
            "TimelockRouter: message already preverified"
        );
        uint48 messageReadyAt = uint48(block.timestamp) + timelockWindow;
        readyAt[messageId] = messageReadyAt;

        emit MessageQueued(messageId, messageReadyAt);
    }

    // ============ IInterchainSecurityModule Implementation ============

    /// @inheritdoc IInterchainSecurityModule
    function moduleType() external pure returns (uint8) {
        return uint8(IInterchainSecurityModule.Types.NULL);
    }

    /// @inheritdoc IInterchainSecurityModule
    function verify(
        bytes calldata /* metadata */,
        bytes calldata message
    ) external view returns (bool) {
        bytes32 messageId = message.id();
        uint48 messageReadyAt = readyAt[messageId];

        require(messageReadyAt > 0, "TimelockRouter: message not preverified");

        if (messageReadyAt > block.timestamp) {
            revert MessageNotReadyUntil(messageReadyAt);
        }

        return true;
    }

    // ============ Owner Functions ============

    /**
     * @notice Manually preverify a message (emergency use only)
     * @param messageId The message ID to preverify
     */
    function manuallyPreverifyMessage(bytes32 messageId) external onlyOwner {
        require(
            readyAt[messageId] == 0,
            "TimelockRouter: message already preverified"
        );
        uint48 messageReadyAt = uint48(block.timestamp) + timelockWindow;
        readyAt[messageId] = messageReadyAt;
        emit MessageQueued(messageId, messageReadyAt);
    }
}
