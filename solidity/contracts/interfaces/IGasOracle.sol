// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IGasOracle {
    struct RemoteGasData {
        // The exchange rate of the remote native token quoted in the local native token.
        // Scaled with 10 decimals, i.e. 1e10 is "one".
        uint128 tokenExchangeRate;
        uint128 gasPrice;
    }

    function getExchangeRateAndGasPrice(uint32 _destinationDomain)
        external
        view
        returns (uint128 tokenExchangeRate, uint128 gasPrice);
}
