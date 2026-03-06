// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

struct SmartContractNeeds {
    uint freshnessPeriod; //If = 0 => No calculation on freshness
    uint dataNeeded;
    uint8 checksRequired;
    uint verifierCooldown;
    uint verificationTimeout;
}