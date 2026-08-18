// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {HyperliquidCoreWriter} from "../../contracts/libs/HyperliquidCoreWriter.sol";

contract HyperliquidCoreWriterTest is Test {
    address constant DESTINATION =
        address(0x2000000000000000000000000000000000000000);
    address constant SUB_ACCOUNT = address(0x1234);
    uint64 constant TOKEN = 0;
    uint64 constant AMOUNT = 1_000_000;

    function test_formatSpotSend() public pure {
        bytes memory encoded = HyperliquidCoreWriter.formatSpotSend(
            DESTINATION,
            TOKEN,
            AMOUNT
        );

        assertEq(
            encoded,
            abi.encodePacked(
                hex"01000006",
                abi.encode(DESTINATION, TOKEN, AMOUNT)
            )
        );
    }

    function test_formatSendAsset() public pure {
        bytes memory encoded = HyperliquidCoreWriter.formatSendAsset(
            DESTINATION,
            SUB_ACCOUNT,
            type(uint32).max,
            0,
            TOKEN,
            AMOUNT
        );

        assertEq(
            encoded,
            abi.encodePacked(
                hex"0100000d",
                abi.encode(
                    DESTINATION,
                    SUB_ACCOUNT,
                    uint32(type(uint32).max),
                    uint32(0),
                    TOKEN,
                    AMOUNT
                )
            )
        );
    }
}
