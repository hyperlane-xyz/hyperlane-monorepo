// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IGasOracle} from "../../../interfaces/IGasOracle.sol";
// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title StaticGasOracle
 * @notice A gas oracle that returns the same configured gas data for any destination.
 */
contract StaticGasOracle is IGasOracle, Ownable {
    // ============ Public Storage ============

    /// @notice Configurable remote gas data.
    IGasOracle.RemoteGasData public remoteGasData;

    // ============ Events ============

    /**
     * @notice Emitted when `remoteGasData` is set.
     * @param tokenExchangeRate The exchange rate of the remote native token quoted in the local native token.
     * @param gasPrice The gas price on the remote chain.
     */
    event RemoteGasDataSet(uint128 tokenExchangeRate, uint128 gasPrice);

    // ============ Constructor ============

    /**
     * @param _owner The owner of the contract.
     * @param _remoteGasData Remote gas data to set `remoteGasData` to.
     */
    constructor(address _owner, IGasOracle.RemoteGasData memory _remoteGasData)
    {
        _transferOwnership(_owner);
        _setRemoteGasData(_remoteGasData);
    }

    // ============ External Functions ============

    /**
     * @notice Returns the configured `remoteGasData` regardless of the destination domain.
     * @param _destinationDomain The destination domain.
     * @return tokenExchangeRate The exchange rate of the remote native token quoted in the local native token.
     * @return gasPrice The gas price on the remote chain.
     */
    function getExchangeRateAndGasPrice(uint32 _destinationDomain)
        external
        view
        override
        returns (uint128 tokenExchangeRate, uint128 gasPrice)
    {
        // Unused
        _destinationDomain;

        IGasOracle.RemoteGasData memory _data = remoteGasData;
        return (_data.tokenExchangeRate, _data.gasPrice);
    }

    /**
     * @notice Sets `remoteGasData`.
     * @param _remoteGasData The new `remoteGasData`.
     */
    function setRemoteGasData(IGasOracle.RemoteGasData calldata _remoteGasData)
        external
        onlyOwner
    {
        _setRemoteGasData(_remoteGasData);
    }

    // ============ Internal functions ============

    /**
     * @notice Sets `remoteGasData`.
     * @param _remoteGasData The new `remoteGasData`.
     */
    function _setRemoteGasData(IGasOracle.RemoteGasData memory _remoteGasData)
        internal
    {
        remoteGasData = _remoteGasData;

        emit RemoteGasDataSet(
            _remoteGasData.tokenExchangeRate,
            _remoteGasData.gasPrice
        );
    }
}
