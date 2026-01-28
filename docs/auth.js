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
import { RELAYS } from "./config.js";
import {
  createNip46Session,
  getDefaultTimeoutMs,
  nip46RequestPublicKey,
  nip46RequestSignEvent,
} from "./nip46.js";

let cachedSettings = null;
const NIP46_PROBE_TIMEOUT_MS = 1200;
const NIP46_PROBE_CACHE_MS = 30000;
let lastRelayProbeAt = 0;
let lastRelayProbeBase = null;
let lastRelayProbeOk = null;

function normalizeRelayList(relays) {
  const list = Array.isArray(relays) ? relays : [];
  const out = [];
  const seen = new Set();
  for (const relay of list) {
    const url = typeof relay === "string" ? relay.trim().replace(/\/+$/, "") : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function relaysMatch(a, b) {
  const left = normalizeRelayList(a);
  const right = normalizeRelayList(b);
  if (left.length !== right.length) return false;
  return left.every((value, idx) => value === right[idx]);
}

async function probeRelays(relays, timeoutMs = NIP46_PROBE_TIMEOUT_MS) {
  if (typeof WebSocket === "undefined") return { okRelays: [], failedRelays: [] };
  const unique = normalizeRelayList(relays);
  if (!unique.length) return { okRelays: [], failedRelays: [] };
  const checks = unique.map(
    (url) =>
      new Promise((resolve) => {
        let settled = false;
        let ws;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          try {
            if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
              ws.close(1000, "done");
            }
          } catch {
            // ignore
          }
          resolve({ url, ok });
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        try {
          ws = new WebSocket(url);
        } catch {
          clearTimeout(timer);
          finish(false);
          return;
        }
        ws.addEventListener("open", () => {
          clearTimeout(timer);
          finish(true);
        });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          finish(false);
        });
        ws.addEventListener("close", () => {
          clearTimeout(timer);
          finish(false);
        });
      })
  );

  const results = await Promise.all(checks);
  const okRelays = results.filter((r) => r.ok).map((r) => r.url);
  const failedRelays = results.filter((r) => !r.ok).map((r) => r.url);
  return { okRelays, failedRelays };
}

async function refreshNip46SessionRelays(session, { forceProbe = false } = {}) {
  if (!session?.id) return session;
  let settingsRelays = [];
  try {
    const settings = await getSettings();
    settingsRelays =
      Array.isArray(settings?.relays) && settings.relays.length ? settings.relays : RELAYS;
  } catch {
    settingsRelays = RELAYS;
  }
  const baseRelays = normalizeRelayList(settingsRelays);
  if (!baseRelays.length) return session;

  let okRelays = null;
  const now = Date.now();
  const canUseCache =
    !forceProbe &&
    lastRelayProbeBase &&
    relaysMatch(lastRelayProbeBase, baseRelays) &&
    now - lastRelayProbeAt < NIP46_PROBE_CACHE_MS;
  if (canUseCache) {
    okRelays = Array.isArray(lastRelayProbeOk) ? lastRelayProbeOk : null;
  } else if (forceProbe) {
    try {
      ({ okRelays } = await probeRelays(baseRelays, NIP46_PROBE_TIMEOUT_MS));
      lastRelayProbeAt = now;
      lastRelayProbeBase = baseRelays;
      lastRelayProbeOk = okRelays;
    } catch {
      okRelays = null;
    }
  }

  const nextRelays = Array.isArray(okRelays) && okRelays.length
    ? normalizeRelayList(okRelays)
    : baseRelays;
  if (!relaysMatch(session?.relays, nextRelays)) {
    const updated = await updateNip46Session(session.id, { relays: nextRelays });
    return updated || session;
  }
  return session;
}

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
    let session = await getNip46Session(sessionId);
    if (!session || session.status !== "connected" || !session.remotePubkey) {
      throw new Error("Missing NIP-46 session.");
    }
    session = await refreshNip46SessionRelays(session);
    let signed = await nip46RequestSignEvent(session, event);
    if (!signed && session?.lastError?.code === "timeout") {
      const refreshed = await refreshNip46SessionRelays(session, { forceProbe: true });
      session = refreshed || session;
      signed = await nip46RequestSignEvent(session, event);
    }
    if (!signed) {
      if (session?.lastError?.code === "timeout") {
        throw new Error(session.lastError.message || "Timed out waiting for signer approval.");
      }
      throw new Error("Sign event failed.");
    }
    return signed;
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

export async function refreshNip46Pubkey(timeoutMs = getDefaultTimeoutMs()) {
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
