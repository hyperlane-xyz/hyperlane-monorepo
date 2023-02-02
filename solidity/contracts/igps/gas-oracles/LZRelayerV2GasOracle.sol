// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IGasOracle} from "../../../interfaces/IGasOracle.sol";
import {ILZRelayerV2} from "../../../interfaces/ILZRelayerV2.sol";

contract LZRelayerV2GasOracle is IGasOracle {
    mapping(uint32 => uint16) public hyperlaneToLzDomain;

    ILZRelayerV2 public lzRelayer;

    function getExchangeRateAndGasPrice(uint32 _destinationDomain)
        external
        view
        override
        returns (uint128 tokenExchangeRate, uint128 gasPrice)
    {
        uint16 _lzDomain = hyperlaneToLzDomain[_destinationDomain];
        require(_lzDomain != uint16(0), "!lz domain");

        ILZRelayerV2.DstPrice memory _dstPrice = lzRelayer.dstPriceLookup(
            _lzDomain
        );
        return (_dstPrice.dstPriceRatio, _dstPrice.dstGasPriceInWei);
    }
}
