// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IGasOracle} from "../../../interfaces/IGasOracle.sol";

contract StorageGasOracle is IGasOracle {
    mapping(uint32 => IGasOracle.RemoteGasData) public remoteGasData;

    function getExchangeRateAndGasPrice(uint32 _destinationDomain)
        public
        view
        override
        returns (uint128 tokenExchangeRate, uint128 gasPrice)
    {
        IGasOracle.RemoteGasData memory _data = remoteGasData[
            _destinationDomain
        ];

        require(
            tokenExchangeRate != uint128(0) && gasPrice != uint128(0),
            "!remote gas data"
        );

        return (_data.tokenExchangeRate, _data.gasPrice);
    }
}
