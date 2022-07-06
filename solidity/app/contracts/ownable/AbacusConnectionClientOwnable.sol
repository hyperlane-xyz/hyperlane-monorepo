// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {AbacusConnectionClient} from "../AbacusConnectionClient.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract AbacusConnectionClientOwnable is AbacusConnectionClient, Ownable {
    constructor(
        address _abacusConnectionManager,
        address _interchainGasPaymaster
    ) Ownable() {
        _setAbacusConnectionManager(_abacusConnectionManager);
        _setInterchainGasPaymaster(_interchainGasPaymaster);
    }

    // ============ External functions ============

    /**
     * @notice Sets the address of the application's AbacusConnectionManager.
     * @param _abacusConnectionManager The address of the AbacusConnectionManager contract.
     */
    function setAbacusConnectionManager(address _abacusConnectionManager)
        external
        virtual
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
        virtual
        onlyOwner
    {
        _setInterchainGasPaymaster(_interchainGasPaymaster);
    }
}
