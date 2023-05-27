pragma solidity ^0.8.0;

// Define the ISM interface
interface ISM {
    function verify(
        bytes calldata message,
        bytes calldata metadata
    ) external returns (bool);
}

// Define the OptimisticISM contract
contract OptimisticISM {
    // Define the submodule
    ISM public submodule;

    // Define the fraud window
    uint public fraudWindow;

    // Define the owner
    address public owner;

    // Define the watchers and their votes
    mapping(address => bool) public watchers;
    mapping(address => uint) public watcherVotes;

    // Define the compromised submodules
    mapping(ISM => bool) public compromisedSubmodules;

    // Define the pre-verified messages and their timestamps
    mapping(bytes => bool) public preVerifiedMessages;
    mapping(bytes => uint) public preVerificationTimestamps;

    // Define the constructor
    constructor(ISM _submodule, uint _fraudWindow) {
        submodule = _submodule;
        fraudWindow = _fraudWindow;
        owner = msg.sender;
    }

    // Define the preVerify function
    function preVerify(
        bytes calldata message,
        bytes calldata metadata
    ) external {
        require(
            submodule.verify(message, metadata),
            "Submodule verification failed"
        );
        bytes32 messageHash = keccak256(message);
        preVerifiedMessages[messageHash] = true;
        preVerificationTimestamps[messageHash] = block.timestamp;
    }

    // Define the function to flag compromised submodules
    function flagCompromisedSubmodule(ISM _submodule) external {
        require(watchers[msg.sender], "Caller is not a watcher");
        compromisedSubmodules[_submodule] = true;
    }

    // Define the verify function
    function verify(
        bytes calldata message,
        bytes calldata metadata
    ) external returns (bool) {
        bytes32 messageHash = keccak256(message);
        require(
            preVerifiedMessages[messageHash],
            "Message has not been pre-verified"
        );
        require(
            !compromisedSubmodules[submodule],
            "Submodule has been compromised"
        );
        require(
            block.timestamp >=
                preVerificationTimestamps[messageHash] + fraudWindow,
            "Fraud window has not elapsed"
        );
        return true;
    }
}
