// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {HyperToken} from "../../contracts/token/extensions/HyperToken.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {HypERC4626Collateral} from "../../contracts/token/extensions/HypERC4626Collateral.sol";
import {HypERC4626} from "../../contracts/token/extensions/HypERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {IVault} from "../../contracts/interfaces/network/vault/IVault.sol";
import {ICompoundStakerRewards} from "../../contracts/interfaces/network/rewards/ICompoundStakerRewards.sol";
import {IDefaultStakerRewards} from "../../contracts/interfaces/network/rewards/IDefaultStakerRewards.sol";
import {INetworkMiddlewareService} from "../../contracts/interfaces/network/service/INetworkMiddlewareService.sol";
import {INetworkRegistry} from "../../contracts/interfaces/network/INetworkRegistry.sol";

import "forge-std/StdCheats.sol";

contract MerkleDistributor is Script, StdCheats {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

    string STAKE_RPC_URL = vm.envString("STAKE_RPC_URL");
    string DISTRIBUTION_RPC_URL = vm.envString("DISTRIBUTION_RPC_URL");

    uint256 HYPER_AMOUNT = vm.envUint("HYPER_AMOUNT");
    uint256 STAKED_HYPER_AMOUNT = vm.envUint("STAKED_HYPER_AMOUNT");

    address HYPER_MERKLE_DISTRIBUTOR =
        vm.envAddress("HYPER_MERKLE_DISTRIBUTOR");
    address STAKED_HYPER_MERKLE_DISTRIBUTOR =
        vm.envAddress("STAKED_HYPER_MERKLE_DISTRIBUTOR");

    address STAKED_WARP_ROUTE_ADDRESS =
        vm.envAddress("STAKED_WARP_ROUTE_ADDRESS");

    uint256 stakeFork;
    uint32 stakeDomainId;
    HyperToken public collateral;
    HypERC4626Collateral public stakedCollateral;
    IVault public vault;
    IDefaultStakerRewards public rewards;
    ICompoundStakerRewards compoundStakerRewards;

    uint256 distributionFork;
    uint32 distributionDomainId;

    // HypERC20 public synthetic;
    // HypERC4626 public rebasingSynthetic;

    function setUp() public {
        stakeFork = vm.createSelectFork(STAKE_RPC_URL);
        stakedCollateral = HypERC4626Collateral(STAKED_WARP_ROUTE_ADDRESS);
        compoundStakerRewards = ICompoundStakerRewards(
            address(stakedCollateral.vault())
        );
        rewards = IDefaultStakerRewards(
            address(compoundStakerRewards.rewards())
        );
        vault = compoundStakerRewards.vault();

        collateral = HyperToken(vault.collateral());
        // deal(
        //     address(collateral),
        //     address(this), // sender
        //     HYPER_AMOUNT + STAKED_HYPER_AMOUNT
        // );

        stakeDomainId = collateral.localDomain();
        // address stakeMailbox = address(collateral.mailbox());
        // vm.etch(stakeMailbox, address(new MockMailbox(stakeDomainId)).code);

        distributionFork = vm.createSelectFork(DISTRIBUTION_RPC_URL);
        distributionDomainId = uint32(block.chainid);

        // vm.selectFork(stakeFork);
        // synthetic = HypERC20(
        //     collateral.routers(distributionDomainId).bytes32ToAddress()
        // );
        // rebasingSynthetic = HypERC4626(
        //     stakedCollateral.routers(distributionDomainId).bytes32ToAddress()
        // );

        // vm.selectFork(distributionFork);
        // address distributionMailbox = address(synthetic.mailbox());
        // vm.etch(
        //     distributionMailbox,
        //     address(new MockMailbox(distributionDomainId)).code
        // );
        // MockMailbox(distributionMailbox).addRemoteMailbox(
        //     stakeDomainId,
        //     MockMailbox(stakeMailbox)
        // );
        // vm.makePersistent(distributionMailbox);

        // vm.selectFork(stakeFork);
        // MockMailbox(stakeMailbox).addRemoteMailbox(
        //     distributionDomainId,
        //     MockMailbox(distributionMailbox)
        // );
        // vm.makePersistent(stakeMailbox);
    }

    function run() external {
        address deployer = vm.addr(deployerPrivateKey);

        vm.selectFork(stakeFork);

        uint256 fee = collateral.quoteGasPayment(distributionDomainId);
        vm.startBroadcast(deployerPrivateKey);

        collateral.transferRemote{value: fee}(
            distributionDomainId,
            HYPER_MERKLE_DISTRIBUTOR.addressToBytes32(),
            HYPER_AMOUNT
        );

        if (STAKED_HYPER_AMOUNT == 0) {
            return;
        }

        uint256 stakeAmount = STAKED_HYPER_AMOUNT;
        collateral.approve(address(vault), stakeAmount);
        vault.deposit(deployer, stakeAmount);

        IERC20(address(vault)).approve(address(stakedCollateral), stakeAmount);
        fee = stakedCollateral.quoteGasPayment(distributionDomainId);

        // vm.deal(address(this), fee);
        stakedCollateral.transferRemote{value: fee}(
            distributionDomainId,
            STAKED_HYPER_MERKLE_DISTRIBUTOR.addressToBytes32(),
            STAKED_HYPER_AMOUNT
        );
    }
}
