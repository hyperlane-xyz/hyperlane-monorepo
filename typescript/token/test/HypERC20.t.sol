// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {TokenRouter} from "../contracts/libs/TokenRouter.sol";
import {HypERC20} from "../contracts/HypERC20.sol";
import {HypERC20Collateral} from "../contracts/HypERC20Collateral.sol";
import {HypNative} from "../contracts/HypNative.sol";
import {ERC20Test} from "../contracts/test/ERC20Test.sol";
import {TestInterchainGasPaymaster} from "@hyperlane-xyz/core/contracts/test/TestInterchainGasPaymaster.sol";
import {TestMailbox} from "@hyperlane-xyz/core/contracts/test/TestMailbox.sol";

abstract contract HypTokenTest is Test {
    uint8 internal constant DECIMALS = 18;
    uint32 internal constant LOCAL_DOMAIN = 31337;
    address internal constant BOB = address(0x1); // bob the beneficiary
    string internal constant NAME = "HyperlaneInu";
    string internal constant SYMBOL = "HYP";
    uint256 internal constant TOTAL_SUPPLY = 1_000_000e18;

    TokenRouter internal hypToken;
    TestMailbox internal mailbox;
    TestInterchainGasPaymaster internal igp;
    ERC20Test internal externalToken;

    function setUp() public virtual {
        mailbox = new TestMailbox(LOCAL_DOMAIN);
        igp = new TestInterchainGasPaymaster(BOB);
        externalToken = new ERC20Test(NAME, SYMBOL, TOTAL_SUPPLY);
    }
}

contract HypERC20Test is HypTokenTest {
    function setUp() public override {
        super.setUp();
        hypToken = new HypERC20(DECIMALS);
        HypERC20(address(hypToken)).initialize(
            address(mailbox),
            address(igp),
            TOTAL_SUPPLY,
            NAME,
            SYMBOL
        );
    }

    function testInitialize() public {
        vm.expectRevert("Initializable: contract is already initialized");
        HypERC20(address(hypToken)).initialize(
            address(mailbox),
            address(igp),
            TOTAL_SUPPLY,
            NAME,
            SYMBOL
        );
    }

    function testBalance() public {
        assertEq(HypERC20(address(hypToken)).balanceOf(BOB), 0);
        assertEq(
            HypERC20(address(hypToken)).balanceOf(address(this)),
            TOTAL_SUPPLY
        );
    }
}

contract HypERC20CollateralTest is HypTokenTest {
    function setUp() public override {
        super.setUp();
        hypToken = new HypERC20Collateral(address(externalToken));
        HypERC20Collateral(address(hypToken)).initialize(
            address(mailbox),
            address(igp)
        );
    }

    function testInitialize() public {
        vm.expectRevert("Initializable: contract is already initialized");
        HypERC20Collateral(address(hypToken)).initialize(
            address(mailbox),
            address(igp)
        );
    }
}

contract HypNativeTest is HypTokenTest {
    function setUp() public override {
        super.setUp();
        hypToken = new HypNative();
        HypNative(address(hypToken)).initialize(address(mailbox), address(igp));
    }

    function testInitialize() public {
        vm.expectRevert("Initializable: contract is already initialized");
        HypNative(address(hypToken)).initialize(address(mailbox), address(igp));
    }
}
