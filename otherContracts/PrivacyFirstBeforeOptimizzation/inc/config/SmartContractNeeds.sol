// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

struct SmartContractNeeds {
    uint dataNeeded;
    uint maximumDataPerChunk;
    uint8 checksRequired;
    uint verifierCooldown;
    uint verificationTimeout;
    uint minimumParticipants;
    uint maxDataPerSender;
    uint maxDataPerVerifierPerBond;
}