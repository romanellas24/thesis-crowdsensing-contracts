// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./GlobalPackedPosition.sol";

    // @notice Modello dati per coordinate con parte intera e decimale (7 cifre).
    //         Il decimale è signed: serve a esprimere la fascia (-1°, 0°)
    //         quando integer == 0. Per |integer| > 0 il segno del decimale è
    //         ignorato e la coordinata prende il segno dall'integer.
    //         Esempi:
    //           ( 44, 1234567)  =>  44.1234567°
    //           (-9,  5000000)  =>  -9.5°
    //           ( 0, -5000000)  =>  -0.5°
struct GlobalPosition {
    int32 latitudeInteger; // [-90, +90]
    int32 latitudeDecimal; // (-10_000_000, +10_000_000) sign used iff integer is 0.
    int32 longitudeInteger;// [-180, +180]
    int32 longitudeDecimal;// (-10_000_000, +10_000_000) sign used iff integer is 0.
}

library GlobalPositionLibrary {
    int32 internal constant DEC_BOUND = 10_000_000;

    error InvalidLatitudeInteger(int32 value);
    error InvalidLatitudeDecimal(int32 value);
    error InvalidLongitudeInteger(int32 value);
    error InvalidLongitudeDecimal(int32 value);
    error LatitudeOutOfRangeAtPole(int32 integerPart, int32 decimalPart);
    error LongitudeOutOfRangeAtAntimeridian(int32 integerPart, int32 decimalPart);

    function isValid(GlobalPosition memory p) internal pure returns (bool) {
        if (p.latitudeInteger < -90 || p.latitudeInteger > 90) return false;
        if (p.latitudeDecimal <= -DEC_BOUND || p.latitudeDecimal >= DEC_BOUND) return false;
        if ((p.latitudeInteger == 90 || p.latitudeInteger == -90) && p.latitudeDecimal != 0) return false;

        if (p.longitudeInteger < -180 || p.longitudeInteger > 180) return false;
        if (p.longitudeDecimal <= -DEC_BOUND || p.longitudeDecimal >= DEC_BOUND) return false;
        if ((p.longitudeInteger == 180 || p.longitudeInteger == -180) && p.longitudeDecimal != 0) return false;

        return true;
    }

    function requireValid(GlobalPosition memory p) internal pure {
        if (p.latitudeInteger < -90 || p.latitudeInteger > 90) {
            revert InvalidLatitudeInteger(p.latitudeInteger);
        }
        if (p.latitudeDecimal <= -DEC_BOUND || p.latitudeDecimal >= DEC_BOUND) {
            revert InvalidLatitudeDecimal(p.latitudeDecimal);
        }
        if ((p.latitudeInteger == 90 || p.latitudeInteger == -90) && p.latitudeDecimal != 0) {
            revert LatitudeOutOfRangeAtPole(p.latitudeInteger, p.latitudeDecimal);
        }
        if (p.longitudeInteger < -180 || p.longitudeInteger > 180) {
            revert InvalidLongitudeInteger(p.longitudeInteger);
        }
        if (p.longitudeDecimal <= -DEC_BOUND || p.longitudeDecimal >= DEC_BOUND) {
            revert InvalidLongitudeDecimal(p.longitudeDecimal);
        }
        if ((p.longitudeInteger == 180 || p.longitudeInteger == -180) && p.longitudeDecimal != 0) {
            revert LongitudeOutOfRangeAtAntimeridian(p.longitudeInteger, p.longitudeDecimal);
        }
    }

    /// @notice Pack a GlobalPosition into E7 format (int32 per axis, ~1.1cm precision).
    ///         Examples:  (44, 1234567) => 441234567
    ///                    (-9, 5000000) => -95000000
    ///                    (0, -5000000) => -5000000
    function packCoordinates(GlobalPosition memory p) internal pure returns (PackedPosition memory) {
        requireValid(p); // garantisce che i cast a int32 sotto non possano troncare

        return PackedPosition({
            latE7: int32(_combine(p.latitudeInteger, p.latitudeDecimal)),
            lonE7: int32(_combine(p.longitudeInteger, p.longitudeDecimal))
        });
    }

    function _combine(int32 integerPart, int32 decimalPart) private pure returns (int64) {
        int64 base = int64(integerPart) * 10_000_000;
        int64 dec  = int64(decimalPart);
        int64 absDec = dec < 0 ? -dec : dec;

        if (integerPart > 0) return base + absDec;
        if (integerPart < 0) return base - absDec;
        return dec;
    }
}