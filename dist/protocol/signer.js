/**
 * 是不是 `NostrSigner`。以形狀判斷，不用 `instanceof`：外掛可能在別的 realm（iframe、Worker）建立物件，
 * 原始私鑰也可能是別的 realm 的 `Uint8Array`。
 */
export function isNostrSigner(value) {
    if (typeof value !== "object" || value === null || ArrayBuffer.isView(value))
        return false;
    const v = value;
    return typeof v.pubkey === "string" && typeof v.sign === "function" && typeof v.conversationKey === "function";
}
//# sourceMappingURL=signer.js.map