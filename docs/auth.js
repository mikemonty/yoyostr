import {
  ensureDefaultSettings,
  getSettings,
  updateSettings,
  listNip46Sessions,
  getNip46Session,
  getNip46SessionByClientPubkey,
  putNip46Session,
  updateNip46Session,
} from "./storage.js";
import { isNip07Available, getNip07Pubkey, signEventWithNip07 } from "./nip07.js";
import {
  createNip46Session,
  nip46RequestPublicKey,
  nip46RequestSignEvent,
} from "./nip46.js";

let cachedSettings = null;

export async function initAuth() {
  cachedSettings = await ensureDefaultSettings();
  return cachedSettings;
}

async function ensureAuthReady() {
  if (!cachedSettings) await initAuth();
}

export function getActiveAuthType() {
  return cachedSettings?.activeAuthType ?? null;
}

export function getActiveRemotePubkey() {
  return cachedSettings?.activeRemotePubkey ?? null;
}

export function getActiveAccountPubkey() {
  return cachedSettings?.activePubkey ?? null;
}

export function getActivePubkey() {
  return cachedSettings?.activePubkey ?? cachedSettings?.activeRemotePubkey ?? null;
}

export function getActiveNip46SessionId() {
  return cachedSettings?.activeNip46SessionId ?? null;
}

export function hasNip07Extension() {
  return isNip07Available();
}

export function canSign() {
  const type = getActiveAuthType();
  if (type === "nip07") return isNip07Available();
  if (type === "nip46") {
    return Boolean((getActiveRemotePubkey() || getActivePubkey()) && getActiveNip46SessionId());
  }
  return false;
}

export async function connectWithNip07() {
  await ensureAuthReady();
  const pubkey = await getNip07Pubkey();
  cachedSettings = await updateSettings({
    activeAuthType: "nip07",
    activePubkey: pubkey,
    activeRemotePubkey: null,
    activeNip46SessionId: null,
  });
  return pubkey;
}

export async function setActiveAuth({ type, pubkey, remotePubkey, sessionId }) {
  await ensureAuthReady();
  const patch = {
    activeAuthType: type || null,
    activePubkey: pubkey || null,
    activeNip46SessionId: sessionId || null,
  };
  if (typeof remotePubkey !== "undefined") {
    patch.activeRemotePubkey = remotePubkey || null;
  }
  cachedSettings = await updateSettings(patch);
  return cachedSettings;
}

export async function clearActiveAuth() {
  await ensureAuthReady();
  cachedSettings = await updateSettings({
    activeAuthType: null,
    activePubkey: null,
    activeRemotePubkey: null,
    activeNip46SessionId: null,
  });
  return cachedSettings;
}

export async function signEvent(event) {
  await ensureAuthReady();
  const type = getActiveAuthType();
  if (type === "nip07") {
    return signEventWithNip07(event);
  }
  if (type === "nip46") {
    const sessionId = getActiveNip46SessionId();
    const session = await getNip46Session(sessionId);
    if (!session || session.status !== "connected" || !session.remotePubkey) {
      throw new Error("Missing NIP-46 session.");
    }
    return nip46RequestSignEvent(session, event);
  }
  throw new Error("No active signer.");
}

export async function requestPublicKey() {
  await ensureAuthReady();
  const type = getActiveAuthType();
  if (type === "nip07") {
    return getNip07Pubkey();
  }
  if (type === "nip46") {
    const sessionId = getActiveNip46SessionId();
    const session = await getNip46Session(sessionId);
    if (!session || session.status !== "connected" || !session.remotePubkey) {
      throw new Error("Missing NIP-46 session.");
    }
    return nip46RequestPublicKey(session);
  }
  throw new Error("No active signer.");
}

export async function refreshNip46Pubkey(timeoutMs = 5000) {
  await ensureAuthReady();
  if (getActiveAuthType() !== "nip46") return null;
  const sessionId = getActiveNip46SessionId();
  const session = await getNip46Session(sessionId);
  if (!session || session.status !== "connected" || !session.remotePubkey) return null;
  const pubkey = await nip46RequestPublicKey(session, timeoutMs);
  const nextRemote = session.remotePubkey || cachedSettings?.activeRemotePubkey || null;
  const pubkeyChanged =
    pubkey && normalizeHex(pubkey) !== normalizeHex(cachedSettings?.activePubkey);
  const remoteChanged =
    nextRemote && normalizeHex(nextRemote) !== normalizeHex(cachedSettings?.activeRemotePubkey);
  if (pubkeyChanged || remoteChanged) {
    cachedSettings = await updateSettings({
      activeAuthType: "nip46",
      activePubkey: pubkey || cachedSettings?.activePubkey || null,
      activeRemotePubkey: nextRemote,
      activeNip46SessionId: sessionId,
    });
  }
  return pubkey;
}

function normalizeHex(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export async function ensurePendingNip46Session(relays, label) {
  await ensureAuthReady();
  const sessions = await listNip46Sessions();
  const pending = sessions
    .filter((session) => session?.status === "pending")
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  if (pending) return pending;
  const session = createNip46Session(relays, label);
  await putNip46Session(session);
  return session;
}

export {
  getSettings,
  listNip46Sessions,
  getNip46Session,
  getNip46SessionByClientPubkey,
  putNip46Session,
  updateNip46Session,
};
