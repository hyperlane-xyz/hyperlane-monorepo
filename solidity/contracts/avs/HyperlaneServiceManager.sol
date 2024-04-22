// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {ISignatureUtils} from "@eigenlayer/core/interfaces/ISignatureUtils.sol";
import {IAVSDirectory} from "@eigenlayer/core/interfaces/IAVSDirectory.sol";

import {IStakeRegistry} from "@eigenlayer/middleware/interfaces/IStakeRegistry.sol";
import {IServiceManager} from "@eigenlayer/middleware/interfaces/IServiceManager.sol";

contract HyperlaneServiceManager is IServiceManager, OwnableUpgradeable {
    IStakeRegistry internal immutable stakeRegistry;
    IAVSDirectory internal immutable elAvsDirectory;

    /// @notice when applied to a function, only allows the ECDSAStakeRegistry to call it
    modifier onlyStakeRegistry() {
        require(
            msg.sender == address(stakeRegistry),
            "HyperlaneServiceManager: caller is not the stake registry"
        );
        _;
    }

    constructor(IAVSDirectory _avsDirectory, IStakeRegistry _stakeRegistry) {
        elAvsDirectory = _avsDirectory;
        stakeRegistry = _stakeRegistry;
        _disableInitializers();
    }

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
        // TODO
        return new address[](0);
    }

    function getOperatorRestakedStrategies(
        address operator
    ) external view returns (address[] memory) {
        // TODO
        return new address[](0);
    }

    /// @notice Returns the EigenLayer AVSDirectory contract.
    function avsDirectory() external view override returns (address) {
        return address(elAvsDirectory);
    }

    // storage gap for upgradeability
    // slither-disable-next-line shadowing-state
    uint256[50] private __GAP;
}
