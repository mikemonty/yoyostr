import { KIND_TRACK, RELAYS } from "./config.js";

function getTagValue(tags, key) {
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === key && typeof tag[1] === "string") return tag[1];
  }
  return null;
}

function toNumberOrNull(value) {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
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

export async function fetchTracksFromRelays(options = {}) {
  const relays = Array.isArray(options.relays) ? options.relays : RELAYS;
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

      ws.addEventListener("error", () => markDone(relayUrl));
      ws.addEventListener("close", () => markDone(relayUrl));
    }

    // If relays is empty, resolve immediately.
    if (relays.length === 0) {
      clearTimeout(timer);
      resolve([]);
    }
  });
}
