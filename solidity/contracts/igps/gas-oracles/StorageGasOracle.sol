// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IGasOracle} from "../../interfaces/IGasOracle.sol";
// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @notice A gas oracle that uses data stored within the contract.
 * @dev This contract is intended to be owned by an address that will
 * update the stored remote gas data.
 */
contract StorageGasOracle is IGasOracle, Ownable {
    // ============ Public Storage ============

    /// @notice Keyed by remote domain, gas data on that remote domain.
    mapping(uint32 => IGasOracle.RemoteGasData) public remoteGasData;

    // ============ Events ============

    /**
     * @notice Emitted when an entry in `remoteGasData` is set.
     * @param remoteDomain The remote domain in which the gas data was set for.
     * @param tokenExchangeRate The exchange rate of the remote native token quoted in the local native token.
     * @param gasPrice The gas price on the remote chain.
     */
    event RemoteGasDataSet(
        uint32 indexed remoteDomain,
        uint128 tokenExchangeRate,
        uint128 gasPrice
    );

    struct RemoteGasDataConfig {
        uint32 remoteDomain;
        uint128 tokenExchangeRate;
        uint128 gasPrice;
    }

    // ============ External Functions ============

    /**
     * @notice Returns the stored `remoteGasData` for the `_destinationDomain`.
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
        // Intentionally allow unset / zero values
        IGasOracle.RemoteGasData memory _data = remoteGasData[
            _destinationDomain
        ];
        return (_data.tokenExchangeRate, _data.gasPrice);
    }

    /**
     * @notice Sets the remote gas data for many remotes at a time.
     * @param _configs The configs to use when setting the remote gas data.
     */
    function setRemoteGasDataConfigs(RemoteGasDataConfig[] calldata _configs)
        external
        onlyOwner
    {
        uint256 _len = _configs.length;
        for (uint256 i = 0; i < _len; i++) {
            _setRemoteGasData(_configs[i]);
        }
    }

    /**
     * @notice Sets the remote gas data using the values in `_config`.
     * @param _config The config to use when setting the remote gas data.
     */
    function setRemoteGasData(RemoteGasDataConfig calldata _config)
        external
        onlyOwner
    {
        _setRemoteGasData(_config);
    }

    // ============ Internal functions ============

    /**
     * @notice Sets the remote gas data using the values in `_config`.
     * @param _config The config to use when setting the remote gas data.
     */
    function _setRemoteGasData(RemoteGasDataConfig calldata _config) internal {
        remoteGasData[_config.remoteDomain] = IGasOracle.RemoteGasData({
            tokenExchangeRate: _config.tokenExchangeRate,
            gasPrice: _config.gasPrice
        });

        emit RemoteGasDataSet(
            _config.remoteDomain,
            _config.tokenExchangeRate,
            _config.gasPrice
        );
    }
}
