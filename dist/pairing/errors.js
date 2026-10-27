export class PairingError extends Error {
    reason;
    constructor(reason, message) {
        super(message ?? reason);
        this.name = 'PairingError';
        this.reason = reason;
    }
}
export function isPairingError(error) {
    return error instanceof Error && error.name === 'PairingError' && typeof error.reason === 'string';
}
//# sourceMappingURL=errors.js.map