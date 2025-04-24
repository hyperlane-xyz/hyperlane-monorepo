// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";
import "forge-std/StdAssertions.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {HyperToken} from "../../contracts/token/extensions/HyperToken.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {HypERC4626Collateral} from "../../contracts/token/extensions/HypERC4626Collateral.sol";
import {HypERC4626} from "../../contracts/token/extensions/HypERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MailboxClient} from "../../contracts/client/MailboxClient.sol";

import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {IVault} from "../../contracts/interfaces/network/vault/IVault.sol";
import {ICompoundStakerRewards} from "../../contracts/interfaces/network/rewards/ICompoundStakerRewards.sol";
import {IDefaultStakerRewards} from "../../contracts/interfaces/network/rewards/IDefaultStakerRewards.sol";
import {INetworkMiddlewareService} from "../../contracts/interfaces/network/service/INetworkMiddlewareService.sol";
import {INetworkRegistry} from "../../contracts/interfaces/network/INetworkRegistry.sol";

import {VmSafe} from "forge-std/Vm.sol";

import "forge-std/StdCheats.sol";

contract DistributeTokens is Script, StdCheats, StdAssertions {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    string STAKE_RPC_URL = vm.envString("STAKE_RPC_URL");
    string DISTRIBUTION_RPC_URL = vm.envString("DISTRIBUTION_RPC_URL");

    address HYPER_RECIPIENT = vm.envAddress("HYPER_RECIPIENT");
    address STAKED_HYPER_RECIPIENT = vm.envAddress("STAKED_HYPER_RECIPIENT");

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
    uint32 distDomainId;
    IERC20 public distributionHyper;
    IERC20 public distributionStakedHyper;

    uint256 distributeHyperAmount;
    uint256 distributeStakedHyperAmount;

    bool hasStaked;

    function setUp() public {
        uint256 HYPER_AMOUNT = vm.envUint("HYPER_AMOUNT");
        uint256 STAKED_HYPER_AMOUNT = vm.envUint("STAKED_HYPER_AMOUNT");

        hasStaked = STAKED_HYPER_AMOUNT > 0;

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

        stakeDomainId = collateral.localDomain();

        if (
            keccak256(abi.encodePacked(STAKE_RPC_URL)) ==
            keccak256(abi.encodePacked(DISTRIBUTION_RPC_URL))
        ) {
            distributionFork = stakeFork;
            distDomainId = stakeDomainId;
        } else {
            distributionFork = vm.createSelectFork(DISTRIBUTION_RPC_URL);
            distDomainId = uint32(block.chainid);
        }

        require(
            HYPER_RECIPIENT.code.length > 0,
            "hyper recipient not a contract"
        );
        if (hasStaked) {
            require(
                STAKED_HYPER_RECIPIENT.code.length > 0,
                "staked hyper recipient not a contract"
            );
        }

        vm.selectFork(stakeFork);
        if (distDomainId != stakeDomainId) {
            distributionHyper = IERC20(
                collateral.routers(distDomainId).bytes32ToAddress()
            );
            distributionStakedHyper = IERC20(
                stakedCollateral.routers(distDomainId).bytes32ToAddress()
            );

            // mock mailboxes if we are in a dry run context
            if (vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) {
                address stakeMailbox = address(collateral.mailbox());
                vm.etch(
                    stakeMailbox,
                    address(new MockMailbox(stakeDomainId)).code
                );
                vm.makePersistent(stakeMailbox);

                vm.selectFork(distributionFork);
                address distMailbox = address(
                    MailboxClient(address(distributionHyper)).mailbox()
                );
                vm.etch(
                    distMailbox,
                    address(new MockMailbox(distDomainId)).code
                );

                vm.makePersistent(distMailbox);
                MockMailbox(distMailbox).addRemoteMailbox(
                    stakeDomainId,
                    MockMailbox(stakeMailbox)
                );

                vm.selectFork(stakeFork);
                MockMailbox(stakeMailbox).addRemoteMailbox(
                    distDomainId,
                    MockMailbox(distMailbox)
                );
            }
        } else {
            distributionHyper = IERC20(address(collateral));
            distributionStakedHyper = IERC20(address(vault));
        }

        (
            uint256 hyperBalance,
            uint256 stakedHyperBalance
        ) = getDistributionBalances();

        distributeHyperAmount = HYPER_AMOUNT - hyperBalance;
        distributeStakedHyperAmount = STAKED_HYPER_AMOUNT - stakedHyperBalance;
    }

    function getDistributionBalances()
        internal
        returns (uint256 hyperBalance, uint256 stakedHyperBalance)
    {
        vm.selectFork(distributionFork);
        hyperBalance = distributionHyper.balanceOf(HYPER_RECIPIENT);
        if (hasStaked) {
            stakedHyperBalance = distributionStakedHyper.balanceOf(
                STAKED_HYPER_RECIPIENT
            );
        }
    }

    function run() external {
        address sender = tx.origin;

        vm.selectFork(stakeFork);

        vm.startBroadcast(sender);

        if (distributeHyperAmount != 0) {
            if (stakeDomainId != distDomainId) {
                uint256 fee = collateral.quoteGasPayment(distDomainId);
                collateral.transferRemote{value: fee}(
                    distDomainId,
                    HYPER_RECIPIENT.addressToBytes32(),
                    distributeHyperAmount
                );
            } else {
                collateral.transfer(HYPER_RECIPIENT, distributeHyperAmount);
            }
        }

        if (distributeStakedHyperAmount != 0) {
            collateral.approve(address(vault), distributeStakedHyperAmount);
            vault.deposit(sender, distributeStakedHyperAmount);

            if (stakeDomainId != distDomainId) {
                IERC20(address(vault)).approve(
                    address(stakedCollateral),
                    distributeStakedHyperAmount
                );
                uint256 fee = stakedCollateral.quoteGasPayment(distDomainId);
                stakedCollateral.transferRemote{value: fee}(
                    distDomainId,
                    STAKED_HYPER_RECIPIENT.addressToBytes32(),
                    distributeStakedHyperAmount
                );
            } else {
                IERC20(address(vault)).transfer(
                    STAKED_HYPER_RECIPIENT,
                    distributeStakedHyperAmount
                );
            }
        }

        vm.stopBroadcast();

        if (vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) {
            if (stakeDomainId != distDomainId) {
                vm.selectFork(distributionFork);
                MockMailbox(
                    address(MailboxClient(address(distributionHyper)).mailbox())
                ).handleAllInboundMessages();
            }

            (
                uint256 hyperBalance,
                uint256 stakedHyperBalance
            ) = getDistributionBalances();
            require(
                hyperBalance == distributeHyperAmount,
                "hyper balance mismatch"
            );

            assertApproxEqRelDecimal(
                stakedHyperBalance,
                distributeStakedHyperAmount,
                1e14,
                0
            );
            // require(
            //     stakedHyperBalance == distributeStakedHyperAmount,
            //     "staked hyper balance mismatch"
            // );
        }
    }
}
