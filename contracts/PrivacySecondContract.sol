// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./PrivacyFirstContract.sol";
import "./inc/config/NovelParameters.sol";

using GlobalPositionLibrary for GlobalPosition;
using PackedPositionLibrary for PackedPosition;

contract PrivacySecondContract is PrivacyFirstContract {

    mapping(uint256 => bool) private _awaitingKeyGeneration;
    mapping(uint256 => mapping(uint8 => bool)) private _bundleDelivered;
    mapping(uint256 => uint256) private _computedSenderReward;
    mapping(address => uint256) private _wrongVotes;
    mapping(address => uint256) private _rightVotesAccumulator;

    uint256 private constant SCALE = 1e18;


    event DataRequiredVerificationKeyGeneration(uint256 indexed dataId); //Throwed by sender submission, listened by Owner
    event VerifierElectedForData(address indexed verifier, uint256 indexed dataId); //Throwed by sender, listened by Onwer
    event VerifierVerificationBundleReady(address indexed verifier, uint256 indexed dataId, bytes bundle); //Throwed by owner, listened by verifier
    event VerifierEnrolled(address indexed verifier); //Throwed by owner
    event VerifierKicked(address indexed verifier); //throwed by owner, listened Verifier.
    NovelParameters private _novelParams;

    constructor(string memory ownerPubKey, Config memory config, address dstContractAddress, NovelParameters memory novelParams)
                                                                PrivacyFirstContract(ownerPubKey, config, dstContractAddress) {
        _novelParams = novelParams;
    }


    // Overrides
    function publishVerifierDecryptionKey(address verifier, string calldata) public override {
        require(_campaignOpen, "Campaign is closed");
        require(msg.sender == _owner, "Not the owner");
        _verifiers[verifier] = true;
        _verifierInformation[verifier] = VerifierInformation({
            lastVerified: 0,
            hasVerified: false,
            verifyingData: 0,
            isVerifying: false,
            bondBalance: 0
        });
        delete _verifierEnrolledRequest[verifier];
        emit VerifierEnrolled(verifier);
    }

    function publishIpfsCid(
        bytes calldata encryptedCid,
        GlobalPosition calldata position
    ) external override {
        require(_campaignOpen, "Campaign is closed");
        require(_senders[msg.sender], "Only senders allowed to send data.");
        require(position.isValid(), "Invalid Coordinates");
        require(_senderInformation[msg.sender].dataSubmitted < _config.needs.maxDataPerSender || _config.needs.maxDataPerSender == 0, "Max data limit reached");
        require(_senderInformation[msg.sender].bondBalance >= _config.rewardConfig.dataSenderBondPerData || _config.needs.maxDataPerSender == 0, "Insufficient DST balance in bond, please refund");

        PackedPosition memory packed = position.packCoordinates();
        (uint16 chunkIndex, bool inside) = _getChunkIndex(packed);
        require(inside, "Outside campaign area");
        require(_dataPerChunkReceived[chunkIndex] < _config.needs.maximumDataPerChunk || _config.needs.maximumDataPerChunk == 0, "Too many data in this chunk!");

        _dataEntries[_dataCount] = DataEntry({
            sender: msg.sender,
            status: DataStatus.PENDING,
            completedChecks: 0,
            positiveChecks: 0,
            assignedChecks: 0,
            chunkIndex: chunkIndex,
            earliestSlotDeadline: 0,
            encryptedCid: encryptedCid
        });

        _computedSenderReward[_dataCount] = _computeDecayedReward(
            _dataPerChunkReceived[chunkIndex]
        );

        _dataPerChunkReceived[chunkIndex]++;
        _senderInformation[msg.sender].dataSubmitted++;

        _awaitingKeyGeneration[_dataCount] = true;
        emit DataRequiredVerificationKeyGeneration(_dataCount);

        _dataCount++;

        if (_config.needs.maxDataPerSender > 0) {
            unchecked {
                _senderInformation[msg.sender].bondBalance = _senderInformation[msg.sender].bondBalance - _config.rewardConfig.dataSenderBondPerData;
            }
        }
    }

    function _rewardSender(uint256 dataId) internal override {
        address sender = _dataEntries[dataId].sender;
        uint256 decayedPayout = _computedSenderReward[dataId];
        uint256 total = decayedPayout + _config.rewardConfig.dataSenderBondPerData;
        require(_remainingSupply >= decayedPayout, "Insufficient supply");
        require(_senderSupplyBond >= _config.rewardConfig.dataSenderBondPerData, "Insufficient bond for senders (should never happen)");
        unchecked {
            _remainingSupply = _remainingSupply - decayedPayout;
            _senderSupplyBond = _senderSupplyBond - _config.rewardConfig.dataSenderBondPerData;
        }
        _dstContract.transfer(sender, total);
    }

    // Now the datum enters the pending queue for verification.
    function notifyVerificationKeyReady(uint256 dataId) external {
        require(msg.sender == _owner, "Not the owner");
        require(_campaignOpen, "Campaign is closed");
        require(_awaitingKeyGeneration[dataId], "Data not awaiting key generation");
        delete _awaitingKeyGeneration[dataId];
        _addToPending(dataId);
        emit DataVerificationRequestedEvent(dataId);
    }

    function _emitVerifierElected(address verifier, uint256 dataId, uint8 slotIndex)
    internal override
    {
        delete _bundleDelivered[dataId][slotIndex];
        emit VerifierElectedForData(verifier, dataId);
    }

    function deliverVerificationBundle(
        uint256 dataId,
        address verifier,
        bytes calldata bundle
    ) external {
        require(msg.sender == _owner, "Not the owner");
        require(_campaignOpen, "Campaign is closed");
        require(_verifierInformation[verifier].isVerifying, "Verifier not active");
        require(_verifierInformation[verifier].verifyingData == dataId, "Verifier not assigned to this data");

        (uint8 slotIndex, bool found) = _getVerifierSlotIndex(dataId, verifier);
        require(found, "Slot not found");
        require(!_bundleDelivered[dataId][slotIndex], "Bundle already delivered");
        _bundleDelivered[dataId][slotIndex] = true;

        emit VerifierVerificationBundleReady(verifier, dataId, bundle);
    }

    function submitVerifyResult(VerificationResult result) public virtual override {
        if (result != VerificationResult.CANNOT_COMPLETE) {
            uint256 dataId = getActiveVerification();
            (uint8 slotIndex, bool found) = _getVerifierSlotIndex(dataId, msg.sender);
            if (found && _verificationSlots[dataId][slotIndex].deadline >= block.timestamp) {
                require(_bundleDelivered[dataId][slotIndex], "Bundle not delivered yet");
            }
        }
        super.submitVerifyResult(result);
    }

    // Computes r = dataSenderPayout · (1 - α)^(1/2^k)
    // α = countBeforeSubmission / maximumDataPerChunk.
    function _computeDecayedReward(uint256 countBeforeSubmission) internal view returns (uint256) {
        uint256 maxPerChunk = _config.needs.maximumDataPerChunk;

        if (!_novelParams.rewardDecayEnabled || maxPerChunk == 0)
            return _config.rewardConfig.dataSenderPayout;

        uint256 remaining = maxPerChunk - countBeforeSubmission;
        uint256 ratio = remaining * SCALE / maxPerChunk;

        uint256 k = _novelParams.rewardDecayFactor;
        for (uint256 i = 0; i < k;) {
            ratio = _sqrt(ratio * SCALE);
            unchecked { i++; }
        }

        return _config.rewardConfig.dataSenderPayout * ratio / SCALE;
    }

    function _recordCorrectVote(address verifier) internal {
        uint256 pardon = _novelParams.pardonWrongVoteAfterRightVotes;
        if (pardon == 0 || _wrongVotes[verifier] == 0) return;

        _rightVotesAccumulator[verifier]++;
        if (_rightVotesAccumulator[verifier] >= pardon) {
            _wrongVotes[verifier]--;
            _rightVotesAccumulator[verifier] = 0;
        }
    }

    function _recordWrongVote(address verifier) internal {
        _wrongVotes[verifier]++;
        uint256 kick = _novelParams.kickVerifierAfterWrongVotes;
        if (kick > 0 && _wrongVotes[verifier] >= kick) {
            _kickVerifier(verifier);
            emit VerifierKicked(verifier);
        }
    }

    function _kickVerifier(address verifier) internal {
        uint256 bond = _verifierInformation[verifier].bondBalance;
        if (bond > 0) {
            unchecked { _verifierSupplyBond -= bond; }
            _verifierInformation[verifier].bondBalance = 0;
            _dstContract.transfer(verifier, bond);
        }
        if (_verifierInformation[verifier].isVerifying) {
            uint256 dataId = _verifierInformation[verifier].verifyingData;
            (uint8 slotIndex, bool found) = _getVerifierSlotIndex(dataId, verifier);
            if (found) _removeVerifierFromData(dataId, slotIndex);
            _makeVerifierAbleToOperate(verifier);
        }
        _verifiers[verifier] = false;
    }

    function _rewardCorrectVerifiers(uint256 dataId, bool dataWasValid) internal override {
        uint8 assigned = _dataEntries[dataId].assignedChecks;
        for (uint8 i = 0; i < assigned; i++) {
            VerificationSlot storage slot = _verificationSlots[dataId][i];
            if (!slot.completed) continue;
            if (slot.result == dataWasValid) {
                _recordCorrectVote(slot.verifier);
                uint256 total = _config.rewardConfig.dataVerifierPayout + _config.rewardConfig.dataVerifierBondPerData;
                require(_remainingSupply >= _config.rewardConfig.dataVerifierPayout, "Insufficient supply");
                require(_verifierSupplyBond >= _config.rewardConfig.dataVerifierBondPerData, "Insufficient bond for verifiers (should never happen)");
                unchecked {
                    _remainingSupply -= _config.rewardConfig.dataVerifierPayout;
                    _verifierSupplyBond -= _config.rewardConfig.dataVerifierBondPerData;
                }
                _dstContract.transfer(slot.verifier, total);
            } else {
                _recordWrongVote(slot.verifier);
            }
        }
    }

    function _tryRewardVerifier(uint256 dataId, uint8 slotIndex) internal override {
        DataStatus status = _dataEntries[dataId].status;
        if (status == DataStatus.PENDING) return;

        VerificationSlot storage slot = _verificationSlots[dataId][slotIndex];
        bool votedCorrectly = (status == DataStatus.VALID && slot.result)
            || (status == DataStatus.INVALID && !slot.result);

        if (votedCorrectly) {
            _recordCorrectVote(slot.verifier);
            uint256 total = _config.rewardConfig.dataVerifierPayout + _config.rewardConfig.dataVerifierBondPerData;
            require(_remainingSupply >= _config.rewardConfig.dataVerifierPayout, "Insufficient supply");
            require(_verifierSupplyBond >= _config.rewardConfig.dataVerifierBondPerData, "Insufficient bond for verifiers (should never happen)");
            unchecked {
                _remainingSupply -= _config.rewardConfig.dataVerifierPayout;
                _verifierSupplyBond -= _config.rewardConfig.dataVerifierBondPerData;
            }
            _dstContract.transfer(slot.verifier, total);
        } else {
            _recordWrongVote(slot.verifier);
        }
    }

    function kickVerifier(address verifier) external {
        require(msg.sender == _owner, "Not the owner");
        require(_verifiers[verifier], "Not a verifier");
        _kickVerifier(verifier);
        emit VerifierKicked(verifier);
    }

    // Integer square root via Babylonian method - O(log n).
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }

    function getExpectedSenderReward(uint16 chunkIndex) external view returns (uint256) {
        return _computeDecayedReward(_dataPerChunkReceived[chunkIndex]);
    }

    function getConfig() external view returns (Config memory) {
        return _config;
    }

}