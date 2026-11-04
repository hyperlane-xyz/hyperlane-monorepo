// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Test} from "forge-std/Test.sol";
import {PiggyBankIGP} from "../../contracts/hooks/igp/PiggyBankIGP.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";

contract MockIGP is IPostDispatchHook {
    uint256 public feeQuote;
    uint256 public feesCollected;

    function setFeeQuote(uint256 _fee) external {
        feeQuote = _fee;
    }

    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.INTERCHAIN_GAS_PAYMASTER);
    }

    function supportsMetadata(bytes calldata) external pure override returns (bool) {
        return true;
    }

    function postDispatch(bytes calldata, bytes calldata) external payable override {
        require(msg.value == feeQuote, "MockIGP: invalid fee");
        feesCollected += msg.value;
    }

    function quoteDispatch(bytes calldata, bytes calldata) external view override returns (uint256) {
        return feeQuote;
    }
}

contract PiggyBankIGPTest is Test {
    PiggyBankIGP piggyBank;
    MockIGP mockIGP;

    address sponsor = address(0x123);
    address senderContract = address(0x456);
    bytes32 senderBytes32;

    function setUp() public {
        mockIGP = new MockIGP();
        piggyBank = new PiggyBankIGP(mockIGP);
        senderBytes32 = TypeCasts.addressToBytes32(senderContract);
        vm.deal(sponsor, 100 ether);
    }

    function test_depositAndWithdraw() public {
        vm.startPrank(sponsor);
        piggyBank.deposit{value: 1 ether}();
        assertEq(piggyBank.sponsorBalances(sponsor), 1 ether);

        piggyBank.withdraw(0.5 ether);
        assertEq(piggyBank.sponsorBalances(sponsor), 0.5 ether);
        vm.stopPrank();
    }

    function test_setSponsor() public {
        vm.prank(sponsor);
        piggyBank.setSponsor(senderBytes32);
        assertEq(piggyBank.senderToSponsor(senderBytes32), sponsor);

        vm.prank(sponsor);
        piggyBank.unsetSponsor(senderBytes32);
        assertEq(piggyBank.senderToSponsor(senderBytes32), address(0));
    }

    function test_postDispatch_paysFee() public {
        vm.startPrank(sponsor);
        piggyBank.deposit{value: 1 ether}();
        piggyBank.setSponsor(senderBytes32);
        vm.stopPrank();

        mockIGP.setFeeQuote(0.1 ether);

        bytes memory message = abi.encodePacked(
            uint8(0), // version
            uint32(1), // nonce
            uint32(1), // origin
            senderBytes32, // sender
            uint32(2), // destination
            bytes32(0), // recipient
            bytes("hello") // body
        );

        // quoteDispatch should return 0
        uint256 quote = piggyBank.quoteDispatch(bytes(""), message);
        assertEq(quote, 0);

        // postDispatch
        piggyBank.postDispatch(bytes(""), message);

        assertEq(piggyBank.sponsorBalances(sponsor), 0.9 ether);
        assertEq(mockIGP.feesCollected(), 0.1 ether);
    }

    function test_postDispatch_revertsIfNoSponsor() public {
        bytes memory message = abi.encodePacked(
            uint8(0), uint32(1), uint32(1), senderBytes32, uint32(2), bytes32(0), bytes("hello")
        );
        vm.expectRevert("PiggyBankIGP: unconfigured sender");
        piggyBank.postDispatch(bytes(""), message);
    }

    function test_postDispatch_revertsIfInsufficientBalance() public {
        vm.startPrank(sponsor);
        piggyBank.deposit{value: 0.05 ether}();
        piggyBank.setSponsor(senderBytes32);
        vm.stopPrank();

        mockIGP.setFeeQuote(0.1 ether);

        bytes memory message = abi.encodePacked(
            uint8(0), uint32(1), uint32(1), senderBytes32, uint32(2), bytes32(0), bytes("hello")
        );

        vm.expectRevert("PiggyBankIGP: insufficient balance");
        piggyBank.postDispatch(bytes(""), message);
    }
}

    function test_withdraw_revertsIfInsufficientBalance() public {
        vm.startPrank(sponsor);
        piggyBank.deposit{value: 1 ether}();
        vm.expectRevert("PiggyBankIGP: insufficient balance");
        piggyBank.withdraw(2 ether);
        vm.stopPrank();
    }
