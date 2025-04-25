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
    IDefaultStakerRewards public rewards;
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
        rewards = IDefaultStakerRewards(
            address(compoundStakerRewards.rewards())
        );
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
        uint256 transferAmount = 1e15;

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
        uint256 stakeAmount = 2e15;
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

        vm.selectFork(stakeFork);
        INetworkMiddlewareService middlewareService = INetworkMiddlewareService(
            rewards.NETWORK_MIDDLEWARE_SERVICE()
        );

        INetworkRegistry(middlewareService.NETWORK_REGISTRY())
            .registerNetwork();
        address network = address(this);
        middlewareService.setMiddleware(network);

        uint256 rewardAmount = 3e15;
        collateral.approve(address(rewards), rewardAmount);

        // 1. distribute rewards
        uint48 timestamp = uint48(block.timestamp - 1);
        rewards.distributeRewards(
            network,
            address(collateral),
            rewardAmount,
            abi.encode(timestamp, 0, bytes(""), bytes(""))
        );

        // 2. compound rewards
        compoundStakerRewards.compound(network, 1);

        // 3. rebase the synthetic token
        vm.deal(address(this), fee);
        stakedCollateral.rebase{value: fee}(
            rebaseDomainId,
            bytes(""),
            address(0)
        );

        // 4. assert the balance has increased
        vm.selectFork(rebaseFork);
        MockMailbox(address(rebasingSynthetic.mailbox()))
            .handleNextInboundMessage();

        uint256 newBalance = rebasingSynthetic.balanceOf(msg.sender);
        require(newBalance > stakeAmount, "Rebase did not increase balance");
    }
}
