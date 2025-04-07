// SPDX-License-Identifier: MIT
pragma solidity ^0.8.12;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ECDSAStakeRegistry} from "../../contracts/avs/ECDSAStakeRegistry.sol";
import {HyperlaneServiceManager} from "../../contracts/avs/HyperlaneServiceManager.sol";
import {IStrategy, IStrategyFactory} from "../../contracts/interfaces/avs/vendored/IStrategy.sol";
import {IDelegationManager} from "../../contracts/interfaces/avs/vendored/IDelegationManager.sol";
import "../../contracts/interfaces/avs/vendored/ISignatureUtils.sol";
import {Quorum, StrategyParams} from "../../contracts/interfaces/avs/vendored/IECDSAStakeRegistryEventsAndErrors.sol";

contract REZAdditionTest is Test {
    string MAINNET_RPC_URL = "https://eth.llamarpc.com";
    uint256 FORK_BLOCK_NUMBER = 21061545;

    address AW_SAFE = 0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba;
    address BITGET_6 = 0x1AB4973a48dc892Cd9971ECE8e01DcC7688f8F23;
    address PIER2 = 0x5dCdf02a7188257b7c37dD3158756dA9Ccd4A9Cb;

    ECDSAStakeRegistry stakeRegistry =
        ECDSAStakeRegistry(0x272CF0BB70D3B4f79414E0823B426d2EaFd48910);
    IDelegationManager delegationManager =
        IDelegationManager(0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A);
    HyperlaneServiceManager serviceManager =
        HyperlaneServiceManager(0xe8E59c6C8B56F2c178f63BCFC4ce5e5e2359c8fc);
    IERC20 rezToken = IERC20(0x3B50805453023a91a8bf641e279401a0b23FA6F9);
    IStrategyFactory strategyFactory =
        IStrategyFactory(0x5e4C39Ad7A3E881585e383dB9827EB4811f6F647);

    function setUp() public {
        vm.createSelectFork(MAINNET_RPC_URL, FORK_BLOCK_NUMBER);
    }

    function testFork_addREZStrategy() external {
        vm.startPrank(AW_SAFE);

        // STEP 1: update the stakeRegistry quorum with the new REZ strategy and adjust the weights accordingly to sum up to 10_000
        IStrategy rezStrategy = strategyFactory.deployedStrategies(rezToken);
        require(address(rezStrategy).code.length > 0, "Strategy not deployed");
        _setQuorum(rezStrategy);

        address[] memory restakeableStrategies = serviceManager
            .getRestakeableStrategies();

        bool rezStrategyFound = false;
        for (uint256 i = 0; i < restakeableStrategies.length; i++) {
            if (restakeableStrategies[i] == address(rezStrategy)) {
                rezStrategyFound = true;
            }
        }
        require(
            rezStrategyFound,
            "REZ strategy not found in total restakeable strategies"
        );

        // STEP 2: check if a staker's REZ deposit gets accounted for
        uint256 amountToStake = rezToken.balanceOf(BITGET_6);

        IStrategy[] memory strategiesToQuery = new IStrategy[](1);
        strategiesToQuery[0] = rezStrategy;
        uint256 sharesBefore = delegationManager.getOperatorShares(
            PIER2,
            strategiesToQuery
        )[0];

        // compute the storage slot
        address[] memory operatorStrategies1 = serviceManager
            .getOperatorRestakedStrategies(PIER2);

        // directly update the operator shares instead of calling delegationManager.delegateTo()
        bytes32 operatorSharesSlot = keccak256(
            abi.encode(
                address(rezStrategy),
                keccak256(abi.encode(PIER2, bytes32(uint256(152))))
            )
        );
        vm.store(
            address(delegationManager),
            operatorSharesSlot,
            bytes32(amountToStake)
        );

        uint256 sharesAfter = delegationManager.getOperatorShares(
            PIER2,
            strategiesToQuery
        )[0];
        assertEq(sharesAfter, sharesBefore + amountToStake);

        address[] memory operatorStrategies = serviceManager
            .getOperatorRestakedStrategies(PIER2);

        rezStrategyFound = false;
        for (uint256 i = 0; i < operatorStrategies.length; i++) {
            if (operatorStrategies[i] == address(rezStrategy)) {
                rezStrategyFound = true;
            }
        }
        require(
            rezStrategyFound,
            "REZ strategy not found in operator restaked strategies"
        );

        vm.stopPrank();
    }

    function _setQuorum(IStrategy rezStrategy) internal {
        // get current quorum
        Quorum memory currentQuorum = stakeRegistry.quorum();
        Quorum memory newQuorum;
        newQuorum.strategies = new StrategyParams[](
            currentQuorum.strategies.length + 1
        );

        uint256 totalStrategies = newQuorum.strategies.length;
        // split the 10000 base multiplier evenly
        uint96 baseMultiplier = uint96(10000 / totalStrategies);

        uint96 remainder = 10000 % uint96(totalStrategies);

        for (uint256 i = 0; i < currentQuorum.strategies.length; i++) {
            newQuorum.strategies[i] = currentQuorum.strategies[i];
            newQuorum.strategies[i].multiplier = baseMultiplier;
        }

        // add the remainder to the last strategy
        newQuorum.strategies[newQuorum.strategies.length - 1] = StrategyParams({
            strategy: rezStrategy,
            multiplier: baseMultiplier + remainder
        });

        console.log("REZ Strategy: ", address(rezStrategy));
        console.log("REZ Strategy Multiplier: ", baseMultiplier + remainder);

        // add strategy to quorum
        stakeRegistry.updateQuorumConfig(newQuorum, new address[](0));
    }
}
