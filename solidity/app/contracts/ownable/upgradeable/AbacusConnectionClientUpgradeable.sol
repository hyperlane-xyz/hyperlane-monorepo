// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

// ============ Internal Imports ============
import "../../AbacusConnectionClient.sol";

contract AbacusConnectionClientUpgradeable is
    AbacusConnectionClient,
    OwnableUpgradeable
{
    constructor() {
        _disableInitializers();
    }

    function __AbacusConnectionClient_init(
        address _abacusConnectionManager,
        address _interchainGasPaymaster
    ) internal onlyInitializing {
        _setAbacusConnectionManager(_abacusConnectionManager);
        _setInterchainGasPaymaster(_interchainGasPaymaster);
        __Ownable_init();
    }

    /**
     * @notice Sets the address of the application's AbacusConnectionManager.
     * @param _abacusConnectionManager The address of the AbacusConnectionManager contract.
     */
    function setAbacusConnectionManager(address _abacusConnectionManager)
        external
        onlyOwner
    {
        _setAbacusConnectionManager(_abacusConnectionManager);
    }

    /**
     * @notice Sets the address of the application's InterchainGasPaymaster.
     * @param _interchainGasPaymaster The address of the InterchainGasPaymaster contract.
     */
    function setInterchainGasPaymaster(address _interchainGasPaymaster)
        external
        onlyOwner
    {
        _setInterchainGasPaymaster(_interchainGasPaymaster);
    }
}
