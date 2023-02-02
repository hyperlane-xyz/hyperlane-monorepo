// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IGasOracle {
    struct RemoteGasData {
        uint128 tokenExchangeRate; // 10^10
        uint128 gasPrice;
    }

    function getExchangeRateAndGasPrice(uint32 _destinationDomain)
        external
        view
        returns (uint128 tokenExchangeRate, uint128 gasPrice);
}
