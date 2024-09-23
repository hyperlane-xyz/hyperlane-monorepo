// SPDX-License-Identifier: BUSL-1.1
pragma solidity >=0.8.0;

import {ISignatureUtils} from "../interfaces/avs/vendored/ISignatureUtils.sol";
import {IAVSDirectory} from "../interfaces/avs/vendored/IAVSDirectory.sol";

import {IServiceManager} from "../interfaces/avs/vendored/IServiceManager.sol";
import {IServiceManagerUI} from "../interfaces/avs/vendored/IServiceManagerUI.sol";
import {IDelegationManager} from "../interfaces/avs/vendored/IDelegationManager.sol";
import {IStrategy} from "../interfaces/avs/vendored/IStrategy.sol";
import {IPaymentCoordinator} from "../interfaces/avs/vendored/IPaymentCoordinator.sol";
import {Quorum} from "../interfaces/avs/vendored/IECDSAStakeRegistryEventsAndErrors.sol";
import {ECDSAStakeRegistry} from "./ECDSAStakeRegistry.sol";

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @author Layr Labs, Inc.
abstract contract ECDSAServiceManagerBase is
    IServiceManager,
    OwnableUpgradeable
{
    /// @notice Address of the stake registry contract, which manages registration and stake recording.
    address public immutable stakeRegistry;

    /// @notice Address of the AVS directory contract, which manages AVS-related data for registered operators.
    address public immutable avsDirectory;

    /// @notice Address of the delegation manager contract, which manages staker delegations to operators.
    address internal immutable delegationManager;

    // ============ Public Storage ============

    /// @notice Address of the payment coordinator contract, which handles payment distributions. Will be set once live on Eigenlayer.
    address internal paymentCoordinator;

    // ============ Modifiers ============

    /**
     * @dev Ensures that the function is only callable by the `stakeRegistry` contract.
     * This is used to restrict certain registration and deregistration functionality to the `stakeRegistry`
     */
    modifier onlyStakeRegistry() {
        require(
            msg.sender == stakeRegistry,
            "ECDSAServiceManagerBase.onlyStakeRegistry: caller is not the stakeRegistry"
        );
        _;
    }

    // ============ Events ============

    /**
     * @notice Emitted when an operator is registered to the AVS
     * @param operator The address of the operator
     */
    event OperatorRegisteredToAVS(address indexed operator);

    /**
     * @notice Emitted when an operator is deregistered from the AVS
     * @param operator The address of the operator
     */
    event OperatorDeregisteredFromAVS(address indexed operator);

    // ============ Constructor ============

    /**
     * @dev Constructor for ECDSAServiceManagerBase, initializing immutable contract addresses and disabling initializers.
     * @param _avsDirectory The address of the AVS directory contract, managing AVS-related data for registered operators.
     * @param _stakeRegistry The address of the stake registry contract, managing registration and stake recording.
     * @param _paymentCoordinator The address of the payment coordinator contract, handling payment distributions.
     * @param _delegationManager The address of the delegation manager contract, managing staker delegations to operators.
     */
    constructor(
        address _avsDirectory,
        address _stakeRegistry,
        address _paymentCoordinator,
        address _delegationManager
    ) {
        avsDirectory = _avsDirectory;
        stakeRegistry = _stakeRegistry;
        paymentCoordinator = _paymentCoordinator;
        delegationManager = _delegationManager;
    }

    /**
     * @dev Initializes the base service manager by transferring ownership to the initial owner.
     * @param initialOwner The address to which the ownership of the contract will be transferred.
     */
    function __ServiceManagerBase_init(
        address initialOwner
    ) internal virtual onlyInitializing {
        _transferOwnership(initialOwner);
    }

    /// @inheritdoc IServiceManagerUI
    function updateAVSMetadataURI(
        string memory _metadataURI
    ) external virtual onlyOwner {
        _updateAVSMetadataURI(_metadataURI);
    }

    /// @inheritdoc IServiceManager
    function payForRange(
        IPaymentCoordinator.RangePayment[] calldata rangePayments
    ) external virtual onlyOwner {
        _payForRange(rangePayments);
    }

    /// @inheritdoc IServiceManagerUI
    function registerOperatorToAVS(
        address operator,
        ISignatureUtils.SignatureWithSaltAndExpiry memory operatorSignature
    ) external virtual onlyStakeRegistry {
        _registerOperatorToAVS(operator, operatorSignature);
    }

    /// @inheritdoc IServiceManagerUI
    function deregisterOperatorFromAVS(
        address operator
    ) external virtual onlyStakeRegistry {
        _deregisterOperatorFromAVS(operator);
    }

    /// @inheritdoc IServiceManagerUI
    function getRestakeableStrategies()
        external
        view
        virtual
        returns (address[] memory)
    {
        return _getRestakeableStrategies();
    }

    /// @inheritdoc IServiceManagerUI
    function getOperatorRestakedStrategies(
        address _operator
    ) external view virtual returns (address[] memory) {
        return _getOperatorRestakedStrategies(_operator);
    }

    /**
     * @notice Sets the address of the payment coordinator contract.
     * @dev This function is only callable by the contract owner.
     * @param _paymentCoordinator The address of the payment coordinator contract.
     */
    function setPaymentCoordinator(
        address _paymentCoordinator
    ) external virtual onlyOwner {
        paymentCoordinator = _paymentCoordinator;
    }

    /**
     * @notice Forwards the call to update AVS metadata URI in the AVSDirectory contract.
     * @dev This internal function is a proxy to the `updateAVSMetadataURI` function of the AVSDirectory contract.
     * @param _metadataURI The new metadata URI to be set.
     */
    function _updateAVSMetadataURI(
        string memory _metadataURI
    ) internal virtual {
        IAVSDirectory(avsDirectory).updateAVSMetadataURI(_metadataURI);
    }

    /**
     * @notice Forwards the call to register an operator in the AVSDirectory contract.
     * @dev This internal function is a proxy to the `registerOperatorToAVS` function of the AVSDirectory contract.
     * @param operator The address of the operator to register.
     * @param operatorSignature The signature, salt, and expiry details of the operator's registration.
     */
    function _registerOperatorToAVS(
        address operator,
        ISignatureUtils.SignatureWithSaltAndExpiry memory operatorSignature
    ) internal virtual {
        IAVSDirectory(avsDirectory).registerOperatorToAVS(
            operator,
            operatorSignature
        );
        emit OperatorRegisteredToAVS(operator);
    }

    /**
     * @notice Forwards the call to deregister an operator from the AVSDirectory contract.
     * @dev This internal function is a proxy to the `deregisterOperatorFromAVS` function of the AVSDirectory contract.
     * @param operator The address of the operator to deregister.
     */
    function _deregisterOperatorFromAVS(address operator) internal virtual {
        IAVSDirectory(avsDirectory).deregisterOperatorFromAVS(operator);
        emit OperatorDeregisteredFromAVS(operator);
    }

    /**
     * @notice Processes a batch of range payments by transferring the specified amounts from the sender to this contract and then approving the PaymentCoordinator to use these amounts.
     * @dev This function handles the transfer and approval of tokens necessary for range payments. It then delegates the actual payment logic to the PaymentCoordinator contract.
     * @param rangePayments An array of `RangePayment` structs, each representing a payment for a specific range.
     */
    function _payForRange(
        IPaymentCoordinator.RangePayment[] calldata rangePayments
    ) internal virtual {
        for (uint256 i = 0; i < rangePayments.length; ++i) {
            rangePayments[i].token.transferFrom(
                msg.sender,
                address(this),
                rangePayments[i].amount
            );
            rangePayments[i].token.approve(
                paymentCoordinator,
                rangePayments[i].amount
            );
        }

        IPaymentCoordinator(paymentCoordinator).payForRange(rangePayments);
    }

    /**
     * @notice Retrieves the addresses of all strategies that are part of the current quorum.
     * @dev Fetches the quorum configuration from the ECDSAStakeRegistry and extracts the strategy addresses.
     * @return strategies An array of addresses representing the strategies in the current quorum.
     */
    function _getRestakeableStrategies()
        internal
        view
        virtual
        returns (address[] memory)
    {
        Quorum memory quorum = ECDSAStakeRegistry(stakeRegistry).quorum();
        address[] memory strategies = new address[](quorum.strategies.length);
        for (uint256 i = 0; i < quorum.strategies.length; i++) {
            strategies[i] = address(quorum.strategies[i].strategy);
        }
        return strategies;
    }

    /**
     * @notice Retrieves the addresses of strategies where the operator has restaked.
     * @dev This function fetches the quorum details from the ECDSAStakeRegistry, retrieves the operator's shares for each strategy,
     * and filters out strategies with non-zero shares indicating active restaking by the operator.
     * @param _operator The address of the operator whose restaked strategies are to be retrieved.
     * @return restakedStrategies An array of addresses of strategies where the operator has active restakes.
     */
    function _getOperatorRestakedStrategies(
        address _operator
    ) internal view virtual returns (address[] memory) {
        Quorum memory quorum = ECDSAStakeRegistry(stakeRegistry).quorum();
        uint256 count = quorum.strategies.length;
        IStrategy[] memory strategies = new IStrategy[](count);
        for (uint256 i; i < count; i++) {
            strategies[i] = quorum.strategies[i].strategy;
        }
        uint256[] memory shares = IDelegationManager(delegationManager)
            .getOperatorShares(_operator, strategies);

        uint256 activeCount;
        for (uint256 i; i < count; i++) {
            if (shares[i] > 0) {
                activeCount++;
            }
        }

        // Resize the array to fit only the active strategies
        address[] memory restakedStrategies = new address[](activeCount);
        uint256 index;
        for (uint256 j = 0; j < count; j++) {
            if (shares[j] > 0) {
                restakedStrategies[index] = address(strategies[j]);
                index++;
            }
        }

        return restakedStrategies;
    }

    // storage gap for upgradeability
    // slither-disable-next-line shadowing-state
    uint256[50] private __GAP;
}
