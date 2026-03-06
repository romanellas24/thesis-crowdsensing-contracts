// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;
import "./DataEnum.sol";

    struct DataEntry {
        address sender;
        bytes encryptedCid;
        DataStatus status;
        uint8 completedChecks;
        uint8 positiveChecks;
        uint8 assignedChecks;
    }