// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.7.6;

interface ILZRelayerV2 {
    struct DstPrice {
        uint128 dstPriceRatio; // 10^10
        uint128 dstGasPriceInWei;
    }

    // todo why?
    function dstPriceLookup(uint16)
        external
        view
        returns (uint128 dstPriceRatio, uint128 dstGasPriceInWei);
}
