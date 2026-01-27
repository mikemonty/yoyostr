import Dexie from "https://esm.sh/dexie@3.2.4";
import { RELAYS } from "./config.js";

const DB_NAME = "yoyostr_db";
const DEFAULT_SETTINGS_ID = "default";

const db = new Dexie(DB_NAME);
db.version(1).stores({
  settings: "id, activeAuthType, activePubkey, activeNip46SessionId",
  nip46_sessions: "id, status, updatedAt, clientPubkey, remotePubkey",
});

function normalizeRelays(relays) {
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

export async function ensureDefaultSettings() {
  let settings = await db.settings.get(DEFAULT_SETTINGS_ID);
  if (!settings) {
    settings = {
      id: DEFAULT_SETTINGS_ID,
      relays: normalizeRelays(RELAYS),
      activeAuthType: null,
      activePubkey: null,
      activeNip46SessionId: null,
    };
    await db.settings.put(settings);
    return settings;
  }

  const relays = normalizeRelays(settings.relays || RELAYS);
  if (!Array.isArray(settings.relays) || relays.length !== settings.relays.length) {
    settings = { ...settings, relays };
    await db.settings.put(settings);
  }
  return settings;
}

export async function getSettings() {
  return db.settings.get(DEFAULT_SETTINGS_ID);
}

export async function putSettings(next) {
  const payload = { ...next, id: DEFAULT_SETTINGS_ID };
  await db.settings.put(payload);
  return payload;
}

export async function updateSettings(patch) {
  const current = (await ensureDefaultSettings()) || {
    id: DEFAULT_SETTINGS_ID,
    relays: normalizeRelays(RELAYS),
    activeAuthType: null,
    activePubkey: null,
    activeNip46SessionId: null,
  };
  const next = { ...current, ...patch, id: DEFAULT_SETTINGS_ID };
  if (patch && Object.prototype.hasOwnProperty.call(patch, "relays")) {
    next.relays = normalizeRelays(next.relays);
  }
  await db.settings.put(next);
  return next;
}

export async function listNip46Sessions() {
  return db.nip46_sessions.toArray();
}

export async function getNip46Session(id) {
  if (!id) return null;
  return db.nip46_sessions.get(id);
}

export async function getNip46SessionByClientPubkey(pubkeyHex) {
  if (!pubkeyHex) return null;
  return db.nip46_sessions.where("clientPubkey").equals(pubkeyHex).first();
}

export async function putNip46Session(session) {
  if (!session || !session.id) throw new Error("Missing session id.");
  await db.nip46_sessions.put(session);
  return session;
}

export async function updateNip46Session(id, patch) {
  const current = await getNip46Session(id);
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    id,
    updatedAt: new Date().toISOString(),
  };
  await db.nip46_sessions.put(next);
  return next;
}

