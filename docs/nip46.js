import {
  SimplePool,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip04,
  nip44,
} from "https://esm.sh/nostr-tools@2.7.2";

export const REQUEST_KIND = 24133;
export const DEFAULT_TIMEOUT_MS = 60000;
export const DEFAULT_PERMS = "sign_event:1,get_public_key";

const pool = new SimplePool();

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeHex(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

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

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bytesToHex(arr);
}

function bytesToHex(bytes) {
  if (!bytes) return "";
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const clean = typeof hex === "string" ? hex.trim().toLowerCase().replace(/^0x/, "") : "";
  if (!clean) return new Uint8Array();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = clean.slice(i * 2, i * 2 + 2);
    out[i] = Number.parseInt(byte, 16);
  }
  return out;
}

function isProbablyUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return Boolean(parsed?.protocol?.startsWith("http"));
  } catch {
    return false;
  }
}

async function encryptPayload(privkeyHex, pubkeyHex, payload) {
  if (nip44?.v2?.utils?.getConversationKey && nip44?.v2?.encrypt) {
    try {
      const convKey = nip44.v2.utils.getConversationKey(privkeyHex, pubkeyHex);
      return nip44.v2.encrypt(payload, convKey);
    } catch {
      // fallback to nip04 below
    }
  }
  return nip04.encrypt(privkeyHex, pubkeyHex, payload);
}

async function decryptPayload(privkeyHex, pubkeyHex, payload) {
  if (nip44?.v2?.utils?.getConversationKey && nip44?.v2?.decrypt) {
    try {
      const convKey = nip44.v2.utils.getConversationKey(privkeyHex, pubkeyHex);
      return nip44.v2.decrypt(payload, convKey);
    } catch {
      // fallback to nip04 below
    }
  }
  return nip04.decrypt(privkeyHex, pubkeyHex, payload);
}

async function publishRequest(session, remotePubkey, payload) {
  const relays = normalizeRelays(session?.relays);
  if (!relays.length) throw new Error("Missing relays for NIP-46 session.");
  const content = await encryptPayload(session.clientPrivkey, remotePubkey, JSON.stringify(payload));
  const unsignedEvent = {
    kind: REQUEST_KIND,
    created_at: nowSeconds(),
    tags: [["p", remotePubkey]],
    content,
  };
  const signed = finalizeEvent(unsignedEvent, hexToBytes(session.clientPrivkey));
  const pubs = pool.publish(relays, signed);
  await Promise.allSettled(pubs);
  return signed;
}

function subscribeForResponses(session, onEvent) {
  const relays = normalizeRelays(session?.relays);
  if (!relays.length) throw new Error("Missing relays for NIP-46 session.");
  const since = Math.max(0, nowSeconds() - 60);
  const filters = [
    {
      kinds: [REQUEST_KIND],
      "#p": [session.clientPubkey],
      since,
    },
  ];

  if (typeof pool.subscribeMany === "function") {
    const sub = pool.subscribeMany(relays, filters, { onevent: onEvent });
    return {
      close: () => {
        try {
          sub?.close?.();
        } finally {
          try {
            pool.close?.(relays);
          } catch {
            // ignore
          }
        }
      },
    };
  }

  if (typeof pool.sub === "function") {
    const sub = pool.sub(relays, filters);
    sub.on?.("event", onEvent);
    return {
      close: () => {
        try {
          sub.unsub?.();
          sub.close?.();
          sub.unsubscribe?.();
        } finally {
          try {
            pool.close?.(relays);
          } catch {
            // ignore
          }
        }
      },
    };
  }

  if (typeof pool.subscribe === "function") {
    const sub = pool.subscribe(relays, filters[0], { onevent: onEvent });
    return {
      close: () => {
        try {
          sub.close?.();
          sub.unsub?.();
          sub.unsubscribe?.();
        } finally {
          try {
            pool.close?.(relays);
          } catch {
            // ignore
          }
        }
      },
    };
  }

  throw new Error("Nostr pool subscribe is not available.");
}

function closeSub(sub) {
  if (!sub) return;
  try {
    if (typeof sub.close === "function") sub.close();
    else if (typeof sub.unsub === "function") sub.unsub();
    else if (typeof sub.unsubscribe === "function") sub.unsubscribe();
  } catch {
    // ignore
  }
}

function withTimeout(promise, timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (typeof onTimeout === "function") onTimeout();
      reject(new Error("Request timed out."));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitForResponse(session, requestId, options = {}) {
  const timeoutMs =
    typeof options.timeoutMs === "number" ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const signal = options.signal;

  return withTimeout(
    new Promise((resolve, reject) => {
      let settled = false;
      let openedAuth = false;
      const sub = subscribeForResponses(session, async (event) => {
        if (settled || !event?.content || typeof event.pubkey !== "string") return;
        const fromPubkey = normalizeHex(event.pubkey);
        let decrypted;
        try {
          decrypted = await decryptPayload(session.clientPrivkey, fromPubkey, event.content);
        } catch {
          return;
        }
        let payload;
        try {
          payload = JSON.parse(decrypted);
        } catch {
          return;
        }
        if (!payload || typeof payload !== "object") return;
        if (requestId && payload.id !== requestId) return;

        if (payload.result === "auth_url" && isProbablyUrl(payload.error) && !openedAuth) {
          openedAuth = true;
          try {
            window.open(payload.error, "_blank", "noopener,noreferrer");
          } catch {
            // ignore
          }
          return;
        }

        if (payload.error) {
          settled = true;
          closeSub(sub);
          reject(new Error(String(payload.error)));
          return;
        }

        settled = true;
        closeSub(sub);
        resolve({ payload, event });
      });

      const onAbort = () => {
        if (settled) return;
        settled = true;
        closeSub(sub);
        reject(new Error("Request aborted."));
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }),
    timeoutMs
  );
}

export function createNip46Session(relays, label) {
  const clientPrivkeyBytes = generateSecretKey();
  const clientPrivkey = bytesToHex(clientPrivkeyBytes);
  const clientPubkey = getPublicKey(clientPrivkeyBytes);
  const now = new Date().toISOString();
  return {
    id: makeId(),
    createdAt: now,
    updatedAt: now,
    clientPrivkey,
    clientPubkey: normalizeHex(clientPubkey),
    remotePubkey: null,
    relays: normalizeRelays(relays),
    secret: randomHex(16),
    status: "pending",
    label: typeof label === "string" && label.trim() ? label.trim() : undefined,
  };
}

export function buildNostrConnectUri(session, metadata = {}) {
  if (!session?.clientPubkey) throw new Error("Missing client pubkey.");
  const url = new URL(`nostrconnect://${session.clientPubkey}`);
  const relays = normalizeRelays(session.relays);
  for (const relay of relays) url.searchParams.append("relay", relay);
  if (session.secret) url.searchParams.set("secret", session.secret);
  url.searchParams.set("perms", metadata?.perms || DEFAULT_PERMS);
  if (metadata?.name) url.searchParams.set("name", metadata.name);
  if (metadata?.url) url.searchParams.set("url", metadata.url);
  if (metadata?.image) url.searchParams.set("image", metadata.image);
  return url.toString();
}

export function parseConnectString(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const scheme = (url.protocol || "").replace(":", "");
  if (scheme !== "nostrconnect" && scheme !== "bunker") return null;
  let pubkey = normalizeHex(url.hostname);
  if (!pubkey) {
    pubkey = normalizeHex(url.pathname.replace(/^\/+/, ""));
  }
  const relays = url.searchParams.getAll("relay").map((r) => r.trim()).filter(Boolean);
  const secret = url.searchParams.get("secret") || "";
  const perms = url.searchParams.get("perms") || "";
  return {
    scheme,
    pubkey,
    relays,
    secret: secret || null,
    perms: perms || null,
  };
}

export async function nip46WaitForConnect(session, timeoutMs = DEFAULT_TIMEOUT_MS, signal) {
  if (!session?.clientPrivkey || !session?.clientPubkey) {
    throw new Error("Missing NIP-46 session keys.");
  }
  const response = await withTimeout(
    new Promise((resolve, reject) => {
      let settled = false;
      const sub = subscribeForResponses(session, async (event) => {
        if (settled || !event?.content || typeof event.pubkey !== "string") return;
        const fromPubkey = normalizeHex(event.pubkey);
        let decrypted;
        try {
          decrypted = await decryptPayload(session.clientPrivkey, fromPubkey, event.content);
        } catch {
          return;
        }
        let payload;
        try {
          payload = JSON.parse(decrypted);
        } catch {
          return;
        }
        if (!payload || typeof payload !== "object") return;

        if (payload.result === "auth_url" && isProbablyUrl(payload.error)) {
          try {
            window.open(payload.error, "_blank", "noopener,noreferrer");
          } catch {
            // ignore
          }
          return;
        }

        if (payload.error) {
          settled = true;
          closeSub(sub);
          reject(new Error(String(payload.error)));
          return;
        }

        const result = typeof payload.result === "string" ? payload.result : "";
        if (session.secret && result !== session.secret) return;
        if (!session.secret && result !== "ack" && !result) return;

        settled = true;
        closeSub(sub);
        resolve(fromPubkey);
      });

      const onAbort = () => {
        if (settled) return;
        settled = true;
        closeSub(sub);
        reject(new Error("Request aborted."));
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }),
    timeoutMs
  );

  return response;
}

export async function nip46ConnectWithBunker(session, remotePubkey, secret, perms, signal) {
  const rp = normalizeHex(remotePubkey);
  if (!rp) throw new Error("Missing remote signer pubkey.");
  const params = [rp];
  if (secret) params.push(secret);
  if (perms || DEFAULT_PERMS) params.push(perms || DEFAULT_PERMS);
  const id = makeId();
  await publishRequest(session, rp, { id, method: "connect", params });
  const { payload } = await waitForResponse(session, id, { signal });
  const result = typeof payload?.result === "string" ? payload.result : "";
  if (secret && result !== secret && result !== "ack") {
    throw new Error("Remote signer rejected the connection.");
  }
  return rp;
}

export async function nip46RequestPublicKey(session, timeoutMs, signal) {
  if (!session?.remotePubkey) throw new Error("Missing remote pubkey.");
  const id = makeId();
  await publishRequest(session, session.remotePubkey, { id, method: "get_public_key", params: [] });
  const { payload } = await waitForResponse(session, id, { timeoutMs, signal });
  const pubkey = typeof payload?.result === "string" ? payload.result : "";
  if (!pubkey) throw new Error("Missing public key from signer.");
  return normalizeHex(pubkey);
}

export async function nip46RequestSignEvent(session, event, timeoutMs, signal) {
  if (!session?.remotePubkey) throw new Error("Missing remote pubkey.");
  const id = makeId();
  const params = [JSON.stringify(event)];
  await publishRequest(session, session.remotePubkey, { id, method: "sign_event", params });
  const { payload } = await waitForResponse(session, id, { timeoutMs, signal });
  const signedRaw = typeof payload?.result === "string" ? payload.result : "";
  if (!signedRaw) throw new Error("Missing signed event.");
  let signed;
  try {
    signed = JSON.parse(signedRaw);
  } catch {
    throw new Error("Signed event response was invalid.");
  }
  return signed;
}
