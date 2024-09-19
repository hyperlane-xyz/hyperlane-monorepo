// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {HyperlaneForkTest} from "../../contracts/test/HyperlaneForkTest.sol";

import {IERC20, IXERC20} from "../../contracts/token/interfaces/IXERC20.sol";
import {HypXERC20} from "../../contracts/token/extensions/HypXERC20.sol";
import {HypXERC20Lockbox} from "../../contracts/token/extensions/HypXERC20Lockbox.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";

contract RenzoE2ETest is HyperlaneForkTest {
    using TypeCasts for address;

    uint32 mainnetDomain = 1;
    uint32 optimismDomain = 10;
    uint32 blastDomain = 81457;

    // Mainnet
    IERC20 internal mainnetERC20 =
        IERC20(0xbf5495Efe5DB9ce00f80364C8B423567e58d2110);
    HypXERC20Lockbox internal hypXERC20Lockbox =
        HypXERC20Lockbox(0xC59336D8edDa9722B4f1Ec104007191Ec16f7087);
    // Optimism
    IXERC20 internal optimismXERC20 =
        IXERC20(0x2416092f143378750bb29b79eD961ab195CcEea5);
    HypXERC20 internal optimismHypXERC20 =
        HypXERC20(0xacEB607CdF59EB8022Cc0699eEF3eCF246d149e2);
    // Blast
    IXERC20 internal blastXERC20 =
        IXERC20(0x2416092f143378750bb29b79eD961ab195CcEea5);
    HypXERC20 internal blastHypXERC20 =
        HypXERC20(0x486b39378f99f073A3043C6Aabe8666876A8F3C5);

    uint256 internal mainnetFork;
    uint256 internal optimismFork;
    uint256 internal blastFork;

    address internal bob = makeAddr("bob");
    address internal alice = makeAddr("alice");
    uint256 internal amount = 100;

    function setUp() public {
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"), 20574589);
        optimismFork = vm.createFork(vm.rpcUrl("optimism"), 124307767);
        blastFork = vm.createFork(vm.rpcUrl("blast"), 7702248);
        setUpMailbox(mainnetFork);
        mockIsm(address(hypXERC20Lockbox.interchainSecurityModule()), true);
        setUpMailbox(optimismFork);
        mockIsm(address(optimismHypXERC20.interchainSecurityModule()), true);
        setUpMailbox(blastFork);
        mockIsm(address(blastHypXERC20.interchainSecurityModule()), true);
    }

    function testTransferRemoteMainnetToOptimism() public {
        vm.selectFork(mainnetFork);
        deal(address(mainnetERC20), bob, amount);

        vm.startPrank(bob);
        mainnetERC20.approve(address(hypXERC20Lockbox), amount);
        hypXERC20Lockbox.transferRemote(
            optimismDomain,
            alice.addressToBytes32(),
            amount
        );
        vm.stopPrank();
        assertEq(mainnetERC20.balanceOf(bob), 0);

        processNextInboundMessage(mainnetDomain, optimismDomain);
        assertEq(optimismXERC20.balanceOf(alice), amount);
    }

    function testTransferRemoteOptimismToMainnet() public {
        vm.selectFork(optimismFork);
        deal(address(optimismXERC20), alice, amount);

        vm.startPrank(alice);
        optimismXERC20.approve(address(optimismHypXERC20), amount);
        optimismHypXERC20.transferRemote(
            mainnetDomain,
            bob.addressToBytes32(),
            amount
        );
        vm.stopPrank();
        assertEq(optimismXERC20.balanceOf(alice), 0);

        processNextInboundMessage(optimismDomain, mainnetDomain);
        assertEq(mainnetERC20.balanceOf(bob), amount);
    }

    function testTransferRemoteOptimismToBlast() public {
        vm.selectFork(optimismFork);
        deal(address(optimismXERC20), alice, amount);

        vm.startPrank(alice);
        optimismXERC20.approve(address(optimismHypXERC20), amount);
        optimismHypXERC20.transferRemote(
            blastDomain,
            bob.addressToBytes32(),
            amount
        );
        vm.stopPrank();
        assertEq(optimismXERC20.balanceOf(alice), 0);

        processNextInboundMessage(optimismDomain, blastDomain);
        assertEq(blastXERC20.balanceOf(bob), amount);
    }

    /// @notice Workspace dependencies are hoisted to the monorepo node_modules so we need to
    ///         override the registry location. Most projects will just use the default.
    function _registryUri() internal view override returns (string memory) {
        return
            string.concat(
                vm.projectRoot(),
                "/../node_modules/@hyperlane-xyz/registry"
            );
    }
}
