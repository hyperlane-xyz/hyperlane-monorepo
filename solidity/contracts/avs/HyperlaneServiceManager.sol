// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {ISignatureUtils} from "@eigenlayer/core/interfaces/ISignatureUtils.sol";
import {IAVSDirectory} from "@eigenlayer/core/interfaces/IAVSDirectory.sol";

import {ECDSAStakeRegistry} from "@eigenlayer/middleware/unaudited/ECDSAStakeRegistry.sol";
import {IServiceManager} from "@eigenlayer/middleware/interfaces/IServiceManager.sol";

contract HyperlaneServiceManager is IServiceManager, OwnableUpgradeable {
    ECDSAStakeRegistry internal immutable stakeRegistry;
    IAVSDirectory internal immutable elAvsDirectory;

    /// @notice when applied to a function, only allows the ECDSAStakeRegistry to call it
    modifier onlyStakeRegistry() {
        require(
            msg.sender == address(stakeRegistry),
            "HyperlaneServiceManager: caller is not the stake registry"
        );
        _;
    }

    // ============ Constructor ============

    constructor(
        IAVSDirectory _avsDirectory,
        ECDSAStakeRegistry _stakeRegistry
    ) {
        elAvsDirectory = _avsDirectory;
        stakeRegistry = _stakeRegistry;
        _disableInitializers();
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
    }

    /**
     * @notice Forwards a call to EigenLayer's AVSDirectory contract to confirm operator deregistration from the AVS
     * @param operator The address of the operator to deregister.
     */
    function deregisterOperatorFromAVS(
        address operator
    ) public virtual onlyStakeRegistry {
        elAvsDirectory.deregisterOperatorFromAVS(operator);
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

    /// @notice Returns the EigenLayer AVSDirectory contract.
    function avsDirectory() external view override returns (address) {
        return address(elAvsDirectory);
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
