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
import {AbstractWormholeHookIsm} from "./AbstractWormholeHookIsm.sol";
import {RelayInstructionLib, RequestLib} from "./libs/ExecutorRequest.sol";
import {WormholeMessage} from "../../libs/WormholeMessage.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {CoreBridgeVM} from "../../interfaces/wormhole/ICoreBridge.sol";
import {IExecutorQuoterRouter, IVaaV1Receiver} from "../../interfaces/wormhole/IExecutor.sol";
import {RemoteRouterEnrollment} from "../../interfaces/wormhole/IWormholeHookIsm.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {WormholeConsistencyLevelConfig} from "./libs/CustomConsistencyLevel.sol";

/**
 * @title WormholeExecutorHookIsm
 * @notice Wormhole hook/ISM router that buys Executor delivery of the VAA and
 * preauthorizes the Hyperlane message on the destination.
 * @dev Destination flow: a delivery provider — or any rescuer — calls
 * `executeVAAv1` with the signed VAA; the router stores the message-ID and
 * nonce authorization; a normal Hyperlane relayer then calls
 * `Mailbox.process("", message)`, which this contract verifies with empty
 * metadata (`moduleType == NULL`).
 */
// Router already exposes enumerable domains for executorConfigs.
// solhint-disable-next-line hyperlane/enumerable-domain-mapping
contract WormholeExecutorHookIsm is AbstractWormholeHookIsm, IVaaV1Receiver {
    using Message for bytes;
    using TypeCasts for address;

    // ============ Types ============

    /// @dev Executor-only transaction input; it does not belong in the base API.
    struct ExecutorRemoteRouterEnrollment {
        RemoteRouterEnrollment remoteRouter;
        address quoter;
        uint128 callbackGasLimit;
    }

    struct ExecutorConfig {
        address quoter;
        uint128 callbackGasLimit;
    }

    // ============ Events ============

    event ExecutorConfigSet(
        uint32 indexed domain,
        address indexed quoter,
        uint128 callbackGasLimit
    );

    event MessageAuthorized(
        bytes32 indexed messageId,
        uint32 indexed originDomain,
        uint64 sequence,
        uint32 nonce
    );

    // ============ Errors ============

    error InvalidExecutorQuoterRouter();
    error InvalidExecutorConfig();
    error ExecutorRouteNotConfigured();
    error DestinationValueUnsupported();
    error VaaAlreadyConsumed();
    error MessageAlreadyAuthorized();

    // ============ Immutables ============

    /// @notice Shared, Wormhole-published Executor Quoter Router.
    IExecutorQuoterRouter public immutable executorQuoterRouter;

    // ============ Storage ============

    /// @notice Delivery configuration per enrolled destination domain.
    mapping(uint32 domain => ExecutorConfig config) public executorConfigs;

    /// @notice Zero means unauthorized; otherwise the Hyperlane nonce plus one.
    /// @dev The authenticated origin is a separate key so an authorization from
    /// one remote domain can never satisfy verification for another domain,
    /// even if their Hyperlane message IDs were to collide. A successful
    /// callback is final: later router unenrollment prevents new callbacks but
    /// does not revoke authorization already stored here.
    mapping(uint32 originDomain => mapping(bytes32 messageId => uint64 noncePlusOne))
        public authorizations;

    /// @notice `CoreBridgeVM.hash` is Core's stable VAA body digest.
    mapping(bytes32 vaaDigest => bool consumed) public consumedVaaDigests;

    // ============ Constructor ============

    constructor(
        address mailbox_,
        address wormhole_,
        WormholeConsistencyLevelConfig memory consistencyLevelConfig_,
        address executorQuoterRouter_
    ) AbstractWormholeHookIsm(mailbox_, wormhole_, consistencyLevelConfig_) {
        if (!Address.isContract(executorQuoterRouter_)) {
            revert InvalidExecutorQuoterRouter();
        }
        executorQuoterRouter = IExecutorQuoterRouter(executorQuoterRouter_);
    }

    // ============ Enrollment ============

    /**
     * @notice Enrolls one remote router together with its delivery
     * configuration.
     * @dev Atomic by design: an Executor route is never enrolled without a
     * usable quoter and callback gas limit.
     */
    function enrollRemoteRouter(
        ExecutorRemoteRouterEnrollment calldata enrollment
    ) external onlyOwner {
        _enrollExecutorRemoteRouter(enrollment);
    }

    /// @notice Batch version of `enrollRemoteRouter`.
    function enrollRemoteRouters(
        ExecutorRemoteRouterEnrollment[] calldata enrollments
    ) external onlyOwner {
        for (uint256 i; i < enrollments.length; ++i) {
            _enrollExecutorRemoteRouter(enrollments[i]);
        }
    }

    function _enrollExecutorRemoteRouter(
        ExecutorRemoteRouterEnrollment calldata enrollment
    ) internal {
        // The quoter is a provider-controlled lookup/signing key in the Quoter
        // Router, not necessarily a contract, so only a zero check applies.
        if (
            enrollment.quoter == address(0) || enrollment.callbackGasLimit == 0
        ) {
            revert InvalidExecutorConfig();
        }

        _enrollWormholeRemoteRouter(enrollment.remoteRouter);

        uint32 domain = enrollment.remoteRouter.domain;
        executorConfigs[domain] = ExecutorConfig({
            quoter: enrollment.quoter,
            callbackGasLimit: enrollment.callbackGasLimit
        });
        emit ExecutorConfigSet(
            domain,
            enrollment.quoter,
            enrollment.callbackGasLimit
        );
    }

    /// @inheritdoc AbstractWormholeHookIsm
    function _AbstractWormholeHookIsm_onRemoteRouterUnenrolled(
        uint32 domain
    ) internal override {
        delete executorConfigs[domain];
    }

    // ============ Quote and request ============

    function _executorRequest(
        bytes calldata message,
        uint64 sequence
    )
        internal
        view
        returns (
            ExecutorConfig memory config,
            bytes memory request,
            bytes memory instructions
        )
    {
        uint32 destination = message.destination();
        config = executorConfigs[destination];
        if (config.quoter == address(0)) revert ExecutorRouteNotConfigured();

        request = RequestLib.encodeVaaMultiSigRequest(
            wormholeChainId,
            address(this).addressToBytes32(),
            sequence
        );
        // This is the gas budget for `executeVAAv1`, not the destination
        // recipient's `handle` gas carried by StandardHookMetadata.
        // Destination msg.value is unsupported in v1.
        instructions = RelayInstructionLib.encodeGas(
            config.callbackGasLimit,
            0
        );
    }

    /// @inheritdoc AbstractWormholeHookIsm
    function _AbstractWormholeHookIsm_quoteExtraFees(
        bytes calldata,
        bytes calldata message,
        uint64 sequence,
        address refundAddress
    ) internal view override returns (uint256) {
        (
            ExecutorConfig memory config,
            bytes memory request,
            bytes memory instructions
        ) = _executorRequest(message, sequence);

        uint32 destination = message.destination();
        return
            executorQuoterRouter.quoteExecution(
                remoteRouterConfigs[destination].wormholeChainId,
                _mustHaveRemoteRouter(destination),
                refundAddress,
                config.quoter,
                request,
                instructions
            );
    }

    /// @inheritdoc AbstractWormholeHookIsm
    function _AbstractWormholeHookIsm_payExtraFees(
        bytes calldata,
        bytes calldata message,
        uint64 sequence,
        address refundAddress,
        uint256 extraFees
    ) internal override {
        (
            ExecutorConfig memory config,
            bytes memory request,
            bytes memory instructions
        ) = _executorRequest(message, sequence);

        uint32 destination = message.destination();
        executorQuoterRouter.requestExecution{value: extraFees}(
            remoteRouterConfigs[destination].wormholeChainId,
            _mustHaveRemoteRouter(destination),
            refundAddress,
            config.quoter,
            request,
            instructions
        );
    }

    // ============ Permissionless callback ============

    /// @notice Hyperlane supplies empty metadata; authorization is already stored.
    function moduleType() external pure returns (uint8) {
        return uint8(IInterchainSecurityModule.Types.NULL);
    }

    /**
     * @inheritdoc IVaaV1Receiver
     * @dev Permissionless: authenticity comes from the Core-verified VAA and
     * the enrolled origin router, never from `msg.sender`. Only Core's `view`
     * verification is called, so effects follow all external interaction.
     */
    function executeVAAv1(bytes calldata encodedVaa) external payable {
        if (msg.value != 0) revert DestinationValueUnsupported();

        (
            CoreBridgeVM memory vm_,
            WormholeMessage.Message memory wm
        ) = _decodeAndValidateVaa(encodedVaa);

        if (consumedVaaDigests[vm_.hash]) revert VaaAlreadyConsumed();
        if (authorizations[wm.originDomain][wm.messageId] != 0) {
            revert MessageAlreadyAuthorized();
        }

        consumedVaaDigests[vm_.hash] = true;
        authorizations[wm.originDomain][wm.messageId] = uint64(wm.nonce) + 1;

        emit MessageAuthorized(
            wm.messageId,
            wm.originDomain,
            vm_.sequence,
            wm.nonce
        );
    }

    /// @inheritdoc AbstractWormholeHookIsm
    /// @dev Nonce equality is completed here, where the full Hyperlane message
    /// is finally available.
    function _AbstractWormholeHookIsm_verify(
        bytes calldata,
        /*metadata*/
        bytes calldata message
    ) internal view override returns (bool) {
        if (message.destination() != localDomain) {
            revert WrongDestinationDomain();
        }
        return
            authorizations[message.origin()][message.id()] ==
            uint64(message.nonce()) + 1;
    }
}
