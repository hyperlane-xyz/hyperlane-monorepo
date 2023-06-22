// Note: copied from https://github.com/smartcontractkit/libocr/tree/master/contract and
// modified to be compatible as a Hyperlane client

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {HyperlaneConnectionClient} from "../HyperlaneConnectionClient.sol";

/**
  * @notice Onchain verification of reports from the offchain reporting protocol

  * @dev For details on its operation, see the offchain reporting protocol design
  * @dev doc, which refers to this contract as simply the "contract".
*/
contract ChainlinkAggregator is HyperlaneConnectionClient {
    // Note: https://github.com/smartcontractkit/libocr/blob/master/contract/AggregatorInterface.sol
    event AnswerUpdated(
        int256 indexed current,
        uint256 indexed roundId,
        uint256 updatedAt
    );
    event NewRound(
        uint256 indexed roundId,
        address indexed startedBy,
        uint256 startedAt
    );

    // Note: https://github.com/smartcontractkit/libocr/blob/master/contract/OffchainAggregatorBilling.sol

    // Maximum number of oracles the offchain reporting protocol is designed for
    uint256 internal constant maxNumOracles = 31;

    // Used for s_oracles[a].role, where a is an address, to track the purpose
    // of the address, or to indicate that the address is unset.
    enum Role {
        // No oracle role has been set for address a
        Unset,
        // Signing address for the s_oracles[a].index'th oracle. I.e., report
        // signatures from this oracle should ecrecover back to address a.
        Signer,
        // Transmission address for the s_oracles[a].index'th oracle. I.e., if a
        // report is received by OffchainAggregator.transmit in which msg.sender is
        // a, it is attributed to the s_oracles[a].index'th oracle.
        Transmitter
    }

    struct Oracle {
        uint8 index; // Index of oracle in s_signers/s_transmitters
        Role role; // Role of the address which mapped to this struct
    }

    mapping(address => Oracle) /* signer OR transmitter address */
        internal s_oracles;

    // s_signers contains the signing address of each oracle
    address[] internal s_signers;

    // s_transmitters contains the transmission address of each oracle,
    // i.e. the address the oracle actually sends transactions to the contract from
    address[] internal s_transmitters;

    // Note: https://github.com/smartcontractkit/libocr/blob/master/contract/OffchainAggregator.sol

    uint256 private constant maxUint32 = (1 << 32) - 1;

    // Storing these fields used on the hot path in a HotVars variable reduces the
    // retrieval of all of them to a single SLOAD. If any further fields are
    // added, make sure that storage of the struct still takes at most 32 bytes.
    struct HotVars {
        // Provides 128 bits of security against 2nd pre-image attacks, but only
        // 64 bits against collisions. This is acceptable, since a malicious owner has
        // easier way of messing up the protocol than to find hash collisions.
        bytes16 latestConfigDigest;
        uint40 latestEpochAndRound; // 32 most sig bits for epoch, 8 least sig bits for round
        // Current bound assumed on number of faulty/dishonest oracles participating
        // in the protocol, this value is referred to as f in the design
        uint8 threshold;
        // Chainlink Aggregators expose a roundId to consumers. The offchain reporting
        // protocol does not use this id anywhere. We increment it whenever a new
        // transmission is made to provide callers with contiguous ids for successive
        // reports.
        uint32 latestAggregatorRoundId;
    }
    HotVars internal s_hotVars;

    // Transmission records the median answer from the transmit transaction at
    // time timestamp
    struct Transmission {
        int192 answer; // 192 bits ought to be enough for anyone
        uint64 timestamp;
    }
    mapping(uint32 => Transmission) /* aggregator round ID */
        internal s_transmissions;

    // incremented each time a new config is posted. This count is incorporated
    // into the config digest, to prevent replay attacks.
    uint32 internal s_configCount;
    uint32 internal s_latestConfigBlockNumber; // makes it easier for offchain systems
    // to extract config from logs.

    // Lowest answer the system is allowed to report in response to transmissions
    int192 public immutable minAnswer;
    // Highest answer the system is allowed to report in response to transmissions
    int192 public immutable maxAnswer;

    /*
     * @param _minAnswer lowest answer the median of a report is allowed to be
     * @param _maxAnswer highest answer the median of a report is allowed to be
     * @param _decimals answers are stored in fixed-point format, with this many digits of precision
     * @param _description short human-readable description of observable this contract's answers pertain to
     */
    constructor(
        int192 _minAnswer,
        int192 _maxAnswer,
        uint8 _decimals,
        string memory _description
    ) {
        decimals = _decimals;
        s_description = _description;
        minAnswer = _minAnswer;
        maxAnswer = _maxAnswer;
    }

    /**
     * @notice Initializes the Router contract with Hyperlane core contracts and the address of the interchain security module.
     * @param _mailbox The address of the mailbox contract.
     * @param _interchainGasPaymaster The address of the interchain gas paymaster contract.
     * @param _interchainSecurityModule The address of the interchain security module contract.
     * @param _owner The address with owner privileges.
     */
    function initialize(
        address _mailbox,
        address _interchainGasPaymaster,
        address _interchainSecurityModule,
        address _owner
    ) external initializer {
        __HyperlaneConnectionClient_initialize(
            _mailbox,
            _interchainGasPaymaster,
            _interchainSecurityModule,
            _owner
        );
    }

    /*
     * Versioning
     */
    function typeAndVersion() external pure virtual returns (string memory) {
        return "OffchainAggregator 4.0.0";
    }

    /*
     * Config logic
     */

    /**
     * @notice triggers a new run of the offchain reporting protocol
     * @param previousConfigBlockNumber block in which the previous config was set, to simplify historic analysis
     * @param configCount ordinal number of this config setting among all config settings over the life of this contract
     * @param signers ith element is address ith oracle uses to sign a report
     * @param transmitters ith element is address ith oracle uses to transmit a report via the transmit method
     * @param threshold maximum number of faulty/dishonest oracles the protocol can tolerate while still working correctly
     * @param encodedConfigVersion version of the serialization format used for "encoded" parameter
     * @param encoded serialized data used by oracles to configure their offchain operation
     */
    event ConfigSet(
        uint32 previousConfigBlockNumber,
        uint64 configCount,
        address[] signers,
        address[] transmitters,
        uint8 threshold,
        uint64 encodedConfigVersion,
        bytes encoded
    );

    // Reverts transaction if config args are invalid
    modifier checkConfigValid(
        uint256 _numSigners,
        uint256 _numTransmitters,
        uint256 _threshold
    ) {
        require(_numSigners <= maxNumOracles, "too many signers");
        require(_threshold > 0, "threshold must be positive");
        require(
            _numSigners == _numTransmitters,
            "oracle addresses out of registration"
        );
        require(
            _numSigners > 3 * _threshold,
            "faulty-oracle threshold too high"
        );
        _;
    }

    /**
     * @notice sets offchain reporting protocol configuration incl. participating oracles
     * @param _signers addresses with which oracles sign the reports
     * @param _transmitters addresses oracles use to transmit the reports
     * @param _threshold number of faulty oracles the system can tolerate
     * @param _encodedConfigVersion version number for offchainEncoding schema
     * @param _encoded encoded off-chain oracle configuration
     */
    function setConfig(
        address[] calldata _signers,
        address[] calldata _transmitters,
        uint8 _threshold,
        uint64 _encodedConfigVersion,
        bytes calldata _encoded
    )
        external
        checkConfigValid(_signers.length, _transmitters.length, _threshold)
        onlyOwner
    {
        while (s_signers.length != 0) {
            // remove any old signer/transmitter addresses
            uint256 lastIdx = s_signers.length - 1;
            address signer = s_signers[lastIdx];
            address transmitter = s_transmitters[lastIdx];
            delete s_oracles[signer];
            delete s_oracles[transmitter];
            s_signers.pop();
            s_transmitters.pop();
        }

        for (uint256 i = 0; i < _signers.length; i++) {
            // add new signer/transmitter addresses
            require(
                s_oracles[_signers[i]].role == Role.Unset,
                "repeated signer address"
            );
            s_oracles[_signers[i]] = Oracle(uint8(i), Role.Signer);
            require(
                s_oracles[_transmitters[i]].role == Role.Unset,
                "repeated transmitter address"
            );
            s_oracles[_transmitters[i]] = Oracle(uint8(i), Role.Transmitter);
            s_signers.push(_signers[i]);
            s_transmitters.push(_transmitters[i]);
        }
        s_hotVars.threshold = _threshold;
        uint32 previousConfigBlockNumber = s_latestConfigBlockNumber;
        s_latestConfigBlockNumber = uint32(block.number);
        s_configCount += 1;
        uint64 configCount = s_configCount;
        {
            s_hotVars.latestConfigDigest = configDigestFromConfigData(
                address(this),
                configCount,
                _signers,
                _transmitters,
                _threshold,
                _encodedConfigVersion,
                _encoded
            );
            s_hotVars.latestEpochAndRound = 0;
        }
        emit ConfigSet(
            previousConfigBlockNumber,
            configCount,
            _signers,
            _transmitters,
            _threshold,
            _encodedConfigVersion,
            _encoded
        );
    }

    function configDigestFromConfigData(
        address _contractAddress,
        uint64 _configCount,
        address[] calldata _signers,
        address[] calldata _transmitters,
        uint8 _threshold,
        uint64 _encodedConfigVersion,
        bytes calldata _encodedConfig
    ) internal pure returns (bytes16) {
        return
            bytes16(
                keccak256(
                    abi.encode(
                        _contractAddress,
                        _configCount,
                        _signers,
                        _transmitters,
                        _threshold,
                        _encodedConfigVersion,
                        _encodedConfig
                    )
                )
            );
    }

    /**
   * @notice information about current offchain reporting protocol configuration

   * @return configCount ordinal number of current config, out of all configs applied to this contract so far
   * @return blockNumber block at which this config was set
   * @return configDigest domain-separation tag for current config (see configDigestFromConfigData)
   */
    function latestConfigDetails()
        external
        view
        returns (
            uint32 configCount,
            uint32 blockNumber,
            bytes16 configDigest
        )
    {
        return (
            s_configCount,
            s_latestConfigBlockNumber,
            s_hotVars.latestConfigDigest
        );
    }

    /**
   * @return list of addresses permitted to transmit reports to this contract

   * @dev The list will match the order used to specify the transmitter during setConfig
   */
    function transmitters() external view returns (address[] memory) {
        return s_transmitters;
    }

    /*
     * Transmission logic
     */

    /**
     * @notice indicates that a new report was transmitted
     * @param aggregatorRoundId the round to which this report was assigned
     * @param answer median of the observations attached this report
     * @param transmitter address from which the report was transmitted
     * @param observations observations transmitted with this report
     * @param rawReportContext signature-replay-prevention domain-separation tag
     */
    event NewTransmission(
        uint32 indexed aggregatorRoundId,
        int192 answer,
        address transmitter,
        int192[] observations,
        bytes observers,
        bytes32 rawReportContext
    );

    // decodeReport is used to check that the solidity and go code are using the
    // same format. See TestOffchainAggregator.testDecodeReport and TestReportParsing
    function decodeReport(bytes memory _report)
        internal
        pure
        returns (
            bytes32 rawReportContext,
            bytes32 rawObservers,
            int192[] memory observations
        )
    {
        (rawReportContext, rawObservers, observations) = abi.decode(
            _report,
            (bytes32, bytes32, int192[])
        );
    }

    // Used to relieve stack pressure in transmit
    struct ReportData {
        HotVars hotVars; // Only read from storage once
        bytes observers; // ith element is the index of the ith observer
        int192[] observations; // ith element is the ith observation
        bytes vs; // jth element is the v component of the jth signature
        bytes32 rawReportContext;
    }

    /*
   * @notice details about the most recent report

   * @return configDigest domain separation tag for the latest report
   * @return epoch epoch in which the latest report was generated
   * @return round OCR round in which the latest report was generated
   * @return latestAnswer median value from latest report
   * @return latestTimestamp when the latest report was transmitted
   */
    function latestTransmissionDetails()
        external
        view
        returns (
            bytes16 configDigest,
            uint32 epoch,
            uint8 round,
            int192 latestAnswer,
            uint64 latestTimestamp
        )
    {
        require(msg.sender == tx.origin, "Only callable by EOA");
        return (
            s_hotVars.latestConfigDigest,
            uint32(s_hotVars.latestEpochAndRound >> 8),
            uint8(s_hotVars.latestEpochAndRound),
            s_transmissions[s_hotVars.latestAggregatorRoundId].answer,
            s_transmissions[s_hotVars.latestAggregatorRoundId].timestamp
        );
    }

    /**
     * @notice transmit is called to post a new report to the contract
     * @param _report serialized report, which the signatures are signing. See parsing code below for format. The ith element of the observers component must be the index in s_signers of the address for the ith signature
     */
    function handle(
        uint32,
        bytes32,
        bytes calldata _report
    ) public onlyMailbox {
        ReportData memory r; // Relieves stack pressure
        {
            r.hotVars = s_hotVars; // cache read from storage

            bytes32 rawObservers;
            (r.rawReportContext, rawObservers, r.observations) = abi.decode(
                _report,
                (bytes32, bytes32, int192[])
            );

            // rawReportContext consists of:
            // 11-byte zero padding
            // 16-byte configDigest
            // 4-byte epoch
            // 1-byte round

            // bytes16 configDigest = bytes16(r.rawReportContext << 88);
            // require(
            //     r.hotVars.latestConfigDigest == configDigest,
            //     "configDigest mismatch"
            // );

            uint40 epochAndRound = uint40(uint256(r.rawReportContext));

            // direct numerical comparison works here, because
            //
            //   ((e,r) <= (e',r')) implies (epochAndRound <= epochAndRound')
            //
            // because alphabetic ordering implies e <= e', and if e = e', then r<=r',
            // so e*256+r <= e'*256+r', because r, r' < 256
            require(
                r.hotVars.latestEpochAndRound < epochAndRound,
                "stale report"
            );

            require(
                r.observations.length <= maxNumOracles,
                "num observations out of bounds"
            );
            require(
                r.observations.length > 2 * r.hotVars.threshold,
                "too few values to trust median"
            );

            // Copy observer identities in bytes32 rawObservers to bytes r.observers
            r.observers = new bytes(r.observations.length);
            bool[maxNumOracles] memory seen;
            for (uint8 i = 0; i < r.observations.length; i++) {
                uint8 observerIdx = uint8(rawObservers[i]);
                require(!seen[observerIdx], "observer index repeated");
                seen[observerIdx] = true;
                r.observers[i] = rawObservers[i];
            }

            // record epochAndRound here, so that we don't have to carry the local
            // variable in transmit. The change is reverted if something fails later.
            r.hotVars.latestEpochAndRound = epochAndRound;
        }

        {
            // Check the report contents, and record the result
            for (uint256 i = 0; i < r.observations.length - 1; i++) {
                bool inOrder = r.observations[i] <= r.observations[i + 1];
                require(inOrder, "observations not sorted");
            }

            int192 median = r.observations[r.observations.length / 2];
            require(
                minAnswer <= median && median <= maxAnswer,
                "median is out of min-max range"
            );
            r.hotVars.latestAggregatorRoundId++;
            s_transmissions[r.hotVars.latestAggregatorRoundId] = Transmission(
                median,
                uint64(block.timestamp)
            );

            emit NewTransmission(
                r.hotVars.latestAggregatorRoundId,
                median,
                msg.sender,
                r.observations,
                r.observers,
                r.rawReportContext
            );
            // Emit these for backwards compatability with offchain consumers
            // that only support legacy events
            emit NewRound(
                r.hotVars.latestAggregatorRoundId,
                address(0x0), // use zero address since we don't have anybody "starting" the round here
                block.timestamp
            );
            emit AnswerUpdated(
                median,
                r.hotVars.latestAggregatorRoundId,
                block.timestamp
            );
        }
        s_hotVars = r.hotVars;
    }

    /*
     * v2 Aggregator interface
     */

    /**
     * @notice median from the most recent report
     */
    function latestAnswer() public view virtual returns (int256) {
        return s_transmissions[s_hotVars.latestAggregatorRoundId].answer;
    }

    /**
     * @notice timestamp of block in which last report was transmitted
     */
    function latestTimestamp() public view virtual returns (uint256) {
        return s_transmissions[s_hotVars.latestAggregatorRoundId].timestamp;
    }

    /**
     * @notice Aggregator round (NOT OCR round) in which last report was transmitted
     */
    function latestRound() public view virtual returns (uint256) {
        return s_hotVars.latestAggregatorRoundId;
    }

    /**
     * @notice median of report from given aggregator round (NOT OCR round)
     * @param _roundId the aggregator round of the target report
     */
    function getAnswer(uint256 _roundId) public view virtual returns (int256) {
        if (_roundId > 0xFFFFFFFF) {
            return 0;
        }
        return s_transmissions[uint32(_roundId)].answer;
    }

    /**
     * @notice timestamp of block in which report from given aggregator round was transmitted
     * @param _roundId aggregator round (NOT OCR round) of target report
     */
    function getTimestamp(uint256 _roundId)
        public
        view
        virtual
        returns (uint256)
    {
        if (_roundId > 0xFFFFFFFF) {
            return 0;
        }
        return s_transmissions[uint32(_roundId)].timestamp;
    }

    /*
     * v3 Aggregator interface
     */

    string private constant V3_NO_DATA_ERROR = "No data present";

    /**
     * @return answers are stored in fixed-point format, with this many digits of precision
     */
    uint8 public immutable decimals;

    /**
     * @notice aggregator contract version
     */
    uint256 public constant version = 4;

    string internal s_description;

    /**
     * @notice human-readable description of observable this contract is reporting on
     */
    function description() public view virtual returns (string memory) {
        return s_description;
    }

    /**
     * @notice details for the given aggregator round
     * @param _roundId target aggregator round (NOT OCR round). Must fit in uint32
     * @return roundId _roundId
     * @return answer median of report from given _roundId
     * @return startedAt timestamp of block in which report from given _roundId was transmitted
     * @return updatedAt timestamp of block in which report from given _roundId was transmitted
     * @return answeredInRound _roundId
     */
    function getRoundData(uint80 _roundId)
        public
        view
        virtual
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        require(_roundId <= 0xFFFFFFFF, V3_NO_DATA_ERROR);
        Transmission memory transmission = s_transmissions[uint32(_roundId)];
        return (
            _roundId,
            transmission.answer,
            transmission.timestamp,
            transmission.timestamp,
            _roundId
        );
    }

    /**
     * @notice aggregator details for the most recently transmitted report
     * @return roundId aggregator round of latest report (NOT OCR round)
     * @return answer median of latest report
     * @return startedAt timestamp of block containing latest report
     * @return updatedAt timestamp of block containing latest report
     * @return answeredInRound aggregator round of latest report
     */
    function latestRoundData()
        public
        view
        virtual
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        roundId = s_hotVars.latestAggregatorRoundId;

        // Skipped for compatability with existing FluxAggregator in which latestRoundData never reverts.
        // require(roundId != 0, V3_NO_DATA_ERROR);

        Transmission memory transmission = s_transmissions[uint32(roundId)];
        return (
            roundId,
            transmission.answer,
            transmission.timestamp,
            transmission.timestamp,
            roundId
        );
    }
}
