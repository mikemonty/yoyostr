const STORAGE_KEY = "yoyostr_pubkey";

function normalizeHexPubkey(pubkey) {
  return typeof pubkey === "string" ? pubkey.trim().toLowerCase() : "";
}

export function getStoredPubkey() {
  try {
    const v = window?.localStorage?.getItem(STORAGE_KEY);
    const normalized = normalizeHexPubkey(v);
    return normalized || null;
  } catch {
    return null;
  }
}

export function setStoredPubkey(pubkeyHex) {
  const normalized = normalizeHexPubkey(pubkeyHex);
  if (!normalized) throw new Error("Missing pubkey");
  try {
    window?.localStorage?.setItem(STORAGE_KEY, normalized);
  } catch {
    // ignore storage failures (private mode, etc.)
  }
}

export function clearStoredPubkey() {
  try {
    window?.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export async function signInWithNip07() {
  if (!window.nostr || typeof window.nostr.getPublicKey !== "function") {
    throw new Error("Missing NIP-07 signer");
  }
  const pubkeyHex = await window.nostr.getPublicKey();
  setStoredPubkey(pubkeyHex);
  return normalizeHexPubkey(pubkeyHex);
}
