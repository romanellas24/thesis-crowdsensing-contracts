import {CipherProvider, SenderPrivacyFirst} from "../PFC";

/**
 * SDK wrapper for a data contributor (A) operating on PrivacySecondContract.
 *
 * The sender flow is identical to PrivacyFirst:
 *  1. enroll()  -> key exchange, obtains Kenc
 *  2. payBond() -> DST approval + bond deposit
 *  3. publishData(cid, position) -> encrypts CID with Kenc, sends to SC
 *
 * The reward decay (§2.6.2) is fully handled by the SC at payout time -
 * no SDK-side change is needed. The sender can query the expected decayed
 * reward via OwnerPrivacySecond.getExpectedSenderReward() before submitting.
 */
export class SenderPrivacySecond extends SenderPrivacyFirst {

    constructor(
        signer: any,
        contract: any,
        dstToken: any,
        cipher: CipherProvider,
    ) {
        super(signer, contract, dstToken, cipher);
    }
}