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
import {IRemoteChallenger} from "../interfaces/avs/IRemoteChallenger.sol";

import {ISignatureUtils} from "@eigenlayer/interfaces/ISignatureUtils.sol";
import {IAVSDirectory} from "@eigenlayer/interfaces/IAVSDirectory.sol";
import {ISlasher} from "@eigenlayer/interfaces/ISlasher.sol";
import {ECDSAStakeRegistry} from "@eigenlayer/ecdsa/ECDSAStakeRegistry.sol";
import {IServiceManager} from "@eigenlayer/middleware/interfaces/IServiceManager.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract ECDSAServiceManagerBase is IServiceManager, OwnableUpgradeable {
    // ============ Constants ============

    // Stake registry responsible for maintaining operator stakes
    ECDSAStakeRegistry internal immutable stakeRegistry;
    // Eigenlayer's AVS directory for interactions between AVS and operators
    IAVSDirectory internal immutable elAvsDirectory;

    // ============ Public Storage ============

    // Slasher contract responsible for slashing operators
    // @dev slasher needs to be updated once slashing is implemented
    ISlasher internal slasher;

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

    // ============ Modifiers ============

    /// @notice when applied to a function, only allows the ECDSAStakeRegistry to call it
    modifier onlyStakeRegistry() {
        require(
            msg.sender == address(stakeRegistry),
            "ECDSAServiceManagerBase: caller is not the stake registry"
        );
        _;
    }

    /// @notice when applied to a function, only allows the ECDSAStakeRegistry or the operator to call it
    /// for completeQueuedUnenrollmentFromChallengers access control
    modifier onlyStakeRegistryOrOperator(address operator) {
        require(
            msg.sender == address(stakeRegistry) || msg.sender == operator,
            "ECDSAServiceManagerBase: caller is not the stake registry or operator"
        );
        _;
    }

    // ============ Constructor ============

    constructor(
        IAVSDirectory _avsDirectory,
        ECDSAStakeRegistry _stakeRegistry,
        ISlasher _slasher
    ) {
        elAvsDirectory = _avsDirectory;
        stakeRegistry = _stakeRegistry;
        slasher = _slasher;
        _disableInitializers();
    }

    // ============ External Functions ============

    /**
     * @notice Returns the list of strategies that the AVS supports for restaking
     * @dev This function is intended to be called off-chain
     * @dev No guarantee is made on uniqueness of each element in the returned array.
     *      The off-chain service should do that validation separately
     */
    function getRestakeableStrategies()
        external
        view
        returns (address[] memory)
    {
        return _getRestakeableStrategies();
    }

    /**
     * @notice Returns the list of strategies that the operator has potentially restaked on the AVS
     * @dev This function is intended to be called off-chain
     * @dev Since ECDSAStakeRegistry only supports one quorum, each operator restakes into all the AVS strategies
     * @dev No guarantee is made on uniqueness of each element in the returned array.
     *      The off-chain service should do that validation separately
     */
    function getOperatorRestakedStrategies(
        address /* operator */
    ) external view returns (address[] memory) {
        return _getRestakeableStrategies();
    }

    /**
     * @notice Sets the slasher contract responsible for slashing operators
     * @param _slasher The address of the slasher contract
     */
    function setSlasher(ISlasher _slasher) external onlyOwner {
        slasher = _slasher;
    }

    /// @notice Returns the EigenLayer AVSDirectory contract.
    function avsDirectory() external view override returns (address) {
        return address(elAvsDirectory);
    }

    // ============ Public Functions ============

    /**
     * @notice Updates the metadata URI for the AVS
     * @param _metadataURI is the metadata URI for the AVS
     * @dev only callable by the owner
     */
    function updateAVSMetadataURI(
        string memory _metadataURI
    ) public virtual onlyOwner {
        elAvsDirectory.updateAVSMetadataURI(_metadataURI);
    }

    /**
     * @notice Forwards a call to EigenLayer's AVSDirectory contract to confirm operator registration with the AVS
     * @param operator The address of the operator to register.
     * @param operatorSignature The signature, salt, and expiry of the operator's signature.
     */
    function registerOperatorToAVS(
        address operator,
        ISignatureUtils.SignatureWithSaltAndExpiry memory operatorSignature
    ) public virtual onlyStakeRegistry {
        elAvsDirectory.registerOperatorToAVS(operator, operatorSignature);
        emit OperatorRegisteredToAVS(operator);
    }

    /**
     * @notice Forwards a call to EigenLayer's AVSDirectory contract to confirm operator deregistration from the AVS
     * @param operator The address of the operator to deregister.
     */
    function deregisterOperatorFromAVS(
        address operator
    ) public virtual onlyStakeRegistry {
        elAvsDirectory.deregisterOperatorFromAVS(operator);
        emit OperatorDeregisteredFromAVS(operator);
    }

    /**
     * @notice Freezes an operator and their stake from Eigenlayer
     * @param operator The address of the operator to freeze.
     */
    function freezeOperator(address operator) public virtual onlyOwner {
        slasher.freezeOperator(operator);
    }

    // ============ Internal Function ============

    function _getRestakeableStrategies()
        internal
        view
        returns (address[] memory)
    {
        uint256 strategyCount = stakeRegistry.quorum().strategies.length;

        if (strategyCount == 0) {
            return new address[](0);
        }

        address[] memory restakedStrategies = new address[](strategyCount);
        for (uint256 i = 0; i < strategyCount; i++) {
            restakedStrategies[i] = address(
                stakeRegistry.quorum().strategies[i].strategy
            );
        }
        return restakedStrategies;
    }

    // storage gap for upgradeability
    // slither-disable-next-line shadowing-state
    uint256[50] private __GAP;
}
