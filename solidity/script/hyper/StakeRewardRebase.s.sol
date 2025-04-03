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
import {IStakerRewards} from "../../contracts/interfaces/network/rewards/IStakerRewards.sol";

import "forge-std/StdCheats.sol";

contract StakeRewardRebase is Script, StdCheats {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    string STAKE_RPC_URL = vm.envString("STAKE_RPC_URL");
    string REBASE_RPC_URL = vm.envString("REBASE_RPC_URL");

    address STAKED_WARP_ROUTE_ADDRESS =
        vm.envAddress("STAKED_WARP_ROUTE_ADDRESS");

    uint256 stakeFork;
    uint32 stakeDomainId;
    HyperToken public collateral;
    HypERC4626Collateral public stakedCollateral;
    IVault public vault;
    IStakerRewards public rewards;
    ICompoundStakerRewards compoundStakerRewards;

    uint256 rebaseFork;
    uint32 rebaseDomainId;
    HypERC20 public synthetic;
    HypERC4626 public rebasingSynthetic;

    uint256 BALANCE = 1_000_000e18; // 1 million tokens, adjust decimals as needed

    function setUp() public {
        stakeFork = vm.createSelectFork(STAKE_RPC_URL);
        stakedCollateral = HypERC4626Collateral(STAKED_WARP_ROUTE_ADDRESS);
        compoundStakerRewards = ICompoundStakerRewards(
            address(stakedCollateral.vault())
        );
        rewards = compoundStakerRewards.rewards();
        vault = compoundStakerRewards.vault();

        collateral = HyperToken(vault.collateral());
        deal(
            address(collateral),
            address(this), // sender
            BALANCE
        );

        stakeDomainId = collateral.localDomain();
        address stakeMailbox = address(collateral.mailbox());
        vm.etch(stakeMailbox, address(new MockMailbox(stakeDomainId)).code);

        rebaseFork = vm.createSelectFork(REBASE_RPC_URL);
        rebaseDomainId = uint32(block.chainid);

        vm.selectFork(stakeFork);
        synthetic = HypERC20(
            collateral.routers(rebaseDomainId).bytes32ToAddress()
        );
        rebasingSynthetic = HypERC4626(
            stakedCollateral.routers(rebaseDomainId).bytes32ToAddress()
        );

        vm.selectFork(rebaseFork);
        address rebaseMailbox = address(synthetic.mailbox());
        vm.etch(rebaseMailbox, address(new MockMailbox(rebaseDomainId)).code);
        MockMailbox(rebaseMailbox).addRemoteMailbox(
            stakeDomainId,
            MockMailbox(stakeMailbox)
        );
        vm.makePersistent(rebaseMailbox);

        vm.selectFork(stakeFork);
        MockMailbox(stakeMailbox).addRemoteMailbox(
            rebaseDomainId,
            MockMailbox(rebaseMailbox)
        );
        vm.makePersistent(stakeMailbox);
    }

    function run() external {
        uint256 transferAmount = 1000;

        vm.selectFork(stakeFork);
        uint256 fee = collateral.quoteGasPayment(rebaseDomainId);
        vm.deal(address(this), fee);
        collateral.transferRemote{value: fee}(
            rebaseDomainId,
            msg.sender.addressToBytes32(),
            transferAmount
        );

        vm.selectFork(rebaseFork);
        MockMailbox(address(synthetic.mailbox())).handleNextInboundMessage();
        assert(synthetic.balanceOf(msg.sender) == transferAmount);

        vm.selectFork(stakeFork);
        uint256 stakeAmount = 2000;
        collateral.approve(address(vault), stakeAmount);
        vault.deposit(address(this), stakeAmount);

        IERC20(address(vault)).approve(address(stakedCollateral), stakeAmount);
        fee = stakedCollateral.quoteGasPayment(rebaseDomainId);
        vm.deal(address(this), fee);
        stakedCollateral.transferRemote{value: fee}(
            rebaseDomainId,
            msg.sender.addressToBytes32(), // recipient
            stakeAmount
        );

        vm.selectFork(rebaseFork);
        MockMailbox(address(rebasingSynthetic.mailbox()))
            .handleNextInboundMessage();
        assert(rebasingSynthetic.balanceOf(msg.sender) == stakeAmount);

        // address network = address(this);

        // TODO:
        // uint256 rewardAmount = 3000;
        // rewards.distributeRewards(
        //     network,
        //     address(collateral),
        //     rewardAmount,
        //     abi.encode(uint48(block.timestamp), 0)
        // );
        // 1. distribute staking rewards
        // 2. compound rewards
        // 3. rebase the synthetic token
        // 4. assert the balance has increased
    }
}
