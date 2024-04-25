// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/console.sol";

import {DelegationManager} from "@eigenlayer/core/DelegationManager.sol";
import {ISignatureUtils} from "@eigenlayer/interfaces/ISignatureUtils.sol";
import {IAVSDirectory} from "@eigenlayer/interfaces/IAVSDirectory.sol";
import {IDelegationManager} from "@eigenlayer/interfaces/IDelegationManager.sol";
import {IStrategy} from "@eigenlayer/interfaces/IStrategy.sol";

import {MockAVSDeployer} from "eigenlayer-middleware/test/utils/MockAVSDeployer.sol";
import {Quorum, StrategyParams} from "@eigenlayer/middleware/unaudited/ECDSAStakeRegistryStorage.sol";
import {ECDSAStakeRegistry} from "@eigenlayer/middleware/unaudited/ECDSAStakeRegistry.sol";

import {HyperlaneServiceManager} from "../../contracts/avs/HyperlaneServiceManager.sol";

contract HyperlaneServiceManagerTest is MockAVSDeployer {
    // TODO
    // register -> deregister
    // register -> stake -> deregister
    // register -> stake -> queue withdrawal -> deregister
    // register -> stake -> queue withdrawal -> complete -> deregister
    // enroll for 3 test challengers -> unenroll
    // enroll, stake/unstake -> unenroll
    // enroll,
    // register. enroll, unenroll partial, deregister
    // register. enroll, deregister
    // register, handle challenge=true, deregister

    DelegationManager public delegationManager;

    HyperlaneServiceManager internal hsm;
    ECDSAStakeRegistry internal ecdsaStakeRegistry;

    // Operator info
    uint256 operatorPrivateKey = 0xdeadbeef;
    address operator;

    bytes32 emptySalt;
    uint256 maxExpiry = type(uint256).max;

    function setUp() public {
        _deployMockEigenLayerAndAVS();
        delegationManager = new DelegationManager(
            strategyManagerMock,
            slasher,
            eigenPodManagerMock
        );

        ecdsaStakeRegistry = new ECDSAStakeRegistry(delegationManager);
        hsm = new HyperlaneServiceManager(avsDirectory, ecdsaStakeRegistry);

        IStrategy mockStrategy = IStrategy(address(0x1234));
        Quorum memory quorum = Quorum({strategies: new StrategyParams[](1)});
        quorum.strategies[0] = StrategyParams({
            strategy: mockStrategy,
            multiplier: 10000
        });
        ecdsaStakeRegistry.initialize(address(hsm), 6667, quorum);

        // register operator to eigenlayer
        operator = cheats.addr(operatorPrivateKey);
        cheats.prank(operator);
        delegationManager.registerAsOperator(
            IDelegationManager.OperatorDetails({
                earningsReceiver: operator,
                delegationApprover: address(0),
                stakerOptOutWindowBlocks: 0
            }),
            ""
        );
        // set operator as registered in Eigenlayer
        delegationMock.setIsOperator(operator, true);
    }

    function test_registerOperator() public {
        operator = cheats.addr(operatorPrivateKey);
        // act
        ISignatureUtils.SignatureWithSaltAndExpiry
            memory operatorSignature = _getOperatorSignature(
                operatorPrivateKey,
                operator,
                address(hsm),
                emptySalt,
                maxExpiry
            );
        ecdsaStakeRegistry.registerOperatorWithSignature(
            operator,
            operatorSignature
        );

        // assert
        IAVSDirectory.OperatorAVSRegistrationStatus operatorStatus = avsDirectory
                .avsOperatorStatus(address(hsm), operator);
        assertEq(
            uint8(operatorStatus),
            uint8(IAVSDirectory.OperatorAVSRegistrationStatus.REGISTERED)
        );
    }

    function _getOperatorSignature(
        uint256 _operatorPrivateKey,
        address operatorToSign,
        address avs,
        bytes32 salt,
        uint256 expiry
    )
        internal
        view
        returns (
            ISignatureUtils.SignatureWithSaltAndExpiry memory operatorSignature
        )
    {
        operatorSignature.salt = salt;
        operatorSignature.expiry = expiry;
        {
            bytes32 digestHash = avsDirectory
                .calculateOperatorAVSRegistrationDigestHash(
                    operatorToSign,
                    avs,
                    salt,
                    expiry
                );
            (uint8 v, bytes32 r, bytes32 s) = cheats.sign(
                _operatorPrivateKey,
                digestHash
            );
            operatorSignature.signature = abi.encodePacked(r, s, v);
        }
        return operatorSignature;
    }
}
