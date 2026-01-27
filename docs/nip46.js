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
const TRACE_LIMIT = 200;
const hookedRelays = new WeakSet();

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isDebugEnabled() {
  if (typeof window === "undefined") return false;
  if (window?.YOYOSTR_DEBUG) return true;
  const search = window.location?.search || "";
  const hash = window.location?.hash || "";
  const searchParams = new URLSearchParams(search);
  if (searchParams.get("debug") === "1") return true;
  const hashParams = new URLSearchParams((hash.split("?")[1] || "").trim());
  return hashParams.get("debug") === "1";
}

function nip46DebugLog(step, data) {
  if (!isDebugEnabled()) return;
  const entry = {
    t: new Date().toISOString(),
    step,
    data,
  };
  try {
    console.debug("[nip46]", step, data || "");
  } catch {
    // ignore
  }
  if (typeof window === "undefined") return;
  const key = "__YOYOSTR_NIP46_TRACE";
  const trace = Array.isArray(window[key]) ? window[key] : [];
  trace.push(entry);
  if (trace.length > TRACE_LIMIT) {
    trace.splice(0, trace.length - TRACE_LIMIT);
  }
  window[key] = trace;
}

function formatEventSummary(evt) {
  const tags = Array.isArray(evt?.tags) ? evt.tags : [];
  const tagsSummary = tags
    .slice(0, 8)
    .map((tag) => {
      if (!Array.isArray(tag)) return "";
      const key = tag[0];
      const value = tag.length > 1 ? String(tag[1] ?? "") : "";
      if (!key) return "";
      return value ? `${key}:${value.slice(0, 32)}` : key;
    })
    .filter(Boolean);
  return {
    id: evt?.id,
    kind: evt?.kind,
    pubkey: evt?.pubkey,
    created_at: evt?.created_at,
    tagsSummary,
    contentLen: typeof evt?.content === "string" ? evt.content.length : 0,
  };
}

function relayLabel(relay) {
  if (!relay) return "";
  if (typeof relay === "string") return relay;
  if (typeof relay.url === "string") return relay.url;
  if (relay.url && typeof relay.url.toString === "function") return relay.url.toString();
  return "";
}

function attachRelayHooks(relay, relayUrl, context) {
  if (!relay || typeof relay.on !== "function") return;
  if (hookedRelays.has(relay)) return;
  hookedRelays.add(relay);
  try {
    relay.on("connect", () => nip46DebugLog("relay connected", { relay: relayUrl, context }));
    relay.on("disconnect", () => nip46DebugLog("relay closed", { relay: relayUrl, context }));
    relay.on("close", () => nip46DebugLog("relay closed", { relay: relayUrl, context }));
    relay.on("error", (err) =>
      nip46DebugLog("relay error", { relay: relayUrl, context, error: err?.message || String(err) })
    );
  } catch {
    // ignore
  }
}

function trackRelayConnections(relays, context) {
  if (!isDebugEnabled()) return;
  const list = normalizeRelays(relays);
  for (const relayUrl of list) {
    nip46DebugLog("relay connect attempt", { relay: relayUrl, context });
    try {
      const existing = pool?.relays?.get ? pool.relays.get(relayUrl) : pool?.relays?.[relayUrl];
      if (existing) attachRelayHooks(existing, relayUrl, context);
    } catch {
      // ignore
    }
    if (typeof pool.ensureRelay === "function") {
      try {
        const maybeRelay = pool.ensureRelay(relayUrl);
        Promise.resolve(maybeRelay)
          .then((relay) => {
            nip46DebugLog("relay connected", { relay: relayUrl, context });
            attachRelayHooks(relay, relayUrl, context);
          })
          .catch((err) => {
            nip46DebugLog("relay error", {
              relay: relayUrl,
              context,
              error: err?.message || String(err),
            });
          });
      } catch (err) {
        nip46DebugLog("relay error", {
          relay: relayUrl,
          context,
          error: err?.message || String(err),
        });
      }
    }
  }
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
  const payloadJson = JSON.stringify(payload);
  nip46DebugLog("request built", {
    method: payload?.method || "",
    payloadLength: payloadJson.length,
    remotePubkey,
  });
  let content;
  try {
    content = await encryptPayload(session.clientPrivkey, remotePubkey, payloadJson);
    nip46DebugLog("encrypt ok", { method: payload?.method || "", payloadLength: payloadJson.length });
  } catch (err) {
    nip46DebugLog("encrypt error", {
      method: payload?.method || "",
      error: err?.message || String(err),
    });
    throw err;
  }
  const unsignedEvent = {
    kind: REQUEST_KIND,
    created_at: nowSeconds(),
    tags: [["p", remotePubkey]],
    content,
  };
  const signed = finalizeEvent(unsignedEvent, hexToBytes(session.clientPrivkey));
  nip46DebugLog("request signed", {
    eventId: signed.id,
    kind: signed.kind,
    relayCount: relays.length,
  });
  trackRelayConnections(relays, "publish");
  const pubs = pool.publish(relays, signed);
  const publishTasks = Array.isArray(pubs) ? pubs : [pubs];
  relays.forEach((relayUrl) => {
    nip46DebugLog("publish start", { relay: relayUrl, eventId: signed.id });
  });
  const publishResults = publishTasks.map((pub, idx) =>
    Promise.resolve(pub)
      .then(() => {
        const relayUrl = relays[idx] || relays[0] || "";
        nip46DebugLog("publish ok", { relay: relayUrl, eventId: signed.id });
      })
      .catch((err) => {
        const relayUrl = relays[idx] || relays[0] || "";
        nip46DebugLog("publish error", {
          relay: relayUrl,
          eventId: signed.id,
          error: err?.message || String(err),
        });
      })
  );
  // Don't let stalled relay publishes block follow-up response waits.
  await Promise.race([
    Promise.allSettled(publishResults),
    new Promise((resolve) => setTimeout(resolve, 1200)),
  ]);
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
  nip46DebugLog("subscribe filters", { filters });
  nip46DebugLog("sub opened", { relays });
  trackRelayConnections(relays, "subscribe");
  const handleEvent = (event, relay) => {
    try {
      onEvent?.(event, relay);
    } catch {
      // ignore
    }
  };

  if (typeof pool.subscribeMany === "function") {
    const sub = pool.subscribeMany(relays, filters, { onevent: handleEvent });
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
    sub.on?.("event", (event, relay) => handleEvent(event, relay));
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
    const sub = pool.subscribe(relays, filters[0], { onevent: handleEvent });
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
  const method = options.method || "";
  const requestEventId = options.requestEventId || "";
  const relays = normalizeRelays(session?.relays);
  const startMs = Date.now();
  let eventsSeen = 0;
  let lastError = "";

  return withTimeout(
    new Promise((resolve, reject) => {
      let settled = false;
      let openedAuth = false;
      const sub = subscribeForResponses(session, async (event, relay) => {
        const relayUrl = relayLabel(relay);
        eventsSeen += 1;
        nip46DebugLog("event received", {
          relay: relayUrl,
          summary: formatEventSummary(event),
        });
        if (settled) {
          nip46DebugLog("event ignored", { reason: "already settled", relay: relayUrl });
          return;
        }
        if (!event?.content || typeof event.pubkey !== "string") {
          nip46DebugLog("event ignored", {
            reason: "missing content/pubkey",
            relay: relayUrl,
            summary: formatEventSummary(event),
          });
          return;
        }
        if (event.kind !== REQUEST_KIND) {
          nip46DebugLog("event ignored", {
            reason: "wrong kind",
            relay: relayUrl,
            summary: formatEventSummary(event),
          });
          return;
        }
        const fromPubkey = normalizeHex(event.pubkey);
        let decrypted;
        try {
          decrypted = await decryptPayload(session.clientPrivkey, fromPubkey, event.content);
        } catch (err) {
          lastError = err?.message || String(err);
          nip46DebugLog("decrypt error", { relay: relayUrl, error: lastError });
          return;
        }
        let payload;
        try {
          payload = JSON.parse(decrypted);
        } catch (err) {
          lastError = err?.message || String(err);
          nip46DebugLog("parse error", { relay: relayUrl, error: lastError });
          return;
        }
        if (!payload || typeof payload !== "object") {
          nip46DebugLog("event ignored", { reason: "missing payload", relay: relayUrl });
          return;
        }
        if (requestId && payload.id !== requestId) {
          nip46DebugLog("event ignored", {
            reason: "request id mismatch",
            relay: relayUrl,
            expected: requestId,
            received: payload.id,
          });
          return;
        }

        if (payload.result === "auth_url" && isProbablyUrl(payload.error) && !openedAuth) {
          openedAuth = true;
          nip46DebugLog("auth url", { relay: relayUrl });
          try {
            window.open(payload.error, "_blank", "noopener,noreferrer");
          } catch {
            // ignore
          }
          return;
        }

        nip46DebugLog("response parsed", {
          relay: relayUrl,
          resultType: typeof payload?.result,
          hasError: Boolean(payload?.error),
        });

        if (payload.error) {
          settled = true;
          lastError = String(payload.error);
          nip46DebugLog("response error", { relay: relayUrl, error: lastError });
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
    timeoutMs,
    () => {
      nip46DebugLog("timeout", {
        method,
        requestId,
        requestEventId,
        elapsedMs: Date.now() - startMs,
        relays,
        eventsSeen,
        lastError: lastError || null,
      });
    }
  );
}

export function createNip46Session(relays, label) {
  const clientPrivkeyBytes = generateSecretKey();
  const clientPrivkey = bytesToHex(clientPrivkeyBytes);
  const clientPubkey = getPublicKey(clientPrivkeyBytes);
  const now = new Date().toISOString();
  const session = {
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
  nip46DebugLog("session created", {
    clientPubkey: session.clientPubkey,
    remotePubkey: session.remotePubkey,
    relays: session.relays,
    secretLength: session.secret ? session.secret.length : 0,
    hasSecret: Boolean(session.secret),
  });
  return session;
}

export function buildNostrConnectUri(session, metadata = {}) {
  if (!session?.clientPubkey) throw new Error("Missing client pubkey.");
  const url = new URL(`nostrconnect://${session.clientPubkey}`);
  const relays = normalizeRelays(session.relays);
  nip46DebugLog("connect string built", {
    clientPubkey: session.clientPubkey,
    relays,
    hasSecret: Boolean(session.secret),
    secretLength: session.secret ? session.secret.length : 0,
  });
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
  nip46DebugLog("connect string parsed", {
    remotePubkey: pubkey,
    clientPubkey: null,
    relays,
    hasSecret: Boolean(secret),
    secretLength: secret.length,
    scheme,
  });
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
  const relays = normalizeRelays(session?.relays);
  const startMs = Date.now();
  let eventsSeen = 0;
  let lastError = "";
  const response = await withTimeout(
    new Promise((resolve, reject) => {
      let settled = false;
      const sub = subscribeForResponses(session, async (event, relay) => {
        const relayUrl = relayLabel(relay);
        eventsSeen += 1;
        nip46DebugLog("event received", {
          relay: relayUrl,
          summary: formatEventSummary(event),
        });
        if (settled) {
          nip46DebugLog("event ignored", { reason: "already settled", relay: relayUrl });
          return;
        }
        if (!event?.content || typeof event.pubkey !== "string") {
          nip46DebugLog("event ignored", {
            reason: "missing content/pubkey",
            relay: relayUrl,
            summary: formatEventSummary(event),
          });
          return;
        }
        if (event.kind !== REQUEST_KIND) {
          nip46DebugLog("event ignored", {
            reason: "wrong kind",
            relay: relayUrl,
            summary: formatEventSummary(event),
          });
          return;
        }
        const fromPubkey = normalizeHex(event.pubkey);
        let decrypted;
        try {
          decrypted = await decryptPayload(session.clientPrivkey, fromPubkey, event.content);
        } catch (err) {
          lastError = err?.message || String(err);
          nip46DebugLog("decrypt error", { relay: relayUrl, error: lastError });
          return;
        }
        let payload;
        try {
          payload = JSON.parse(decrypted);
        } catch (err) {
          lastError = err?.message || String(err);
          nip46DebugLog("parse error", { relay: relayUrl, error: lastError });
          return;
        }
        if (!payload || typeof payload !== "object") {
          nip46DebugLog("event ignored", { reason: "missing payload", relay: relayUrl });
          return;
        }

        if (payload.result === "auth_url" && isProbablyUrl(payload.error)) {
          nip46DebugLog("auth url", { relay: relayUrl });
          try {
            window.open(payload.error, "_blank", "noopener,noreferrer");
          } catch {
            // ignore
          }
          return;
        }

        nip46DebugLog("response parsed", {
          relay: relayUrl,
          resultType: typeof payload?.result,
          hasError: Boolean(payload?.error),
        });

        if (payload.error) {
          settled = true;
          lastError = String(payload.error);
          nip46DebugLog("response error", { relay: relayUrl, error: lastError });
          closeSub(sub);
          reject(new Error(String(payload.error)));
          return;
        }

        const result = typeof payload.result === "string" ? payload.result : "";
        if (session.secret && result !== session.secret) {
          nip46DebugLog("event ignored", {
            reason: "secret mismatch",
            relay: relayUrl,
          });
          return;
        }
        if (!session.secret && result !== "ack" && !result) {
          nip46DebugLog("event ignored", {
            reason: "unexpected connect result",
            relay: relayUrl,
          });
          return;
        }

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
    timeoutMs,
    () => {
      nip46DebugLog("timeout", {
        method: "wait_for_connect",
        requestId: null,
        requestEventId: null,
        elapsedMs: Date.now() - startMs,
        relays,
        eventsSeen,
        lastError: lastError || null,
      });
    }
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
  const requestEvent = await publishRequest(session, rp, { id, method: "connect", params });
  const { payload } = await waitForResponse(session, id, {
    signal,
    method: "connect",
    requestEventId: requestEvent?.id || "",
  });
  const result = typeof payload?.result === "string" ? payload.result : "";
  if (secret && result !== secret && result !== "ack") {
    throw new Error("Remote signer rejected the connection.");
  }
  return rp;
}

export async function nip46RequestPublicKey(session, timeoutMs, signal) {
  if (!session?.remotePubkey) throw new Error("Missing remote pubkey.");
  const id = makeId();
  const requestEvent = await publishRequest(session, session.remotePubkey, {
    id,
    method: "get_public_key",
    params: [],
  });
  const { payload } = await waitForResponse(session, id, {
    timeoutMs,
    signal,
    method: "get_public_key",
    requestEventId: requestEvent?.id || "",
  });
  const pubkey = typeof payload?.result === "string" ? payload.result : "";
  if (!pubkey) throw new Error("Missing public key from signer.");
  return normalizeHex(pubkey);
}

export async function nip46RequestSignEvent(session, event, timeoutMs, signal) {
  if (!session?.remotePubkey) throw new Error("Missing remote pubkey.");
  const id = makeId();
  const params = [JSON.stringify(event)];
  const requestEvent = await publishRequest(session, session.remotePubkey, {
    id,
    method: "sign_event",
    params,
  });
  const { payload } = await waitForResponse(session, id, {
    timeoutMs,
    signal,
    method: "sign_event",
    requestEventId: requestEvent?.id || "",
  });
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
