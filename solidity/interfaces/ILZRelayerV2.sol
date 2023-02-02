// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface ILZRelayerV2 {
    struct DstPrice {
        uint128 dstPriceRatio; // 10^10
        uint128 dstGasPriceInWei;
    }

    function dstPriceLookup(uint16) external view returns (DstPrice memory);
}
