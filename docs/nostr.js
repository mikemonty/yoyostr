import { APP_TAG, KIND_BADGE_PREFS, KIND_TRACK, KIND_UNIT, RELAYS } from "./config.js";

const BAD_RELAYS_STORAGE_KEY = "yoyostr_bad_relays_v1";
const RELAY_FAIL_TTL_MS = 10 * 60 * 1000;
let badRelaysCache = null; // Map<string, number> relayUrl -> expiresAtMs

function normalizeRelayUrl(relayUrl) {
  const raw = typeof relayUrl === "string" ? relayUrl.trim() : "";
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

function loadBadRelays() {
  if (badRelaysCache) return badRelaysCache;
  const map = new Map();
  try {
    const raw = window?.localStorage?.getItem(BAD_RELAYS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed)) {
        const url = normalizeRelayUrl(k);
        const exp = typeof v === "number" ? v : Number(v);
        if (!url || !Number.isFinite(exp)) continue;
        map.set(url, exp);
      }
    }
  } catch {
    // ignore storage / parse errors
  }
  badRelaysCache = map;
  return map;
}

function saveBadRelays(map) {
  try {
    const obj = Object.fromEntries(map.entries());
    window?.localStorage?.setItem(BAD_RELAYS_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // ignore
  }
}

function pruneBadRelays(map) {
  const now = Date.now();
  let changed = false;
  for (const [url, exp] of map.entries()) {
    if (!Number.isFinite(exp) || exp <= now) {
      map.delete(url);
      changed = true;
    }
  }
  if (changed) saveBadRelays(map);
}

function rememberRelayFailure(relayUrl) {
  const url = normalizeRelayUrl(relayUrl);
  if (!url) return;
  const map = loadBadRelays();
  pruneBadRelays(map);
  map.set(url, Date.now() + RELAY_FAIL_TTL_MS);
  saveBadRelays(map);
}

function selectRelays(relays) {
  const list = Array.isArray(relays) ? relays : [];
  const unique = [];
  const seen = new Set();
  for (const r of list) {
    const url = normalizeRelayUrl(r);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push(url);
  }
  const map = loadBadRelays();
  pruneBadRelays(map);
  const filtered = unique.filter((url) => {
    const exp = map.get(url);
    return !(typeof exp === "number" && exp > Date.now());
  });
  return filtered.length ? filtered : unique;
}

function safeClose(ws) {
  try {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close(1000, "done");
    }
  } catch {
    // ignore
  }
}

export async function publishEventToRelays(relays, signedEvent, options = {}) {
  const relayList = selectRelays(relays);
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 3000;
  const eventId = signedEvent?.id;

  const results = {};
  await Promise.all(
    relayList.map(
      (relayUrl) =>
        new Promise((resolve) => {
          let ws;
          let done = false;

          const finish = (result) => {
            if (done) return;
            done = true;
            results[relayUrl] = result;
            safeClose(ws);
            resolve();
          };

          const timer = setTimeout(
            () => finish({ ok: false, timeout: true, message: "timeout", eventId }),
            timeoutMs
          );

          try {
            ws = new WebSocket(relayUrl);
          } catch {
            clearTimeout(timer);
            finish({ ok: false, message: "websocket_failed", eventId });
            return;
          }

          ws.addEventListener("open", () => {
            try {
              ws.send(JSON.stringify(["EVENT", signedEvent]));
            } catch {
              clearTimeout(timer);
              finish({ ok: false, message: "send_failed", eventId });
            }
          });

          ws.addEventListener("message", (ev) => {
            let msg;
            try {
              msg = JSON.parse(ev.data);
            } catch {
              return;
            }
            if (!Array.isArray(msg)) return;

            if (msg[0] !== "OK") return;
            const okEventId = msg[1];
            if (typeof eventId === "string" && typeof okEventId === "string" && okEventId !== eventId) {
              return;
            }

            const ok = Boolean(msg[2]);
            const message = typeof msg[3] === "string" ? msg[3] : "";
            clearTimeout(timer);
            finish({ ok, message, eventId: okEventId });
          });

          ws.addEventListener("error", () => {
            rememberRelayFailure(relayUrl);
            clearTimeout(timer);
            finish({ ok: false, message: "error", eventId });
          });

          ws.addEventListener("close", () => {
            clearTimeout(timer);
            finish({ ok: false, message: "closed", eventId });
          });
        })
    )
  );

  return results;
}

function getTagValue(tags, key) {
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === key && typeof tag[1] === "string") return tag[1];
  }
  return null;
}

function hasTagValue(tags, key, value) {
  if (!Array.isArray(tags)) return false;
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === key && typeof tag[1] === "string" && tag[1] === value) {
      return true;
    }
  }
  return false;
}

function toNumberOrNull(value) {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeHexPubkey(pubkeyHex) {
  return typeof pubkeyHex === "string" ? pubkeyHex.trim().toLowerCase() : "";
}

function parseTrackFromEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (typeof event.content !== "string") return null;

  let track;
  try {
    track = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!track || typeof track !== "object") return null;

  const d = getTagValue(event.tags, "d");
  const createdAt = toNumberOrNull(event.created_at) ?? 0;
  return { d, createdAt, track };
}

function parseUnitFromEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (typeof event.content !== "string") return null;

  let unit;
  try {
    unit = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!unit || typeof unit !== "object") return null;

  const d = getTagValue(event.tags, "d");
  const createdAt = toNumberOrNull(event.created_at) ?? 0;

  let trackId = typeof unit.trackId === "string" ? unit.trackId : null;
  let unitId = typeof unit.unitId === "string" ? unit.unitId : null;
  if (typeof d === "string") {
    const m = d.match(/^unit:([^:]+):([^:]+)$/);
    if (m) {
      if (!trackId) trackId = m[1];
      if (!unitId) unitId = m[2];
    }
  }

  const normalized = { ...unit };
  if (trackId) normalized.trackId = trackId;
  if (unitId) normalized.unitId = unitId;
  return { d, createdAt, unit: normalized };
}

export async function fetchTracksFromRelays(options = {}) {
  const relays = selectRelays(Array.isArray(options.relays) ? options.relays : RELAYS);
  const kind = options.kind ?? KIND_TRACK;
  const tag = options.tag ?? "yoyostr";
  const timeoutMs = toNumberOrNull(options.timeoutMs) ?? 6500;

  const subId = `yoyostr-tracks-${Math.random().toString(36).slice(2, 10)}`;
  const filter = { kinds: [kind], "#t": [tag] };

  const byKey = new Map(); // key (d or event id) -> { createdAt, track }
  const sockets = [];
  const socketByRelay = new Map();
  const doneRelays = new Set();

  const finalize = () => {
    for (const ws of sockets) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, "done");
      } catch {
        // ignore
      }
    }

    const tracks = Array.from(byKey.values()).map((v) => v.track);
    tracks.sort((a, b) => {
      const ao = toNumberOrNull(a.order);
      const bo = toNumberOrNull(b.order);
      if (ao !== null && bo !== null && ao !== bo) return ao - bo;
      if (ao !== null && bo === null) return -1;
      if (ao === null && bo !== null) return 1;
      const ac = toNumberOrNull(a.created_at) ?? 0;
      const bc = toNumberOrNull(b.created_at) ?? 0;
      return bc - ac;
    });
    return tracks;
  };

  return await new Promise((resolve) => {
    const finishIfDone = () => {
      if (doneRelays.size >= relays.length) {
        clearTimeout(timer);
        resolve(finalize());
      }
    };

    const timer = setTimeout(() => resolve(finalize()), timeoutMs);

    const markDone = (relayUrl) => {
      if (doneRelays.has(relayUrl)) return;
      doneRelays.add(relayUrl);
      const ws = socketByRelay.get(relayUrl);
      if (ws) {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(["CLOSE", subId]));
        } catch {
          // ignore
        }
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, "done");
        } catch {
          // ignore
        }
      }
      finishIfDone();
    };

    for (const relayUrl of relays) {
      let ws;
      try {
        ws = new WebSocket(relayUrl);
      } catch {
        markDone(relayUrl);
        continue;
      }
      sockets.push(ws);
      socketByRelay.set(relayUrl, ws);

      ws.addEventListener("open", () => {
        try {
          ws.send(JSON.stringify(["REQ", subId, filter]));
        } catch {
          markDone(relayUrl);
        }
      });

      ws.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!Array.isArray(msg)) return;

        const [type, sub] = msg;
        if (sub !== subId) return;

        if (type === "EVENT") {
          const event = msg[2];
          const parsed = parseTrackFromEvent(event);
          if (!parsed) return;

          const key = parsed.d || event?.id;
          if (!key) return;

          const existing = byKey.get(key);
          if (!existing || parsed.createdAt > existing.createdAt) {
            // Keep created_at on the track itself so callers can sort/render if desired.
            const track = { ...parsed.track, created_at: parsed.createdAt, d: parsed.d ?? undefined };
            byKey.set(key, { createdAt: parsed.createdAt, track });
          }
          return;
        }

        if (type === "EOSE") {
          markDone(relayUrl);
          return;
        }
      });

      ws.addEventListener("error", () => {
        rememberRelayFailure(relayUrl);
        markDone(relayUrl);
      });
      ws.addEventListener("close", (ev) => {
        if (ev && typeof ev.code === "number" && ev.code !== 1000) rememberRelayFailure(relayUrl);
        markDone(relayUrl);
      });
    }

    // If relays is empty, resolve immediately.
    if (relays.length === 0) {
      clearTimeout(timer);
      resolve([]);
    }
  });
}

export async function fetchUnitsFromRelays(trackId, options = {}) {
  const tid = typeof trackId === "string" ? trackId.trim() : "";
  if (!tid) return [];

  const relays = selectRelays(Array.isArray(options.relays) ? options.relays : RELAYS);
  const timeoutMs = toNumberOrNull(options.timeoutMs) ?? 6500;
  const yoyostrTag = "yoyostr";
  const trackTag = `track:${tid}`;

  const subId = `yoyostr-units-${tid}-${Math.random().toString(36).slice(2, 10)}`;
  const filter = { kinds: [KIND_UNIT], "#t": [yoyostrTag, trackTag] };

  const byD = new Map(); // d -> { createdAt, unit }
  const sockets = [];
  const socketByRelay = new Map();
  const doneRelays = new Set();

  const finalize = () => {
    for (const ws of sockets) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, "done");
      } catch {
        // ignore
      }
    }

    const units = Array.from(byD.values()).map((v) => v.unit);
    units.sort((a, b) => {
      const ao = toNumberOrNull(a.order);
      const bo = toNumberOrNull(b.order);
      if (ao !== null && bo !== null && ao !== bo) return ao - bo;
      if (ao !== null && bo === null) return -1;
      if (ao === null && bo !== null) return 1;
      const ac = toNumberOrNull(a.created_at) ?? 0;
      const bc = toNumberOrNull(b.created_at) ?? 0;
      return bc - ac;
    });
    return units;
  };

  return await new Promise((resolve) => {
    const finishIfDone = () => {
      if (doneRelays.size >= relays.length) {
        clearTimeout(timer);
        resolve(finalize());
      }
    };

    const timer = setTimeout(() => resolve(finalize()), timeoutMs);

    const markDone = (relayUrl) => {
      if (doneRelays.has(relayUrl)) return;
      doneRelays.add(relayUrl);
      const ws = socketByRelay.get(relayUrl);
      if (ws) {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(["CLOSE", subId]));
        } catch {
          // ignore
        }
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, "done");
        } catch {
          // ignore
        }
      }
      finishIfDone();
    };

    for (const relayUrl of relays) {
      let ws;
      try {
        ws = new WebSocket(relayUrl);
      } catch {
        markDone(relayUrl);
        continue;
      }
      sockets.push(ws);
      socketByRelay.set(relayUrl, ws);

      ws.addEventListener("open", () => {
        try {
          ws.send(JSON.stringify(["REQ", subId, filter]));
        } catch {
          markDone(relayUrl);
        }
      });

      ws.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!Array.isArray(msg)) return;

        const [type, sub] = msg;
        if (sub !== subId) return;

        if (type === "EVENT") {
          const event = msg[2];
          if (!hasTagValue(event?.tags, "t", yoyostrTag) || !hasTagValue(event?.tags, "t", trackTag)) {
            return;
          }

          const parsed = parseUnitFromEvent(event);
          if (!parsed || typeof parsed.d !== "string" || !parsed.d) return;
          if (parsed.unit?.trackId !== tid) return;

          const existing = byD.get(parsed.d);
          if (!existing || parsed.createdAt > existing.createdAt) {
            const unit = { ...parsed.unit, created_at: parsed.createdAt, d: parsed.d };
            byD.set(parsed.d, { createdAt: parsed.createdAt, unit });
          }
          return;
        }

        if (type === "EOSE") {
          markDone(relayUrl);
          return;
        }
      });

      ws.addEventListener("error", () => {
        rememberRelayFailure(relayUrl);
        markDone(relayUrl);
      });
      ws.addEventListener("close", (ev) => {
        if (ev && typeof ev.code === "number" && ev.code !== 1000) rememberRelayFailure(relayUrl);
        markDone(relayUrl);
      });
    }

    if (relays.length === 0) {
      clearTimeout(timer);
      resolve([]);
    }
  });
}

async function fetchEventsFromRelays(filter, options = {}) {
  const relays = selectRelays(Array.isArray(options.relays) ? options.relays : RELAYS);
  const timeoutMs = toNumberOrNull(options.timeoutMs) ?? 6500;
  const subId = `yoyostr-events-${Math.random().toString(36).slice(2, 10)}`;
  const filters = Array.isArray(filter) ? filter.filter(Boolean) : [filter].filter(Boolean);
  if (filters.length === 0) return [];

  const byId = new Map(); // id -> event
  const sockets = [];
  const socketByRelay = new Map();
  const doneRelays = new Set();

  const finalize = () => {
    for (const ws of sockets) safeClose(ws);
    return Array.from(byId.values());
  };

  return await new Promise((resolve) => {
    const finishIfDone = () => {
      if (doneRelays.size >= relays.length) {
        clearTimeout(timer);
        resolve(finalize());
      }
    };

    const timer = setTimeout(() => resolve(finalize()), timeoutMs);

    const markDone = (relayUrl) => {
      if (doneRelays.has(relayUrl)) return;
      doneRelays.add(relayUrl);
      const ws = socketByRelay.get(relayUrl);
      if (ws) {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(["CLOSE", subId]));
        } catch {
          // ignore
        }
        safeClose(ws);
      }
      finishIfDone();
    };

    for (const relayUrl of relays) {
      let ws;
      try {
        ws = new WebSocket(relayUrl);
      } catch {
        markDone(relayUrl);
        continue;
      }
      sockets.push(ws);
      socketByRelay.set(relayUrl, ws);

      ws.addEventListener("open", () => {
        try {
          ws.send(JSON.stringify(["REQ", subId, ...filters]));
        } catch {
          markDone(relayUrl);
        }
      });

      ws.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!Array.isArray(msg)) return;

        const [type, sub] = msg;
        if (sub !== subId) return;

        if (type === "EVENT") {
          const event = msg[2];
          const id = typeof event?.id === "string" ? event.id : "";
          if (!id) return;
          if (!byId.has(id)) byId.set(id, event);
          return;
        }

        if (type === "EOSE") {
          markDone(relayUrl);
          return;
        }
      });

      ws.addEventListener("error", () => {
        rememberRelayFailure(relayUrl);
        markDone(relayUrl);
      });
      ws.addEventListener("close", (ev) => {
        if (ev && typeof ev.code === "number" && ev.code !== 1000) rememberRelayFailure(relayUrl);
        markDone(relayUrl);
      });
    }

    if (relays.length === 0) {
      clearTimeout(timer);
      resolve([]);
    }
  });
}

function getTagValues(tags, key) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== key) continue;
    if (typeof tag[1] === "string" && tag[1].trim()) out.push(tag[1].trim());
  }
  return out;
}

function getTagValueAny(tags, key) {
  return getTagValues(tags, key)[0] ?? null;
}

function makeEventAddress(kind, pubkeyHex, dTag) {
  const k = typeof kind === "number" ? kind : Number(kind);
  const pubkey = normalizeHexPubkey(pubkeyHex);
  const d = typeof dTag === "string" ? dTag.trim() : "";
  if (!Number.isFinite(k) || k <= 0 || !pubkey || !d) return "";
  return `${k}:${pubkey}:${d}`;
}

function parseBadgeDefinitionEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (Number(event.kind) !== 30009) return null;
  if (typeof event.content !== "string") return null;

  const d = getTagValueAny(event.tags, "d");
  const pubkey = normalizeHexPubkey(event.pubkey);
  if (!d || !pubkey) return null;

  let payload;
  try {
    payload = JSON.parse(event.content);
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};

  const unitRefFromTags = getTagValues(event.tags, "t").find((t) => t.startsWith("unit:")) || "";
  const unitRef =
    (typeof payload.unitRef === "string" && payload.unitRef.trim()) || unitRefFromTags || "";

  const createdAt = toNumberOrNull(event.created_at) ?? 0;
  const address = makeEventAddress(30009, pubkey, d);

  return {
    event,
    d,
    pubkey,
    created_at: createdAt,
    address,
    name: typeof payload.name === "string" ? payload.name : "",
    description: typeof payload.description === "string" ? payload.description : "",
    imageUrl: typeof payload.imageUrl === "string" ? payload.imageUrl : "",
    unitRef,
  };
}

export async function publishBadgeDefinition({
  badgeId,
  name,
  description,
  imageUrl,
  unitRef,
  unitAddress,
  relays,
} = {}) {
  if (!window.nostr || typeof window.nostr.signEvent !== "function") {
    throw new Error("Missing signer (NIP-07).");
  }

  const pubkey = normalizeHexPubkey(await window.nostr.getPublicKey?.());
  if (!pubkey) throw new Error("Missing signer pubkey.");

  const uref = typeof unitRef === "string" ? unitRef.trim() : "";
  if (!uref) throw new Error("Missing unitRef.");

  const d =
    (typeof badgeId === "string" && badgeId.trim()) ||
    `badge:${uref}`;

  const content = JSON.stringify({
    name: typeof name === "string" ? name.trim() : "",
    description: typeof description === "string" ? description.trim() : "",
    imageUrl: typeof imageUrl === "string" ? imageUrl.trim() : "",
    unitRef: uref,
  });

  const tags = [
    ["d", d],
    ["t", APP_TAG],
    ["t", "badge"],
    ["t", uref],
  ];
  const addr = typeof unitAddress === "string" ? unitAddress.trim() : "";
  if (addr) tags.push(["a", addr]);

  const now = Math.floor(Date.now() / 1000);
  const unsignedEvent = {
    kind: 30009,
    created_at: now,
    tags,
    content,
    pubkey,
  };

  const signedEvent = await window.nostr.signEvent(unsignedEvent);
  const results = await publishEventToRelays(relays || RELAYS, signedEvent);
  return { signedEvent, results };
}

export async function fetchBadgeDefinitionForUnit(unitRef, options = {}) {
  const defs = await fetchBadgeDefinitionsForUnit(unitRef, options);
  return defs[0] || null;
}

export async function fetchBadgeDefinitionsForUnit(unitRef, options = {}) {
  const uref = typeof unitRef === "string" ? unitRef.trim() : "";
  if (!uref) return [];

  const limit = toNumberOrNull(options.limit) ?? 80;
  const filter = { kinds: [30009], "#t": [APP_TAG, uref], limit };

  const events = await fetchEventsFromRelays(filter, options);
  const candidates = [];
  for (const ev of events) {
    if (!hasTagValue(ev?.tags, "t", APP_TAG)) continue;
    if (!hasTagValue(ev?.tags, "t", "badge")) continue;
    if (!hasTagValue(ev?.tags, "t", uref)) continue;
    const parsed = parseBadgeDefinitionEvent(ev);
    if (!parsed) continue;
    candidates.push(parsed);
  }

  const newestByD = new Map(); // d -> parsed
  for (const def of candidates) {
    const prev = newestByD.get(def.d);
    if (!prev || def.created_at > prev.created_at) newestByD.set(def.d, def);
  }

  const list = Array.from(newestByD.values());
  list.sort((a, b) => b.created_at - a.created_at);
  return list;
}

export async function fetchAllBadgeDefinitions(options = {}) {
  const limit = toNumberOrNull(options.limit) ?? 500;
  const filter = { kinds: [30009], "#t": [APP_TAG, "badge"], limit };

  const events = await fetchEventsFromRelays(filter, options);
  const newestByAddress = new Map(); // address -> parsed def
  for (const ev of events) {
    if (!hasTagValue(ev?.tags, "t", APP_TAG)) continue;
    if (!hasTagValue(ev?.tags, "t", "badge")) continue;
    const parsed = parseBadgeDefinitionEvent(ev);
    if (!parsed) continue;
    const prev = newestByAddress.get(parsed.address);
    if (!prev || parsed.created_at > prev.created_at) newestByAddress.set(parsed.address, parsed);
  }
  const list = Array.from(newestByAddress.values());
  list.sort((a, b) => b.created_at - a.created_at);
  return list;
}

export async function fetchBadgesCreatedBy(pubkeyHex, options = {}) {
  const pubkey = normalizeHexPubkey(pubkeyHex);
  if (!pubkey) return [];

  const limit = toNumberOrNull(options.limit) ?? 200;
  const filter = { kinds: [30009], authors: [pubkey], "#t": [APP_TAG, "badge"], limit };

  const events = await fetchEventsFromRelays(filter, options);
  const newestByAddress = new Map(); // address -> parsed def
  for (const ev of events) {
    if (!hasTagValue(ev?.tags, "t", APP_TAG)) continue;
    if (!hasTagValue(ev?.tags, "t", "badge")) continue;
    const parsed = parseBadgeDefinitionEvent(ev);
    if (!parsed) continue;
    const prev = newestByAddress.get(parsed.address);
    if (!prev || parsed.created_at > prev.created_at) newestByAddress.set(parsed.address, parsed);
  }
  const list = Array.from(newestByAddress.values());
  list.sort((a, b) => b.created_at - a.created_at);
  return list;
}

export async function fetchBadgeDefinitionByAddress(badgeAddress, options = {}) {
  const parsed = parseBadgeAddress(badgeAddress);
  if (!parsed || parsed.kind !== 30009) return null;
  const defs = await fetchBadgeDefinitionsByAddresses([parsed.address], options);
  return defs?.[parsed.address] || null;
}

export async function fetchBadgeAwardEventsForBadgeAddress(badgeAddress, options = {}) {
  const addr = typeof badgeAddress === "string" ? badgeAddress.trim() : "";
  const parsed = parseBadgeAddress(addr);
  if (!parsed || parsed.kind !== 30009) return [];

  const limit = toNumberOrNull(options.limit) ?? 500;
  const filter = { kinds: [8], "#a": [parsed.address], limit };
  const awards = await fetchEventsFromRelays(filter, options);
  awards.sort((a, b) => (toNumberOrNull(b?.created_at) ?? 0) - (toNumberOrNull(a?.created_at) ?? 0));
  return awards;
}

export async function fetchBadgeAwardCounts(badgeAddresses, options = {}) {
  const raw = Array.isArray(badgeAddresses) ? badgeAddresses : [];
  const unique = [];
  const seen = new Set();
  for (const addr of raw) {
    const parsed = parseBadgeAddress(addr);
    if (!parsed || parsed.kind !== 30009) continue;
    if (seen.has(parsed.address)) continue;
    seen.add(parsed.address);
    unique.push(parsed.address);
  }

  const recipientsByAddress = new Map(); // address -> Set(pubkey)
  for (const addr of unique) recipientsByAddress.set(addr, new Set());

  const chunkSize = toNumberOrNull(options.chunkSize) ?? 20;
  const limit = toNumberOrNull(options.limit) ?? 2000;
  const filters = [];
  for (let i = 0; i < unique.length; i += chunkSize) {
    filters.push({ kinds: [8], "#a": unique.slice(i, i + chunkSize), limit });
  }

  const events = await fetchEventsFromRelays(filters, options);
  for (const ev of events) {
    const addrs = getTagValues(ev?.tags, "a");
    const recipients = getTagValues(ev?.tags, "p");
    if (recipients.length === 0) continue;
    for (const a of addrs) {
      const addr = typeof a === "string" ? a.trim() : "";
      if (!recipientsByAddress.has(addr)) continue;
      const set = recipientsByAddress.get(addr);
      for (const p of recipients) {
        const pk = normalizeHexPubkey(p);
        if (pk) set.add(pk);
      }
    }
  }

  const countsByAddress = {};
  for (const [addr, set] of recipientsByAddress.entries()) countsByAddress[addr] = set.size;
  return { countsByAddress, recipientsByAddress };
}

function parseBadgeAddress(address) {
  const raw = typeof address === "string" ? address.trim() : "";
  const m = raw.match(/^(\d+):([0-9a-f]{64}):(.+)$/i);
  if (!m) return null;
  const kind = Number(m[1]);
  if (!Number.isFinite(kind)) return null;
  const pubkey = normalizeHexPubkey(m[2]);
  const d = m[3];
  if (!pubkey || !d) return null;
  return { kind, pubkey, d, address: `${kind}:${pubkey}:${d}` };
}

export async function publishBadgeAward({
  badgeEvent,
  badgeAddress,
  recipientPubkeyHex,
  proofEventId,
  note,
  unitRef,
  relays,
} = {}) {
  if (!window.nostr || typeof window.nostr.signEvent !== "function") {
    throw new Error("Missing signer (NIP-07).");
  }

  const pubkey = normalizeHexPubkey(await window.nostr.getPublicKey?.());
  if (!pubkey) throw new Error("Missing signer pubkey.");

  const recipient = normalizeHexPubkey(recipientPubkeyHex);
  if (!recipient) throw new Error("Missing recipient pubkey.");

  const proofId = typeof proofEventId === "string" ? proofEventId.trim() : "";
  if (!proofId) throw new Error("Missing proof event id.");

  let addr = typeof badgeAddress === "string" ? badgeAddress.trim() : "";
  if (!addr && badgeEvent && typeof badgeEvent === "object") {
    const d = getTagValueAny(badgeEvent.tags, "d");
    const pk = normalizeHexPubkey(badgeEvent.pubkey);
    addr = makeEventAddress(30009, pk, d);
  }
  const parsedAddr = parseBadgeAddress(addr);
  if (!parsedAddr || parsedAddr.kind !== 30009) throw new Error("Missing badge definition address.");

  const tags = [
    ["a", parsedAddr.address],
    ["p", recipient],
    ["e", proofId],
    ["t", APP_TAG],
    ["t", "badge-award"],
  ];
  const uref = typeof unitRef === "string" ? unitRef.trim() : "";
  if (uref) tags.push(["t", uref]);

  const now = Math.floor(Date.now() / 1000);
  const unsignedEvent = {
    kind: 8,
    created_at: now,
    tags,
    content: typeof note === "string" ? note.trim() : "",
    pubkey,
  };

  const signedEvent = await window.nostr.signEvent(unsignedEvent);
  const results = await publishEventToRelays(relays || RELAYS, signedEvent);
  return { signedEvent, results };
}

async function fetchBadgeDefinitionsByAddresses(addresses, options = {}) {
  const raw = Array.isArray(addresses) ? addresses : [];
  const unique = [];
  const seen = new Set();
  for (const addr of raw) {
    const parsed = parseBadgeAddress(addr);
    if (!parsed || parsed.kind !== 30009) continue;
    if (seen.has(parsed.address)) continue;
    seen.add(parsed.address);
    unique.push(parsed);
  }
  if (unique.length === 0) return {};

  const filters = unique.slice(0, 40).map((a) => ({
    kinds: [30009],
    authors: [a.pubkey],
    "#d": [a.d],
    limit: 10,
  }));

  const events = await fetchEventsFromRelays(filters, options);
  const newestByAddress = new Map(); // address -> parsed def
  for (const ev of events) {
    const def = parseBadgeDefinitionEvent(ev);
    if (!def) continue;
    const prev = newestByAddress.get(def.address);
    if (!prev || def.created_at > prev.created_at) newestByAddress.set(def.address, def);
  }

  return Object.fromEntries(newestByAddress.entries());
}

export async function fetchAwardedBadges(pubkeyHex, options = {}) {
  const pubkey = normalizeHexPubkey(pubkeyHex);
  if (!pubkey) return { awards: [], definitionsByAddress: {} };

  const limit = toNumberOrNull(options.limit) ?? 200;
  const filter = { kinds: [8], "#p": [pubkey], limit };
  const awards = await fetchEventsFromRelays(filter, options);

  const badgeAddresses = [];
  for (const ev of awards) {
    const addrs = getTagValues(ev?.tags, "a");
    for (const addr of addrs) {
      const parsed = parseBadgeAddress(addr);
      if (parsed && parsed.kind === 30009) badgeAddresses.push(parsed.address);
    }
  }

  const definitionsByAddress = await fetchBadgeDefinitionsByAddresses(badgeAddresses, options);
  awards.sort((a, b) => (toNumberOrNull(b?.created_at) ?? 0) - (toNumberOrNull(a?.created_at) ?? 0));

  return { awards, definitionsByAddress };
}

export async function fetchBadgePrefs(pubkeyHex, options = {}) {
  const pubkey = normalizeHexPubkey(pubkeyHex);
  if (!pubkey) return null;

  const filter = { kinds: [KIND_BADGE_PREFS], authors: [pubkey], "#d": ["badge-prefs"], limit: 10 };
  const events = await fetchEventsFromRelays(filter, options);
  events.sort((a, b) => (toNumberOrNull(b?.created_at) ?? 0) - (toNumberOrNull(a?.created_at) ?? 0));
  const latest = events[0];
  if (!latest || typeof latest.content !== "string") return null;

  const prefs = safeParseJsonObject(latest.content);
  const hidden = Array.isArray(prefs.hidden) ? prefs.hidden.filter((x) => typeof x === "string" && x.trim()) : [];
  return { pubkey, created_at: toNumberOrNull(latest.created_at) ?? 0, hidden };
}

function safeParseJsonObject(raw) {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function publishBadgePrefs({ hidden, relays } = {}) {
  if (!window.nostr || typeof window.nostr.signEvent !== "function") {
    throw new Error("Missing signer (NIP-07).");
  }

  const pubkey = normalizeHexPubkey(await window.nostr.getPublicKey?.());
  if (!pubkey) throw new Error("Missing signer pubkey.");

  const hiddenList = Array.isArray(hidden)
    ? Array.from(new Set(hidden.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean))).slice(0, 200)
    : [];

  const now = Math.floor(Date.now() / 1000);
  const unsignedEvent = {
    kind: KIND_BADGE_PREFS,
    created_at: now,
    tags: [
      ["d", "badge-prefs"],
      ["t", APP_TAG],
      ["t", "prefs"],
    ],
    content: JSON.stringify({ hidden: hiddenList }),
    pubkey,
  };

  const signedEvent = await window.nostr.signEvent(unsignedEvent);
  const results = await publishEventToRelays(relays || RELAYS, signedEvent);
  return { signedEvent, results };
}

export async function canAwardBadge({ currentUserPubkeyHex, unitRef } = {}, options = {}) {
  const currentUser = normalizeHexPubkey(currentUserPubkeyHex);
  const uref = typeof unitRef === "string" ? unitRef.trim() : "";
  if (!currentUser || !uref) return { ok: false, reason: "missing_inputs" };

  const badge = await fetchBadgeDefinitionForUnit(uref, options);
  if (!badge) return { ok: false, reason: "missing_badge_definition" };
  if (normalizeHexPubkey(badge.pubkey) === currentUser) return { ok: true, reason: "badge_creator", badge };

  const { awards } = await fetchAwardedBadges(currentUser, { ...options, limit: 200 });
  const has = awards.some((ev) => getTagValues(ev?.tags, "a").includes(badge.address));
  if (has) return { ok: true, reason: "badge_holder", badge };
  return { ok: false, reason: "not_qualified", badge };
}

export async function fetchCommunityPosts(options = {}) {
  const limit = toNumberOrNull(options.limit) ?? 50;
  const filter = { kinds: [1], "#t": [APP_TAG], limit };

  const events = await fetchEventsFromRelays(filter, options);
  events.sort((a, b) => (toNumberOrNull(b?.created_at) ?? 0) - (toNumberOrNull(a?.created_at) ?? 0));
  return events.slice(0, limit);
}

export async function fetchPostById(eventId, options = {}) {
  const id = typeof eventId === "string" ? eventId.trim() : "";
  if (!id) return null;

  const filter = { ids: [id] };
  const events = await fetchEventsFromRelays(filter, options);
  const match = events.find((ev) => typeof ev?.id === "string" && ev.id === id) || null;
  if (!match) return null;
  if (toNumberOrNull(match.kind) !== 1) return null;
  return match;
}

export async function fetchProfile(pubkeyHex, options = {}) {
  const pubkey = normalizeHexPubkey(pubkeyHex);
  if (!pubkey) return null;

  const filter = { kinds: [0], authors: [pubkey], limit: 5 };
  const events = await fetchEventsFromRelays(filter, options);
  events.sort((a, b) => (toNumberOrNull(b?.created_at) ?? 0) - (toNumberOrNull(a?.created_at) ?? 0));

  const latest = events[0];
  if (!latest || typeof latest.content !== "string") return null;

  let profile;
  try {
    profile = JSON.parse(latest.content);
  } catch {
    profile = null;
  }
  if (!profile || typeof profile !== "object") profile = {};
  return { pubkey, created_at: toNumberOrNull(latest.created_at) ?? 0, ...profile };
}

export async function fetchProfiles(pubkeysHex, options = {}) {
  const raw = Array.isArray(pubkeysHex) ? pubkeysHex : [];
  const unique = [];
  const seen = new Set();
  for (const pk of raw) {
    const pubkey = normalizeHexPubkey(pk);
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    unique.push(pubkey);
  }
  if (unique.length === 0) return {};

  const limit = toNumberOrNull(options.limit) ?? Math.min(50, unique.length * 3);
  const filter = { kinds: [0], authors: unique.slice(0, 60), limit };
  const events = await fetchEventsFromRelays(filter, options);

  const latestByPubkey = new Map(); // pubkey -> event
  for (const ev of events) {
    const pubkey = normalizeHexPubkey(ev?.pubkey);
    if (!pubkey) continue;
    const createdAt = toNumberOrNull(ev?.created_at) ?? 0;
    const prev = latestByPubkey.get(pubkey);
    const prevAt = toNumberOrNull(prev?.created_at) ?? 0;
    if (!prev || createdAt > prevAt) latestByPubkey.set(pubkey, ev);
  }

  const out = {};
  for (const [pubkey, ev] of latestByPubkey.entries()) {
    if (typeof ev?.content !== "string") continue;
    let profile;
    try {
      profile = JSON.parse(ev.content);
    } catch {
      profile = null;
    }
    if (!profile || typeof profile !== "object") profile = {};
    out[pubkey] = { pubkey, created_at: toNumberOrNull(ev?.created_at) ?? 0, ...profile };
  }
  return out;
}

export async function fetchPinnedEventIds(pubkeyHex, options = {}) {
  // NIP-51 pin list is kind 10001 (replaceable).
  const pubkey = normalizeHexPubkey(pubkeyHex);
  if (!pubkey) return [];

  const filter = { kinds: [10001], authors: [pubkey], limit: 5 };
  const events = await fetchEventsFromRelays(filter, options);
  events.sort((a, b) => (toNumberOrNull(b?.created_at) ?? 0) - (toNumberOrNull(a?.created_at) ?? 0));

  const latest = events[0];
  const tags = Array.isArray(latest?.tags) ? latest.tags : [];
  const ids = [];
  const seen = new Set();
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== "e") continue;
    const id = typeof tag[1] === "string" ? tag[1].trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 3) break;
  }
  return ids;
}

export async function fetchYoyostrPostsByAuthor(pubkeyHex, options = {}) {
  const pubkey = normalizeHexPubkey(pubkeyHex);
  if (!pubkey) return [];

  const limit = toNumberOrNull(options.limit) ?? 50;
  const filter = { kinds: [1], authors: [pubkey], "#t": [APP_TAG], limit };
  const events = await fetchEventsFromRelays(filter, options);
  events.sort((a, b) => (toNumberOrNull(b?.created_at) ?? 0) - (toNumberOrNull(a?.created_at) ?? 0));
  return events.slice(0, limit);
}

export async function fetchProofsForUnit(unitRef, options = {}) {
  const uref = typeof unitRef === "string" ? unitRef.trim() : "";
  if (!uref) return [];

  const limit = toNumberOrNull(options.limit) ?? 30;
  const filter = { kinds: [1], "#t": [APP_TAG, uref, "type:proof"], limit };
  const events = await fetchEventsFromRelays(filter, options);
  const filtered = events.filter(
    (ev) =>
      hasTagValue(ev?.tags, "t", APP_TAG) &&
      hasTagValue(ev?.tags, "t", uref) &&
      hasTagValue(ev?.tags, "t", "type:proof")
  );
  filtered.sort((a, b) => (toNumberOrNull(b?.created_at) ?? 0) - (toNumberOrNull(a?.created_at) ?? 0));
  return filtered.slice(0, limit);
}

export async function fetchAssertionsForProof(proofId, options = {}) {
  const id = typeof proofId === "string" ? proofId.trim() : "";
  if (!id) return [];

  const limit = toNumberOrNull(options.limit) ?? 200;
  const filter = { kinds: [1], "#e": [id], "#t": ["type:assertion", APP_TAG], limit };
  const events = await fetchEventsFromRelays(filter, options);
  const filtered = events.filter(
    (ev) =>
      hasTagValue(ev?.tags, "e", id) &&
      hasTagValue(ev?.tags, "t", APP_TAG) &&
      hasTagValue(ev?.tags, "t", "type:assertion")
  );
  filtered.sort((a, b) => (toNumberOrNull(b?.created_at) ?? 0) - (toNumberOrNull(a?.created_at) ?? 0));
  return filtered.slice(0, limit);
}
