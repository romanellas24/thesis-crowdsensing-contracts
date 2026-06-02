class VerifierNotElectedError extends Error {
    constructor() {
        super("VerifierElected event not found in receipt");
        this.name = "VerifierNotElectedError";
    }
}

export default VerifierNotElectedError;