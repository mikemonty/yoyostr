export function isNip07Available() {
  return Boolean(window?.nostr && typeof window.nostr.getPublicKey === "function");
}

export async function getNip07Pubkey() {
  if (!window?.nostr || typeof window.nostr.getPublicKey !== "function") {
    throw new Error("Missing NIP-07 signer.");
  }
  const pubkeyHex = await window.nostr.getPublicKey();
  return typeof pubkeyHex === "string" ? pubkeyHex.trim().toLowerCase() : "";
}

export async function signEventWithNip07(event) {
  if (!window?.nostr || typeof window.nostr.signEvent !== "function") {
    throw new Error("Missing NIP-07 signer.");
  }
  return window.nostr.signEvent(event);
}

