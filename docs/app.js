import {
  APP_TAG,
  KIND_TRACK,
  KIND_UNIT,
  MAINTAINER_NPUB,
  MAINTAINER_PUBKEY_HEX,
  RELAYS,
} from "./config.js";
import {
  fetchAwardedBadges,
  fetchAllBadgeDefinitions,
  fetchBadgeDefinitionForUnit,
  fetchBadgeDefinitionByAddress,
  fetchBadgeDefinitionsForUnit,
  fetchBadgeAwardCounts,
  fetchBadgeAwardEventsForBadgeAddress,
  fetchBadgesCreatedBy,
  fetchBadgePrefs,
  fetchCommunityPosts,
  fetchPostById,
  fetchProfile,
  fetchProfiles,
  fetchProofsForUnit,
  fetchPinnedEventIds,
  fetchTracksFromRelays,
  fetchUnitsFromRelays,
  fetchYoyostrPostsByAuthor,
  publishBadgeAward,
  publishBadgeDefinition,
  publishBadgePrefs,
  publishEventToRelays,
} from "./nostr.js";
import { getEmbedInfo } from "./embed.js";
import { clearStoredPubkey, getStoredPubkey, signInWithNip07 } from "./auth.js";

async function loadFallbackTracks() {
  const res = await fetch("./data/tracks.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load fallback tracks.json: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.tracks) ? data.tracks : [];
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

function renderTracks(container, tracks) {
  container.innerHTML = "";

  if (!Array.isArray(tracks) || tracks.length === 0) {
    container.append(el("p", { class: "muted", text: "No tracks found." }));
    return;
  }

  for (const track of tracks) {
    const title = typeof track?.title === "string" ? track.title : "Untitled";
    const description = typeof track?.description === "string" ? track.description : "";
    const playlists = Array.isArray(track?.playlists) ? track.playlists : [];
    const trackId = typeof track?.id === "string" ? track.id : "";

    const links = el("div", { class: "track-links" });
    for (const p of playlists) {
      if (!p || typeof p.url !== "string") continue;
      const label = typeof p.label === "string" ? p.label : p.url;
      const a = el("a", { href: p.url, target: "_blank", rel: "noreferrer", text: label });
      a.addEventListener("click", (ev) => ev.stopPropagation());
      links.append(a);
    }

    const card = el("article", { class: "track-card" }, [
      el("h3", { text: title }),
      el("p", { text: description }),
      links,
    ]);
    if (trackId) {
      card.tabIndex = 0;
      card.style.cursor = "pointer";
      const go = () => (window.location.hash = `#/track/${encodeURIComponent(trackId)}`);
      card.addEventListener("click", go);
      card.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") go();
      });
    }
    container.append(card);
  }
}

function normalizeHexPubkey(pubkey) {
  return typeof pubkey === "string" ? pubkey.trim().toLowerCase() : "";
}

function shortHex(value) {
  const v = typeof value === "string" ? value.trim() : "";
  if (v.length <= 16) return v;
  return `${v.slice(0, 8)}…${v.slice(-4)}`;
}

function getBestDisplayName(profile, pubkeyHex) {
  const display =
    (typeof profile?.display_name === "string" && profile.display_name.trim()) ||
    (typeof profile?.name === "string" && profile.name.trim());
  return display || shortHex(pubkeyHex);
}

function getProfilePictureUrl(profile) {
  const url = typeof profile?.picture === "string" ? profile.picture.trim() : "";
  return url || "";
}

function getProfileBannerUrl(profile) {
  const url = typeof profile?.banner === "string" ? profile.banner.trim() : "";
  return url || "";
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

function formatTimestamp(ts) {
  const sec = typeof ts === "number" ? ts : Number(ts);
  if (!Number.isFinite(sec) || sec <= 0) return "";
  try {
    return new Date(sec * 1000).toLocaleString();
  } catch {
    return "";
  }
}

function cleanUrlToken(token) {
  const raw = typeof token === "string" ? token.trim() : "";
  if (!raw) return "";
  return raw.replace(/[),.]+$/g, "");
}

function extractUrlsFromText(text) {
  const t = typeof text === "string" ? text : "";
  const matches = t.match(/\b(?:https?:\/\/|www\.|youtu\.be\/|youtube\.com\/)\S+/gi) || [];
  return matches.map(cleanUrlToken).filter(Boolean);
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

function getPostTypeFromTags(tags) {
  const tValues = getTagValues(tags, "t");
  for (const t of tValues) {
    if (!t.startsWith("type:")) continue;
    const type = t.slice("type:".length).trim();
    if (!type) continue;
    return type;
  }
  return null;
}

function parseUnitRef(unitRef) {
  const raw = typeof unitRef === "string" ? unitRef.trim() : "";
  const m = raw.match(/^unit:([^:]+):([^:]+)$/);
  if (!m) return null;
  return { trackId: m[1], unitId: m[2] };
}

function slugifyId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function makeUniqueBadgeD({ unitRef, name, existingDSet }) {
  const base = `badge:${unitRef}:${slugifyId(name) || Math.random().toString(36).slice(2, 8)}`;
  if (!existingDSet?.has?.(base)) return base;
  for (let i = 0; i < 20; i++) {
    const next = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    if (!existingDSet.has(next)) return next;
  }
  return `${base}-${Date.now()}`;
}

function getEmbeddableUrlForEvent(event) {
  const urls = [];
  urls.push(...getTagValues(event?.tags, "r"));
  urls.push(...extractUrlsFromText(event?.content));
  for (const url of urls) {
    const info = getEmbedInfo(url);
    if (info?.isEmbeddable && info?.embedUrl) return { url, info };
  }
  return null;
}

function setStatus(statusEl, message, options = {}) {
  if (!statusEl) return;
  statusEl.textContent = message || "";
  const isError = Boolean(options.error);
  statusEl.style.color = isError ? "var(--status-error-color, #b00020)" : "";
}

function logRelayResults(label, results) {
  try {
    console.log(label, results);
  } catch {
    // ignore
  }
  for (const [relayUrl, result] of Object.entries(results || {})) {
    const okText = result?.ok ? "OK" : "FAIL";
    const msg = typeof result?.message === "string" && result.message ? ` - ${result.message}` : "";
    const timeoutText = result?.timeout ? " (timeout)" : "";
    try {
      console.log(`${relayUrl}: ${okText}${timeoutText}${msg}`);
    } catch {
      // ignore
    }
  }
}

function showVisibleError(error, options = {}) {
  const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : String(error));
  const title = typeof options.title === "string" && options.title.trim() ? options.title.trim() : "Error";

  try {
    console.error(err);
  } catch {
    // ignore
  }

  let statusEl = options.statusEl;
  let appEl = options.appEl;
  try {
    const appRoot = document.getElementById("app");
    const viewEl = appRoot?.querySelector?.("#view");
    statusEl = statusEl || document.getElementById("status") || appRoot?.querySelector?.("#status");
    appEl = appEl || viewEl || appRoot;
  } catch {
    // ignore
  }

  const message = err?.message ? `${title}: ${err.message}` : title;
  try {
    setStatus(statusEl, message, { error: true });
  } catch {
    // ignore
  }

  if (!appEl) return;
  try {
    appEl.innerHTML = "";
    const h = document.createElement("h2");
    h.textContent = title;
    h.style.margin = "0 0 12px";

    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = err?.message || String(err);

    const pre = document.createElement("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.overflowX = "auto";
    pre.style.border = "1px solid rgba(127,127,127,.25)";
    pre.style.borderRadius = "12px";
    pre.style.padding = "12px";
    pre.textContent = err?.stack || String(err);

    const a = document.createElement("a");
    a.href = "#/";
    a.textContent = "Back to Home";

    appEl.append(h, p, a, pre);
  } catch {
    // ignore rendering failures
  }
}

function ensureAppShell(appRoot) {
  if (!appRoot) return { statusEl: null, viewEl: null };

  let statusEl = appRoot.querySelector?.("#status");
  if (!statusEl) {
    statusEl = document.createElement("div");
    statusEl.id = "status";
    statusEl.className = "muted";
    statusEl.setAttribute("role", "status");
    statusEl.setAttribute("aria-live", "polite");
    appRoot.prepend(statusEl);
  }

  let viewEl = appRoot.querySelector?.("#view");
  if (!viewEl) {
    viewEl = document.createElement("div");
    viewEl.id = "view";
    appRoot.append(viewEl);
  }

  return { statusEl, viewEl };
}

function parseRoute(hash) {
  const h = typeof hash === "string" ? hash : "";
  const cleaned = h.startsWith("#") ? h.slice(1) : h;
  const path = cleaned.startsWith("/") ? cleaned : cleaned ? `/${cleaned}` : "/";

  if (/^\/community\/?$/.test(path)) return { name: "community" };
  if (/^\/badges\/?$/.test(path)) return { name: "badges" };
  const badgeMatch = path.match(/^\/badge\/([^/]+)\/?$/);
  if (badgeMatch) {
    let address = "";
    try {
      address = decodeURIComponent(badgeMatch[1]);
    } catch {
      address = String(badgeMatch[1] || "");
    }
    return { name: "badge_view", address };
  }
  if (/^\/profile\/?$/.test(path)) return { name: "profile" };

  const profileMatch = path.match(/^\/p\/([^/]+)\/?$/);
  if (profileMatch) {
    let pubkeyHex = "";
    try {
      pubkeyHex = decodeURIComponent(profileMatch[1]);
    } catch {
      pubkeyHex = String(profileMatch[1] || "");
    }
    return { name: "profile_view", pubkeyHex };
  }

  if (path.startsWith("/post/")) {
    let raw = path.slice("/post/".length);
    const slash = raw.indexOf("/");
    if (slash >= 0) raw = raw.slice(0, slash);
    let eventId = "";
    try {
      eventId = decodeURIComponent(raw);
    } catch {
      eventId = String(raw || "");
    }
    eventId = eventId.trim();
    if (eventId) return { name: "post_view", eventId };
  }

  const unitMatch = path.match(/^\/track\/([^/]+)\/unit\/([^/]+)\/?$/);
  if (unitMatch) {
    return {
      name: "unit",
      trackId: decodeURIComponent(unitMatch[1]),
      unitId: decodeURIComponent(unitMatch[2]),
    };
  }

  const trackMatch = path.match(/^\/track\/([^/]+)\/?$/);
  if (trackMatch) {
    return { name: "track", trackId: decodeURIComponent(trackMatch[1]) };
  }

  if (/^\/?$/.test(path)) return { name: "home" };
  return { name: "not_found", path };
}

function createAdminDialog() {
  const dialog = document.createElement("dialog");
  dialog.style.maxWidth = "820px";
  dialog.style.width = "100%";

  const title = document.createElement("h3");
  title.textContent = "Admin";
  title.style.margin = "0 0 10px";

  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = `Maintainer: ${MAINTAINER_NPUB}`;
  hint.style.margin = "0 0 12px";

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "10px";
  actions.style.alignItems = "center";
  actions.style.marginBottom = "10px";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => dialog.close());

  actions.append(closeBtn);

  const fieldRow = (labelText, inputEl) => {
    const wrap = document.createElement("div");
    wrap.style.display = "grid";
    wrap.style.gap = "6px";
    wrap.style.marginBottom = "10px";

    const label = document.createElement("label");
    label.textContent = labelText;
    label.style.fontSize = "13px";
    label.style.opacity = "0.9";
    wrap.append(label, inputEl);
    return wrap;
  };

  const trackTitle = document.createElement("h4");
  trackTitle.textContent = "Track Management";
  trackTitle.style.margin = "14px 0 8px";

  const trackNote = document.createElement("p");
  trackNote.className = "muted";
  trackNote.textContent = "Edit and republish tracks (kind 30078) using the same d tag.";
  trackNote.style.margin = "0 0 12px";

  const trackBox = document.createElement("div");
  trackBox.style.border = "1px solid rgba(127,127,127,.25)";
  trackBox.style.borderRadius = "12px";
  trackBox.style.padding = "12px";
  trackBox.style.marginBottom = "12px";

  const tmTrack = document.createElement("select");
  const tmId = document.createElement("input");
  tmId.readOnly = true;
  tmId.placeholder = "track id";
  const tmTitle = document.createElement("input");
  tmTitle.placeholder = "title";
  const tmOrder = document.createElement("input");
  tmOrder.type = "number";
  tmOrder.placeholder = "order (optional)";
  const tmDesc = document.createElement("textarea");
  tmDesc.rows = 3;
  tmDesc.placeholder = "description";

  const tmPlaylists = document.createElement("div");
  tmPlaylists.style.display = "grid";
  tmPlaylists.style.gap = "8px";

  const tmAddPlaylist = document.createElement("button");
  tmAddPlaylist.type = "button";
  tmAddPlaylist.textContent = "Add playlist row";

  const tmPlaylistsWrap = document.createElement("div");
  tmPlaylistsWrap.append(tmPlaylists, tmAddPlaylist);

  const tmPublish = document.createElement("button");
  tmPublish.type = "button";
  tmPublish.textContent = "Publish Track Update";

  const tmOverwrite = document.createElement("button");
  tmOverwrite.type = "button";
  tmOverwrite.textContent = "Overwrite ALL tracks from local fallback";

  const tmTrackRow = fieldRow("Track", tmTrack);
  const tmIdRow = fieldRow("Track ID (locked)", tmId);
  const tmOverwriteWrap = document.createElement("div");
  tmOverwriteWrap.append(el("div", { style: "height: 10px;" }), tmOverwrite);

  trackBox.append(
    tmTrackRow,
    tmIdRow,
    fieldRow("Title", tmTitle),
    fieldRow("Description", tmDesc),
    fieldRow("Order", tmOrder),
    fieldRow("Playlists", tmPlaylistsWrap),
    tmPublish,
    tmOverwriteWrap
  );

  const unitTitle = document.createElement("h4");
  unitTitle.textContent = "Lesson Units";
  unitTitle.style.margin = "14px 0 8px";

  const unitNote = document.createElement("p");
  unitNote.className = "muted";
  unitNote.textContent = "Create units and add videos (kind 30079).";
  unitNote.style.margin = "0 0 12px";

  const createUnitBox = document.createElement("div");
  createUnitBox.style.border = "1px solid rgba(127,127,127,.25)";
  createUnitBox.style.borderRadius = "12px";
  createUnitBox.style.padding = "12px";
  createUnitBox.style.marginBottom = "12px";

  const createUnitHeader = document.createElement("h5");
  createUnitHeader.textContent = "Create Unit";
  createUnitHeader.style.margin = "0 0 10px";

  const cuTrack = document.createElement("select");
  const cuUnitId = document.createElement("input");
  cuUnitId.placeholder = "unit slug (e.g. trapeze)";
  const cuTitle = document.createElement("input");
  cuTitle.placeholder = "title";
  const cuType = document.createElement("select");
  for (const v of ["trick", "technique", "diy", "maintenance", "other"]) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    cuType.append(opt);
  }
  const cuOrder = document.createElement("input");
  cuOrder.type = "number";
  cuOrder.placeholder = "order";
  const cuDesc = document.createElement("textarea");
  cuDesc.rows = 3;
  cuDesc.placeholder = "optional";
  const cuVideoTitle = document.createElement("input");
  cuVideoTitle.placeholder = "video title";
  const cuVideoUrl = document.createElement("input");
  cuVideoUrl.placeholder = "video url";
  const cuPreview = document.createElement("div");
  const cuPublish = document.createElement("button");
  cuPublish.type = "button";
  cuPublish.textContent = "Publish Unit";

  const cuTrackRow = fieldRow("Track", cuTrack);
  const cuPreviewRow = fieldRow("Embed preview", cuPreview);

  createUnitBox.append(
    createUnitHeader,
    cuTrackRow,
    fieldRow("Unit ID", cuUnitId),
    fieldRow("Title", cuTitle),
    fieldRow("Type", cuType),
    fieldRow("Order", cuOrder),
    fieldRow("Description", cuDesc),
    fieldRow("First video title", cuVideoTitle),
    fieldRow("First video URL", cuVideoUrl),
    cuPreviewRow,
    cuPublish
  );

  const editUnitBox = document.createElement("div");
  editUnitBox.style.border = "1px solid rgba(127,127,127,.25)";
  editUnitBox.style.borderRadius = "12px";
  editUnitBox.style.padding = "12px";
  editUnitBox.style.marginBottom = "12px";

  const editUnitHeader = document.createElement("h5");
  editUnitHeader.textContent = "Edit Unit";
  editUnitHeader.style.margin = "0 0 10px";

  const euTrack = document.createElement("select");
  const euUnit = document.createElement("select");
  const euUnitId = document.createElement("input");
  euUnitId.readOnly = true;
  euUnitId.placeholder = "unitId";
  const euTitle = document.createElement("input");
  euTitle.placeholder = "title";
  const euType = document.createElement("select");
  for (const v of ["trick", "technique", "diy", "maintenance", "other"]) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    euType.append(opt);
  }
  const euOrder = document.createElement("input");
  euOrder.type = "number";
  euOrder.placeholder = "order";
  const euDesc = document.createElement("textarea");
  euDesc.rows = 3;
  euDesc.placeholder = "optional";

  const euSoftDelete = document.createElement("input");
  euSoftDelete.type = "checkbox";
  const euSoftDeleteWrap = document.createElement("label");
  euSoftDeleteWrap.style.display = "flex";
  euSoftDeleteWrap.style.gap = "8px";
  euSoftDeleteWrap.style.alignItems = "center";
  euSoftDeleteWrap.append(euSoftDelete, document.createTextNode("Soft delete (hide from users)"));

  const euVideos = document.createElement("div");
  euVideos.style.display = "grid";
  euVideos.style.gap = "8px";

  const euAddVideo = document.createElement("button");
  euAddVideo.type = "button";
  euAddVideo.textContent = "Add video row";

  const euVideosWrap = document.createElement("div");
  euVideosWrap.append(euVideos, euAddVideo);

  const euPreview = document.createElement("div");
  const euPublish = document.createElement("button");
  euPublish.type = "button";
  euPublish.textContent = "Publish Unit Update";

  const euTrackRow = fieldRow("Track", euTrack);
  const euUnitRow = fieldRow("Unit", euUnit);
  const euUnitIdRow = fieldRow("Unit ID (locked)", euUnitId);
  const euSoftDeleteRow = fieldRow("Visibility", euSoftDeleteWrap);
  const euPreviewRow = fieldRow("Embed preview", euPreview);

  editUnitBox.append(
    editUnitHeader,
    euTrackRow,
    euUnitRow,
    euUnitIdRow,
    fieldRow("Title", euTitle),
    fieldRow("Type", euType),
    fieldRow("Order", euOrder),
    fieldRow("Description", euDesc),
    euSoftDeleteRow,
    fieldRow("Videos", euVideosWrap),
    euPreviewRow,
    euPublish
  );

  const addVideoBox = document.createElement("div");
  addVideoBox.style.border = "1px solid rgba(127,127,127,.25)";
  addVideoBox.style.borderRadius = "12px";
  addVideoBox.style.padding = "12px";
  addVideoBox.style.marginBottom = "12px";

  const addVideoHeader = document.createElement("h5");
  addVideoHeader.textContent = "Add Video to Unit";
  addVideoHeader.style.margin = "0 0 10px";

  const avTrack = document.createElement("select");
  const avUnit = document.createElement("select");
  const avVideoTitle = document.createElement("input");
  avVideoTitle.placeholder = "video title";
  const avVideoUrl = document.createElement("input");
  avVideoUrl.placeholder = "video url";
  const avPreview = document.createElement("div");
  const avPublish = document.createElement("button");
  avPublish.type = "button";
  avPublish.textContent = "Publish Video";

  const avTrackRow = fieldRow("Track", avTrack);
  const avUnitRow = fieldRow("Unit", avUnit);
  const avPreviewRow = fieldRow("Embed preview", avPreview);

  addVideoBox.append(
    addVideoHeader,
    avTrackRow,
    avUnitRow,
    fieldRow("Video title", avVideoTitle),
    fieldRow("Video URL", avVideoUrl),
    avPreviewRow,
    avPublish
  );

  const log = document.createElement("textarea");
  log.readOnly = true;
  log.rows = 12;
  log.style.width = "100%";
  log.style.boxSizing = "border-box";
  log.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, monospace";
  log.placeholder = "Log…";

  const trackSection = document.createElement("div");
  trackSection.append(trackTitle, trackNote, trackBox);

  const unitHeading = document.createElement("div");
  unitHeading.append(unitTitle, unitNote);

  const createUnitSection = document.createElement("div");
  createUnitSection.append(createUnitBox);

  const editUnitSection = document.createElement("div");
  editUnitSection.append(editUnitBox);

  const addVideoSection = document.createElement("div");
  addVideoSection.append(addVideoBox);

  dialog.append(
    title,
    hint,
    actions,
    trackSection,
    unitHeading,
    createUnitSection,
    editUnitSection,
    addVideoSection,
    log
  );
  document.body.append(dialog);

  return {
    dialog,
    log,
    sections: {
      track: trackSection,
      unitHeading,
      createUnit: createUnitSection,
      editUnit: editUnitSection,
      addVideo: addVideoSection,
      log,
    },
    rows: {
      trackMgmtTrackRow: tmTrackRow,
      trackMgmtTrackIdRow: tmIdRow,
      trackMgmtOverwriteWrap: tmOverwriteWrap,
      createUnitTrackRow: cuTrackRow,
      createUnitPreviewRow: cuPreviewRow,
      editUnitTrackRow: euTrackRow,
      editUnitUnitRow: euUnitRow,
      editUnitUnitIdRow: euUnitIdRow,
      editUnitSoftDeleteRow: euSoftDeleteRow,
      editUnitPreviewRow: euPreviewRow,
      addVideoTrackRow: avTrackRow,
      addVideoUnitRow: avUnitRow,
      addVideoPreviewRow: avPreviewRow,
    },
    trackMgmt: {
      track: tmTrack,
      trackId: tmId,
      title: tmTitle,
      description: tmDesc,
      order: tmOrder,
      playlists: tmPlaylists,
      addPlaylistBtn: tmAddPlaylist,
      publishBtn: tmPublish,
      overwriteBtn: tmOverwrite,
    },
    createUnit: {
      track: cuTrack,
      unitId: cuUnitId,
      title: cuTitle,
      type: cuType,
      order: cuOrder,
      description: cuDesc,
      videoTitle: cuVideoTitle,
      videoUrl: cuVideoUrl,
      preview: cuPreview,
      publishBtn: cuPublish,
    },
    editUnit: {
      track: euTrack,
      unit: euUnit,
      unitId: euUnitId,
      title: euTitle,
      type: euType,
      order: euOrder,
      description: euDesc,
      softDelete: euSoftDelete,
      videos: euVideos,
      addVideoBtn: euAddVideo,
      preview: euPreview,
      publishBtn: euPublish,
    },
    addVideo: {
      track: avTrack,
      unit: avUnit,
      videoTitle: avVideoTitle,
      videoUrl: avVideoUrl,
      preview: avPreview,
      publishBtn: avPublish,
    },
  };
}

function appendLog(textarea, line) {
  if (!textarea) return;
  const next = `${line}\n`;
  textarea.value = (textarea.value || "") + next;
  textarea.scrollTop = textarea.scrollHeight;
}

async function loadTracksNostrFirst() {
  let tracks = [];
  try {
    tracks = await fetchTracksFromRelays();
  } catch {
    // Graceful fallback handled below.
  }

  if (!Array.isArray(tracks) || tracks.length === 0) {
    try {
      tracks = await loadFallbackTracks();
    } catch {
      tracks = [];
    }
  }
  return tracks;
}

async function loadUnitsNostr(trackId) {
  try {
    return await fetchUnitsFromRelays(trackId);
  } catch {
    return [];
  }
}

function renderTrackHeader(track) {
  const title = typeof track?.title === "string" ? track.title : "Untitled";
  const description = typeof track?.description === "string" ? track.description : "";
  return el("div", {}, [el("h2", { text: title, style: "margin: 0 0 6px;" }), el("p", { class: "muted", text: description })]);
}

  function renderUnitList(units, { trackId, isMaintainer } = {}) {
    if (!Array.isArray(units) || units.length === 0) return el("p", { class: "muted", text: "No units yet." });

    const list = el("ul", { class: "unit-list" });
    for (const unit of units) {
      if (unit?.deleted === true) continue;
      const title = typeof unit?.title === "string" ? unit.title : "Untitled unit";
      const type = typeof unit?.type === "string" ? unit.type : "other";
      const order = unit?.order !== undefined && unit?.order !== null ? String(unit.order) : "—";
      const unitId = typeof unit?.unitId === "string" ? unit.unitId : "";
      const description = typeof unit?.description === "string" ? unit.description : "";
      const videos = Array.isArray(unit?.videos) ? unit.videos : [];
      const firstVideoUrl = typeof videos?.[0]?.url === "string" ? videos[0].url : "";
      const embedInfo = getEmbedInfo(firstVideoUrl);
      const thumbnailUrl = typeof embedInfo?.thumbnailUrl === "string" ? embedInfo.thumbnailUrl : "";

      const href =
        trackId && unitId
          ? `#/track/${encodeURIComponent(trackId)}/unit/${encodeURIComponent(unitId)}`
          : "#/";

      const titleRow = el("div", { class: "unit-title-row" }, [el("div", { class: "unit-title", text: title })]);
      if (type) titleRow.append(el("span", { class: "unit-type", text: type }));

      const text = el("div", { class: "unit-text" }, [titleRow]);
      if (description) text.append(el("div", { class: "unit-desc muted", text: description }));
      if (isMaintainer) text.append(el("div", { class: "unit-meta muted", text: `Order: ${order}` }));

      const children = [];
      if (thumbnailUrl) {
        children.push(
          el("img", {
            class: "unit-thumb",
            src: thumbnailUrl,
            alt: "",
            loading: "lazy",
            decoding: "async",
          })
        );
      }
      children.push(text);

      const card = el("a", { class: "unit-row", href }, children);
      list.append(el("li", {}, [card]));
    }
    return list;
  }

function renderEmbedArea(video) {
  const url = typeof video?.url === "string" ? video.url : "";
  const title = typeof video?.title === "string" ? video.title : "";
  const info = getEmbedInfo(url);
  if (!info.isEmbeddable || !info.embedUrl) {
    if (!url) return el("p", { class: "muted", text: "No video selected." });
    return el("p", {}, [
      el("span", { class: "muted", text: "Not embeddable. " }),
      el("a", { href: url, target: "_blank", rel: "noreferrer", text: title ? `Open: ${title}` : "Open video" }),
    ]);
  }

  const iframe = el("iframe", {
    src: info.embedUrl,
    title: title || "Video",
    allow:
      "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
    allowfullscreen: "true",
    referrerpolicy: "strict-origin-when-cross-origin",
  });
  return el("div", { class: "embed-box" }, [iframe]);
}

function renderPostCard(event, { linkDate = false } = {}) {
  const eventId = typeof event?.id === "string" ? event.id : "";
  const pubkeyHex = typeof event?.pubkey === "string" ? event.pubkey : "";
  const createdAt = typeof event?.created_at === "number" ? event.created_at : Number(event?.created_at);
  const content = typeof event?.content === "string" ? event.content : "";

  const type = getPostTypeFromTags(event?.tags);
  const when = formatTimestamp(createdAt);

  const authorLink = pubkeyHex ? `#/p/${encodeURIComponent(pubkeyHex)}` : "#/community";
  const authorText = pubkeyHex ? shortHex(pubkeyHex) : "unknown";
  const whenEl =
    linkDate && eventId
      ? el("a", { class: "muted", href: `#/post/${encodeURIComponent(eventId)}`, text: when })
      : el("span", { class: "muted", text: when });

  const avatar = el("img", {
    class: "avatar-pic",
    alt: "",
    loading: "lazy",
    decoding: "async",
    referrerpolicy: "no-referrer",
    "data-role": "avatar",
    style: "display:none;",
  });
  const authorA = el("a", { href: authorLink, text: authorText, "data-role": "author" });

  const meta = el("div", { class: "post-meta" }, [
    avatar,
    authorA,
    whenEl,
  ]);
  if (type) meta.append(el("span", { class: "badge", text: type }));

  const card = el("article", { class: "post-card" }, [meta]);
  if (content) card.append(el("div", { style: "white-space: pre-wrap;" }, [document.createTextNode(content)]));

  const embed = getEmbeddableUrlForEvent(event);
  if (embed?.info?.embedUrl) {
    const iframe = el("iframe", {
      src: embed.info.embedUrl,
      title: "Embedded video",
      allow:
        "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
      allowfullscreen: "true",
      referrerpolicy: "strict-origin-when-cross-origin",
    });
    card.append(el("div", { class: "embed-box" }, [iframe]));
  }

  return card;
}

function renderPostList(container, events) {
  container.innerHTML = "";
  if (!Array.isArray(events) || events.length === 0) {
    container.append(el("p", { class: "muted", text: "No posts yet." }));
    return;
  }
  for (const ev of events) container.append(renderPostCard(ev));
}

async function init() {
  const adminBtn = document.getElementById("adminBtn");
  const signInBtn = document.getElementById("signInBtn");
  const signOutBtn = document.getElementById("signOutBtn");
  let statusEl = document.getElementById("status");
  const navLearn = document.getElementById("navLearn");
  const navCommunity = document.getElementById("navCommunity");
  const navBadges = document.getElementById("navBadges");
  const navProfile = document.getElementById("navProfile");
  if (adminBtn) adminBtn.hidden = true;

  const appRoot = document.getElementById("app");
  if (!appRoot) {
    showVisibleError(new Error('Missing required element: #app'), { title: "Boot error", statusEl });
    return;
  }
  const shell = ensureAppShell(appRoot);
  statusEl = shell.statusEl || statusEl;
  const app = shell.viewEl || appRoot;
  app.textContent = "Loading…";

  try {
    let signedInPubkey = normalizeHexPubkey(getStoredPubkey()) || null;
    let isMaintainer = false;
    let adminUi = null;
    let proofUi = null;
    const unitsByTrackId = new Map();
    const selectedVideoByUnitKey = new Map();
    let editUnitPreviewUrlInput = null;
    let renderSeq = 0;
    const tracks = [];
    let tracksLoaded = false;
    const profilesByPubkey = new Map(); // pubkey -> profile object (kind 0)

  const getSiteTitleBase = () => {
    const host =
      typeof window !== "undefined" && typeof window.location?.hostname === "string"
        ? window.location.hostname.trim()
        : "";
    return host || "yoyostr.com";
  };

  const setPageTitle = (parts) => {
    const base = getSiteTitleBase();
    const segs = Array.isArray(parts) ? parts : [parts];
    const cleaned = segs
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter(Boolean);
    const next = [base, ...cleaned].join(" - ");
    if (typeof document === "undefined") return;
    if (document.title !== next) document.title = next;
  };

  const updateNavUi = (route) => {
    const links = [
      [navLearn, "learn"],
      [navCommunity, "community"],
      [navBadges, "badges"],
      [navProfile, "profile"],
    ];
    for (const [a, name] of links) {
      if (!a) continue;
      const isLearn = route?.name === "home" || route?.name === "track" || route?.name === "unit";
      const isCurrent =
        (name === "learn" && isLearn) ||
        route?.name === name ||
        (name === "badges" && (route?.name === "badges" || route?.name === "badge_view")) ||
        (name === "profile" && (route?.name === "profile_view" || route?.name === "profile"));
      if (isCurrent) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
  };

  const updateAuthUi = () => {
    const isSignedIn = Boolean(signedInPubkey);
    const hasGetPublicKey = Boolean(window.nostr && typeof window.nostr.getPublicKey === "function");
    const hasSignEvent = Boolean(window.nostr && typeof window.nostr.signEvent === "function");
    const isCached = isSignedIn && !hasGetPublicKey;
    isMaintainer = normalizeHexPubkey(signedInPubkey) === normalizeHexPubkey(MAINTAINER_PUBKEY_HEX);

    if (adminBtn) adminBtn.hidden = !isMaintainer;
    if (adminBtn) adminBtn.disabled = !hasSignEvent;
    if (signInBtn) signInBtn.textContent = isSignedIn ? (isCached ? "Signed in (cached)" : "Signed in") : "Sign in";
    if (signInBtn) signInBtn.disabled = false;
    if (signOutBtn) signOutBtn.hidden = !isSignedIn;
  };

  updateAuthUi();

  const loadTracks = async () => {
    let loaded = [];
    try {
      loaded = await loadTracksNostrFirst();
    } catch (err) {
      showVisibleError(err, { title: "Tracks load error", statusEl });
      loaded = [];
    }
    tracks.splice(0, tracks.length, ...(Array.isArray(loaded) ? loaded : []));
    tracksLoaded = true;
    await renderRoute();
  };

  const signIn = async () => {
    if (!window.nostr || typeof window.nostr.getPublicKey !== "function") {
      setStatus(statusEl, "Install/enable a Nostr signer (Alby) to sign in.", { error: true });
      return;
    }

    setStatus(statusEl, "Signing in…");
    try {
      signedInPubkey = await signInWithNip07();
    } catch (err) {
      setStatus(statusEl, `Sign-in failed: ${err?.message || String(err)}`, { error: true });
      updateAuthUi();
      return;
    }

    const wasMaintainer = isMaintainer;
    isMaintainer = normalizeHexPubkey(signedInPubkey) === normalizeHexPubkey(MAINTAINER_PUBKEY_HEX);
    setStatus(
      statusEl,
      isMaintainer ? "Signed in as maintainer." : "Signed in (not maintainer)."
    );
    updateAuthUi();
    if (wasMaintainer !== isMaintainer) renderRoute();
  };

  const signOut = () => {
    signedInPubkey = null;
    isMaintainer = false;
    clearStoredPubkey();
    if (adminBtn) adminBtn.hidden = true;
    setStatus(statusEl, "Signed out.");
    updateAuthUi();
    renderRoute();
  };

  const openAdmin = async (options = {}) => await openAdminWithDefaults(options);

  const setSelectOptions = (selectEl, options, selectedValue) => {
    if (!selectEl) return;
    const prev = String(selectedValue ?? "");
    selectEl.innerHTML = "";
    for (const { value, label } of options) {
      const opt = document.createElement("option");
      opt.value = String(value);
      opt.textContent = String(label);
      selectEl.append(opt);
    }
    if (prev && Array.from(selectEl.options).some((o) => o.value === prev)) selectEl.value = prev;
  };

  const renderAdminPreview = (container, url) => {
    if (!container) return;
    container.innerHTML = "";
    const info = getEmbedInfo(url);
    if (!info.isEmbeddable || !info.embedUrl) {
      container.append(el("p", { class: "muted", text: "Not embeddable (YouTube only for now)." }));
      return;
    }
    const iframe = el("iframe", {
      src: info.embedUrl,
      title: "Preview",
      allow:
        "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
      allowfullscreen: "true",
      referrerpolicy: "strict-origin-when-cross-origin",
      style: "width:100%; height: 260px; border:0; display:block; border-radius: 12px;",
    });
    container.append(iframe);
  };

  const oembedTitleCache = new Map();
  let createUnitTitleAutofillTimer = null;
  let createUnitTitleAutofillSeq = 0;

  const fetchYouTubeOembedTitle = async (url) => {
    const raw = typeof url === "string" ? url.trim() : "";
    if (!raw) return "";

    const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(raw)}`;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 5000) : null;

    try {
      const res = await fetch(endpoint, controller ? { signal: controller.signal } : undefined);
      if (!res.ok) return "";
      const data = await res.json().catch(() => null);
      return typeof data?.title === "string" ? data.title.trim() : "";
    } catch {
      return "";
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const scheduleCreateUnitVideoTitleAutofill = () => {
    if (!adminUi?.createUnit) return;
    const titleInput = adminUi.createUnit.videoTitle;
    const urlInput = adminUi.createUnit.videoUrl;
    if (!titleInput || !urlInput) return;

    clearTimeout(createUnitTitleAutofillTimer);
    const seq = ++createUnitTitleAutofillSeq;

    const currentTitle = String(titleInput.value || "").trim();
    if (currentTitle) return;

    const currentUrl = String(urlInput.value || "").trim();
    if (!currentUrl) return;

    const info = getEmbedInfo(currentUrl);
    if (info?.provider !== "youtube") return;
    createUnitTitleAutofillTimer = setTimeout(async () => {
      if (!adminUi?.createUnit) return;
      if (seq !== createUnitTitleAutofillSeq) return;

      const url = String(adminUi.createUnit.videoUrl.value || "").trim();
      if (!url) return;
      if (String(adminUi.createUnit.videoTitle.value || "").trim()) return;

      if (oembedTitleCache.has(url)) {
        const cached = String(oembedTitleCache.get(url) || "").trim();
        if (cached && !String(adminUi.createUnit.videoTitle.value || "").trim()) adminUi.createUnit.videoTitle.value = cached;
        return;
      }

      const fetched = String((await fetchYouTubeOembedTitle(url)) || "").trim();
      oembedTitleCache.set(url, fetched);
      if (!fetched) return;

      const urlStillSame = String(adminUi.createUnit.videoUrl.value || "").trim() === url;
      const titleStillEmpty = !String(adminUi.createUnit.videoTitle.value || "").trim();
      if (urlStillSame && titleStillEmpty) adminUi.createUnit.videoTitle.value = fetched;
    }, 350);
  };

  function resetCreateUnitForm() {
    if (!adminUi?.createUnit) return;
    const { unitId, title, type, order, description, videoTitle, videoUrl, preview } = adminUi.createUnit;
    unitId.value = "";
    title.value = "";
    type.value = "trick";
    order.value = "";
    description.value = "";
    videoTitle.value = "";
    videoUrl.value = "";
    renderAdminPreview(preview, "");
    unitId.focus();
  }

  const ensureUnits = async (trackId) => {
    if (unitsByTrackId.has(trackId)) return unitsByTrackId.get(trackId) || [];
    const units = await loadUnitsNostr(trackId);
    unitsByTrackId.set(trackId, units);
    return units;
  };

  const addEditUnitVideoRow = (video = {}) => {
    if (!adminUi?.editUnit?.videos) return;

    const row = document.createElement("div");
    row.dataset.videoRow = "1";
    row.style.display = "grid";
    row.style.gridTemplateColumns = "1fr 2fr auto";
    row.style.gap = "8px";

    const title = document.createElement("input");
    title.placeholder = "title";
    title.value = typeof video?.title === "string" ? video.title : "";

    const url = document.createElement("input");
    url.placeholder = "url";
    url.value = typeof video?.url === "string" ? video.url : "";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      const wasActive = editUnitPreviewUrlInput === url;
      row.remove();
      if (wasActive) {
        editUnitPreviewUrlInput = null;
        const firstUrl = String(
          adminUi?.editUnit?.videos?.querySelector('[data-video-row="1"] input:nth-child(2)')?.value || ""
        );
        renderAdminPreview(adminUi.editUnit.preview, firstUrl);
      }
    });

    url.addEventListener("focus", () => {
      editUnitPreviewUrlInput = url;
      renderAdminPreview(adminUi.editUnit.preview, url.value);
    });
    url.addEventListener("input", () => {
      if (editUnitPreviewUrlInput === url) renderAdminPreview(adminUi.editUnit.preview, url.value);
    });

    row.append(title, url, removeBtn);
    adminUi.editUnit.videos.append(row);
  };

  const readEditUnitVideosFromEditor = () => {
    if (!adminUi?.editUnit?.videos) return [];
    const rows = Array.from(adminUi.editUnit.videos.querySelectorAll('[data-video-row="1"]'));
    const videos = [];
    for (const row of rows) {
      const inputs = row.querySelectorAll("input");
      const title = String(inputs?.[0]?.value || "").trim();
      const url = String(inputs?.[1]?.value || "").trim();
      if (!url) continue;
      videos.push({ title: title || undefined, url });
    }
    return videos;
  };

  const populateEditUnitForm = async (trackId, unitId) => {
    if (!adminUi?.editUnit) return;
    const tid = String(trackId || "").trim();
    const uid = String(unitId || "").trim();

    if (!tid || !uid) {
      adminUi.editUnit.unitId.value = "";
      adminUi.editUnit.title.value = "";
      adminUi.editUnit.type.value = "other";
      adminUi.editUnit.order.value = "";
      adminUi.editUnit.description.value = "";
      adminUi.editUnit.softDelete.checked = false;
      adminUi.editUnit.videos.innerHTML = "";
      editUnitPreviewUrlInput = null;
      addEditUnitVideoRow({});
      renderAdminPreview(adminUi.editUnit.preview, "");
      return;
    }

    const units = await ensureUnits(tid);
    const unit = units.find((u) => String(u?.unitId || "") === uid);
    if (!unit) {
      appendLog(adminUi.log, "Edit Unit: unit not found (refresh?).");
      return;
    }

    adminUi.editUnit.unitId.value = uid;
    adminUi.editUnit.title.value = typeof unit?.title === "string" ? unit.title : "";
    adminUi.editUnit.type.value = typeof unit?.type === "string" ? unit.type : "other";
    adminUi.editUnit.order.value =
      unit?.order !== undefined && unit?.order !== null && unit.order !== "" ? String(unit.order) : "";
    adminUi.editUnit.description.value = typeof unit?.description === "string" ? unit.description : "";
    adminUi.editUnit.softDelete.checked = unit?.deleted === true;

    adminUi.editUnit.videos.innerHTML = "";
    editUnitPreviewUrlInput = null;
    const videos = Array.isArray(unit?.videos) ? unit.videos : [];
    if (videos.length === 0) addEditUnitVideoRow({});
    else videos.forEach((v) => addEditUnitVideoRow(v));

    const firstUrl = typeof videos?.[0]?.url === "string" ? videos[0].url : "";
    renderAdminPreview(adminUi.editUnit.preview, firstUrl);
  };

  const setEditUnitOptions = async (trackId, selectedUnitId) => {
    if (!adminUi?.editUnit?.unit) return;
    const tid = String(trackId || "").trim();
    if (!tid) return;

    setSelectOptions(adminUi.editUnit.unit, [{ value: "", label: "Loading…" }], "");
    const units = await ensureUnits(tid);
    const opts = units
      .filter((u) => typeof u?.unitId === "string" && u.unitId.trim())
      .map((u) => ({
        value: u.unitId,
        label: `${u.deleted === true ? "[deleted] " : ""}${u.title || u.unitId} (${u.unitId})`,
      }));
    setSelectOptions(adminUi.editUnit.unit, [{ value: "", label: "Select a unit…" }, ...opts], selectedUnitId);

    const nextUnitId = String(selectedUnitId || adminUi.editUnit.unit.value || "").trim();
    if (nextUnitId) await populateEditUnitForm(tid, nextUnitId);
  };

  const addTrackPlaylistRow = (playlist = {}) => {
    if (!adminUi?.trackMgmt?.playlists) return;

    const row = document.createElement("div");
    row.dataset.playlistRow = "1";
    row.dataset.platform = typeof playlist?.platform === "string" ? playlist.platform : "youtube";
    row.style.display = "grid";
    row.style.gridTemplateColumns = "1fr 2fr auto";
    row.style.gap = "8px";

    const label = document.createElement("input");
    label.placeholder = "label";
    label.value = typeof playlist?.label === "string" ? playlist.label : "";

    const url = document.createElement("input");
    url.placeholder = "url";
    url.value = typeof playlist?.url === "string" ? playlist.url : "";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => row.remove());

    row.append(label, url, removeBtn);
    adminUi.trackMgmt.playlists.append(row);
  };

  const populateTrackMgmt = (trackId) => {
    if (!adminUi?.trackMgmt) return;
    const tid = typeof trackId === "string" ? trackId : "";
    const track = tracks.find((t) => String(t?.id || "") === tid);
    adminUi.trackMgmt.trackId.value = tid || "";
    adminUi.trackMgmt.title.value = typeof track?.title === "string" ? track.title : "";
    adminUi.trackMgmt.description.value = typeof track?.description === "string" ? track.description : "";
    adminUi.trackMgmt.order.value =
      track?.order !== undefined && track?.order !== null && track.order !== "" ? String(track.order) : "";

    adminUi.trackMgmt.playlists.innerHTML = "";
    const playlists = Array.isArray(track?.playlists) ? track.playlists : [];
    if (playlists.length === 0) addTrackPlaylistRow({});
    else playlists.forEach((p) => addTrackPlaylistRow(p));
  };

  const readTrackPlaylistsFromEditor = () => {
    if (!adminUi?.trackMgmt?.playlists) return [];
    const rows = Array.from(adminUi.trackMgmt.playlists.querySelectorAll('[data-playlist-row="1"]'));
    const playlists = [];
    for (const row of rows) {
      const inputs = row.querySelectorAll("input");
      const label = String(inputs?.[0]?.value || "").trim();
      const url = String(inputs?.[1]?.value || "").trim();
      if (!url) continue;
      const platform = typeof row.dataset.platform === "string" && row.dataset.platform ? row.dataset.platform : "youtube";
      playlists.push({ platform, url, label: label || undefined });
    }
    return playlists;
  };

  const refreshTracksFromRelays = async () => {
    let latestTracks = [];
    try {
      latestTracks = await fetchTracksFromRelays();
    } catch {
      latestTracks = [];
    }
    if (!Array.isArray(latestTracks) || latestTracks.length === 0) return false;
    tracks.splice(0, tracks.length, ...latestTracks);
    return true;
  };

  const getTrackOptions = () =>
    tracks
      .filter((t) => typeof t?.id === "string" && t.id.trim())
      .map((t) => ({ value: t.id, label: `${t.title || t.id} (${t.id})` }));

  const createProofDialog = () => {
    const dialog = document.createElement("dialog");
    dialog.style.maxWidth = "640px";
    dialog.style.width = "100%";

    const title = el("h3", { text: "Post proof", style: "margin: 0 0 10px;" });
    const status = el("div", { class: "muted", style: "min-height: 1.2em;" });

    const contentLabel = document.createElement("label");
    contentLabel.textContent = "Content";
    contentLabel.style.display = "grid";
    contentLabel.style.gap = "6px";
    contentLabel.style.fontSize = "12px";
    contentLabel.style.opacity = "0.85";
    const content = document.createElement("textarea");
    content.rows = 4;
    contentLabel.append(content);

    const urlLabel = document.createElement("label");
    urlLabel.textContent = "Video URL (required)";
    urlLabel.style.display = "grid";
    urlLabel.style.gap = "6px";
    urlLabel.style.fontSize = "12px";
    urlLabel.style.opacity = "0.85";
    const videoUrl = document.createElement("input");
    videoUrl.placeholder = "https://youtu.be/…";
    urlLabel.append(videoUrl);

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "10px";
    actions.style.alignItems = "center";
    actions.style.justifyContent = "flex-end";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => dialog.close());

    const publishBtn = document.createElement("button");
    publishBtn.type = "button";
    publishBtn.textContent = "Publish";

    actions.append(cancelBtn, publishBtn);
    dialog.append(title, status, contentLabel, urlLabel, actions);
    document.body.append(dialog);

    return { dialog, status, content, videoUrl, publishBtn };
  };

  const openProofDialog = async ({ trackId, unitId, unitTitle }) => {
    if (!proofUi) proofUi = createProofDialog();

    proofUi.dialog.dataset.trackId = String(trackId || "");
    proofUi.dialog.dataset.unitId = String(unitId || "");
    proofUi.dialog.dataset.unitTitle = String(unitTitle || unitId || "");
    proofUi.content.value = `Proof: ${String(unitTitle || unitId || "").trim()}`.trim();
    proofUi.videoUrl.value = "";
    proofUi.status.textContent = "";
    proofUi.publishBtn.disabled = false;

    if (proofUi.dialog.dataset.wired !== "1") {
      proofUi.dialog.dataset.wired = "1";
      proofUi.publishBtn.addEventListener("click", async () => {
        proofUi.status.textContent = "";

        if (!signedInPubkey) {
          proofUi.status.textContent = "Sign in to post.";
          return;
        }
        if (!window.nostr || typeof window.nostr.signEvent !== "function") {
          proofUi.status.textContent = "Missing signer: Install/enable a Nostr signer (Alby).";
          return;
        }

        const tid = String(proofUi.dialog.dataset.trackId || "").trim();
        const uid = String(proofUi.dialog.dataset.unitId || "").trim();
        const title = String(proofUi.dialog.dataset.unitTitle || "").trim();

        const videoUrl = String(proofUi.videoUrl.value || "").trim();
        if (!videoUrl) {
          proofUi.status.textContent = "Video URL is required.";
          proofUi.videoUrl.focus();
          return;
        }

        const baseText = String(proofUi.content.value || "").trim() || `Proof: ${title || uid || tid}`;
        const content = `${baseText}\n${videoUrl}`.trim();

        const tags = [
          ["t", "yoyostr"],
          ["t", "post"],
          ["t", "type:proof"],
          ["r", videoUrl],
        ];
        if (tid) tags.push(["t", `track:${tid}`]);
        if (tid && uid) tags.push(["t", `unit:${tid}:${uid}`]);
        if (tid && uid && typeof MAINTAINER_PUBKEY_HEX === "string" && MAINTAINER_PUBKEY_HEX.trim()) {
          tags.push(["a", `30079:${MAINTAINER_PUBKEY_HEX.trim()}:unit:${tid}:${uid}`]);
        }

        const now = Math.floor(Date.now() / 1000);
        const unsignedEvent = {
          kind: 1,
          created_at: now,
          tags,
          content,
          pubkey: normalizeHexPubkey(signedInPubkey),
        };

        proofUi.publishBtn.disabled = true;
        proofUi.status.textContent = "Signing…";

        let signedEvent;
        try {
          signedEvent = await window.nostr.signEvent(unsignedEvent);
        } catch (err) {
          proofUi.status.textContent = `Sign failed: ${err?.message || String(err)}`;
          proofUi.publishBtn.disabled = false;
          return;
        }

        proofUi.status.textContent = `Publishing ${signedEvent.id}…`;
        const results = await publishEventToRelays(RELAYS, signedEvent);
        console.log("proof publish results", results);

        const ok = Object.values(results).some((r) => r?.ok);
        proofUi.status.innerHTML = "";
        if (ok) {
          proofUi.status.append(
            document.createTextNode("Posted! "),
            el("a", { href: "#/community", text: "View community feed" })
          );
        } else {
          proofUi.status.textContent = "Publish failed (no relays reported OK).";
          proofUi.publishBtn.disabled = false;
        }
      });
    }

    proofUi.dialog.showModal?.();
    if (!proofUi.dialog.open) proofUi.dialog.setAttribute("open", "open");
    proofUi.videoUrl.focus();
  };

  const renderHome = () => {
    setPageTitle(["Learn"]);
    app.innerHTML = "";
    app.append(el("h2", { text: "Tracks", style: "margin: 0 0 12px;" }));
    if (!tracksLoaded) {
      app.append(el("p", { class: "muted", text: "Loading tracks…" }));
      return;
    }
    const list = el("div", {});
    renderTracks(list, tracks);
    app.append(list);
    app.append(el("p", { class: "muted", text: "Next: Units + proofs + badges." }));
  };

  const renderCommunity = async () => {
    setPageTitle(["Community"]);
    const seq = ++renderSeq;
    app.innerHTML = "";
    app.append(el("h2", { text: "Community", style: "margin: 0 0 12px;" }));

    const composerStatus = el("div", { class: "muted", style: "min-height: 1.2em;" });
    if (signedInPubkey) {
      const box = el("div", { class: "composer" });

      const typeLabel = document.createElement("label");
      typeLabel.textContent = "Post type";
      const type = document.createElement("select");
      for (const [value, label] of [
        ["clip", "clip/trick"],
        ["tutorial", "tutorial"],
        ["proof", "proof"],
        ["discussion", "discussion"],
      ]) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        type.append(opt);
      }
      typeLabel.append(type);

      const contentLabel = document.createElement("label");
      contentLabel.textContent = "Text";
      const content = document.createElement("textarea");
      content.rows = 4;
      content.placeholder = "Share a clip, ask a question, post a proof…";
      contentLabel.append(content);

      const urlLabel = document.createElement("label");
      urlLabel.textContent = "Optional video URL";
      const videoUrl = document.createElement("input");
      videoUrl.placeholder = "https://youtu.be/…";
      urlLabel.append(videoUrl);

      const publishBtn = document.createElement("button");
      publishBtn.type = "button";
      publishBtn.textContent = "Publish";

      box.append(typeLabel, contentLabel, urlLabel, publishBtn, composerStatus);
      app.append(box);

      publishBtn.addEventListener("click", async () => {
        composerStatus.textContent = "";
        if (!window.nostr || typeof window.nostr.signEvent !== "function") {
          composerStatus.textContent = "Missing signer: Install/enable a Nostr signer (Alby).";
          return;
        }

        const typeValue = String(type.value || "discussion").trim() || "discussion";
        const text = String(content.value || "").trim();
        const url = String(videoUrl.value || "").trim();
        if (!text && !url) {
          composerStatus.textContent = "Add some text (or a video URL).";
          content.focus();
          return;
        }

        const finalContent = url ? `${text}\n${url}`.trim() : text;
        const tags = [
          ["t", "yoyostr"],
          ["t", "post"],
          ["t", `type:${typeValue}`],
        ];
        if (url) tags.push(["r", url]);

        const now = Math.floor(Date.now() / 1000);
        const unsignedEvent = {
          kind: 1,
          created_at: now,
          tags,
          content: finalContent,
          pubkey: normalizeHexPubkey(signedInPubkey),
        };

        publishBtn.disabled = true;
        composerStatus.textContent = "Signing…";

        let signedEvent;
        try {
          signedEvent = await window.nostr.signEvent(unsignedEvent);
        } catch (err) {
          composerStatus.textContent = `Sign failed: ${err?.message || String(err)}`;
          publishBtn.disabled = false;
          return;
        }

        composerStatus.textContent = `Publishing ${signedEvent.id}…`;
        const results = await publishEventToRelays(RELAYS, signedEvent);
        console.log("community publish results", results);
        const ok = Object.values(results).some((r) => r?.ok);
        if (!ok) {
          composerStatus.textContent = "Publish failed (no relays reported OK).";
          publishBtn.disabled = false;
          return;
        }

        composerStatus.textContent = "Posted.";
        content.value = "";
        videoUrl.value = "";
        publishBtn.disabled = false;
        renderCommunity();
      });
    } else {
      app.append(el("p", { class: "muted", text: "Sign in to post." }));
    }

    const feedBox = el("div", {}, [el("p", { class: "muted", text: "Loading posts…" })]);
    app.append(feedBox);

    let posts = [];
    try {
      posts = await fetchCommunityPosts({ limit: 50 });
    } catch {
      posts = [];
    }
    if (seq !== renderSeq) return;

    const ensureProfilesForEvents = async (events) => {
      const pubkeys = Array.from(
        new Set(
          (Array.isArray(events) ? events : [])
            .map((ev) => (typeof ev?.pubkey === "string" ? normalizeHexPubkey(ev.pubkey) : ""))
            .filter(Boolean)
        )
      );
      const missing = pubkeys.filter((pk) => !profilesByPubkey.has(pk));
      if (missing.length === 0) return false;
      let batch;
      try {
        batch = await fetchProfiles(missing.slice(0, 40), { limit: 120 });
      } catch {
        batch = {};
      }
      let changed = false;
      for (const [pubkey, profile] of Object.entries(batch || {})) {
        const pk = normalizeHexPubkey(pubkey);
        if (!pk) continue;
        profilesByPubkey.set(pk, profile);
        changed = true;
      }
      return changed;
    };

    const renderPostsWithNames = (container, events) => {
      container.innerHTML = "";
      if (!Array.isArray(events) || events.length === 0) {
        container.append(el("p", { class: "muted", text: "No posts yet." }));
        return;
      }
      for (const ev of events) {
        const card = renderPostCard(ev, { linkDate: true });
        const pubkeyHex = typeof ev?.pubkey === "string" ? normalizeHexPubkey(ev.pubkey) : "";
        const profile = pubkeyHex ? profilesByPubkey.get(pubkeyHex) : null;
        const authorEl = card.querySelector?.('[data-role="author"]');
        if (authorEl && pubkeyHex) authorEl.textContent = getBestDisplayName(profile, pubkeyHex);
        const avatarEl = card.querySelector?.('[data-role="avatar"]');
        const pic = getProfilePictureUrl(profile);
        if (avatarEl && pic) {
          avatarEl.src = pic;
          avatarEl.style.display = "";
        }
        container.append(card);
      }
    };

    renderPostsWithNames(feedBox, posts);
    ensureProfilesForEvents(posts).then((changed) => {
      if (!changed) return;
      if (seq !== renderSeq) return;
      renderPostsWithNames(feedBox, posts);
    });
  };

  const renderPostPermalink = async (eventId) => {
    setPageTitle(["Post"]);
    const seq = ++renderSeq;
    app.innerHTML = "";

    const back = el("a", { href: "#/community", text: "← Back" });
    back.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (window.history.length > 1) window.history.back();
      else window.location.hash = "#/community";
    });

    app.append(back);
    app.append(el("h2", { text: "Post", style: "margin: 10px 0 12px;" }));

    const box = el("div", {}, [el("p", { class: "muted", text: "Loading post…" })]);
    app.append(box);

    try {
      const post = await fetchPostById(eventId, { timeoutMs: 6500 });
      if (seq !== renderSeq) return;
      box.innerHTML = "";

      if (!post) {
        box.append(el("p", { class: "muted", text: "Post not found (relay may not have it)." }));
        return;
      }

      const card = renderPostCard(post);
      box.append(card);

      const pk = typeof post?.pubkey === "string" ? normalizeHexPubkey(post.pubkey) : "";
      const applyProfile = () => {
        const profile = pk ? profilesByPubkey.get(pk) : null;
        const authorEl = card.querySelector?.('[data-role="author"]');
        if (authorEl && pk) authorEl.textContent = getBestDisplayName(profile, pk);
        const avatarEl = card.querySelector?.('[data-role="avatar"]');
        const pic = getProfilePictureUrl(profile);
        if (avatarEl && pic) {
          avatarEl.src = pic;
          avatarEl.style.display = "";
        }
      };

      applyProfile();
      if (pk && !profilesByPubkey.has(pk)) {
        fetchProfiles([pk], { limit: 5 })
          .then((batch) => {
            const prof = batch?.[pk];
            if (prof) profilesByPubkey.set(pk, prof);
            if (seq !== renderSeq) return;
            applyProfile();
          })
          .catch(() => {});
      }
    } catch (err) {
      if (seq !== renderSeq) return;
      box.innerHTML = "";
      box.append(el("p", { class: "muted", text: `Failed to load post: ${err?.message || String(err)}` }));
      box.append(el("pre", { style: "white-space: pre-wrap;", text: err?.stack || String(err) }));
    }
  };

  const renderBadges = async () => {
    setPageTitle(["Badges"]);
    const seq = ++renderSeq;
    app.innerHTML = "";
    app.append(el("h2", { text: "Badges", style: "margin: 0 0 12px;" }));

    const box = el("div", {}, [el("p", { class: "muted", text: "Loading badges…" })]);
    app.append(box);

    let defs = [];
    try {
      defs = await fetchAllBadgeDefinitions({ limit: 500 });
    } catch {
      defs = [];
    }
    if (seq !== renderSeq) return;

    const addresses = defs.map((d) => d?.address).filter(Boolean);
    let countsByAddress = {};
    try {
      const stats = await fetchBadgeAwardCounts(addresses, { limit: 2500, chunkSize: 20 });
      countsByAddress = stats?.countsByAddress || {};
    } catch {
      countsByAddress = {};
    }
    if (seq !== renderSeq) return;

    box.innerHTML = "";
    if (!Array.isArray(defs) || defs.length === 0) {
      box.append(el("p", { class: "muted", text: "No badges found yet." }));
      return;
    }

    const grid = el("div", { class: "badge-grid" });
    for (const def of defs) {
      const title = def?.name || "Badge";
      const address = def?.address || "";
      const href = address ? `#/badge/${encodeURIComponent(address)}` : "#/badges";
      const count = typeof countsByAddress[address] === "number" ? countsByAddress[address] : 0;
      const unitRef = typeof def?.unitRef === "string" ? def.unitRef : "";
      const unit = parseUnitRef(unitRef);
      const unitHref =
        unit && unit.trackId && unit.unitId
          ? `#/track/${encodeURIComponent(unit.trackId)}/unit/${encodeURIComponent(unit.unitId)}`
          : "";

      const card = el("div", { class: "badge-card", style: "cursor:pointer;" });
      card.tabIndex = 0;
      const go = () => {
        window.location.hash = href;
      };
      card.addEventListener("click", go);
      card.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") go();
      });
      if (def?.imageUrl) {
        card.append(
          el("img", {
            class: "badge-icon",
            src: def.imageUrl,
            alt: "",
            loading: "lazy",
            decoding: "async",
            referrerpolicy: "no-referrer",
          })
        );
      } else {
        card.append(el("div", { class: "badge-icon badge-icon--empty", text: "★" }));
      }

      const meta = el("div", { class: "badge-meta" });
      meta.append(el("div", { class: "badge-title", text: title }));
      meta.append(el("div", { class: "muted", text: `${count} holder${count === 1 ? "" : "s"}` }));
      if (unitHref) {
        const a = el("a", { href: unitHref, class: "muted", text: unitRef || "Tutorial" });
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          window.location.hash = unitHref;
        });
        meta.append(a);
      } else if (unitRef) {
        meta.append(el("div", { class: "muted", text: unitRef }));
      }
      card.append(meta);
      grid.append(card);
    }
    box.append(grid);
  };

  const renderBadgeDetail = async (badgeAddress) => {
    setPageTitle(["Badge"]);
    const seq = ++renderSeq;
    const address = typeof badgeAddress === "string" ? badgeAddress.trim() : "";
    app.innerHTML = "";
    app.append(el("div", { class: "crumbs" }, [el("a", { href: "#/badges", text: "Badges" })]));
    app.append(el("h2", { text: "Badge", style: "margin: 0 0 12px;" }));

    const box = el("div", {}, [el("p", { class: "muted", text: "Loading badge…" })]);
    app.append(box);

    let def = null;
    let awards = [];
    try {
      [def, awards] = await Promise.all([
        fetchBadgeDefinitionByAddress(address),
        fetchBadgeAwardEventsForBadgeAddress(address, { limit: 2500 }),
      ]);
    } catch {
      def = null;
      awards = [];
    }
    if (seq !== renderSeq) return;

    if (!def) {
      box.innerHTML = "";
      box.append(el("p", { class: "muted", text: "Badge not found." }));
      return;
    }

    setPageTitle(["Badge", def.name || shortHex(address) || "Badge"]);

    const recipients = new Set();
    for (const ev of awards) {
      for (const p of getTagValues(ev?.tags, "p")) {
        const pk = normalizeHexPubkey(p);
        if (pk) recipients.add(pk);
      }
    }
    const holderPubkeys = Array.from(recipients);
    const holderCount = holderPubkeys.length;

    const creatorPubkey = typeof def?.pubkey === "string" ? normalizeHexPubkey(def.pubkey) : "";
    let creatorProfile = null;
    try {
      creatorProfile = creatorPubkey ? await fetchProfile(creatorPubkey) : null;
    } catch {
      creatorProfile = null;
    }
    if (seq !== renderSeq) return;

    let holdersProfiles = {};
    try {
      holdersProfiles = await fetchProfiles(holderPubkeys.slice(0, 60), { limit: 180 });
    } catch {
      holdersProfiles = {};
    }
    if (seq !== renderSeq) return;

    box.innerHTML = "";

    const header = el("div", { style: "display:flex; gap: 14px; align-items: center; flex-wrap: wrap;" });
    if (def.imageUrl) {
      header.append(
        el("img", {
          class: "badge-icon",
          src: def.imageUrl,
          alt: "",
          loading: "lazy",
          decoding: "async",
          referrerpolicy: "no-referrer",
        })
      );
    } else {
      header.append(el("div", { class: "badge-icon badge-icon--empty", text: "★" }));
    }
    header.append(el("div", {}, [el("div", { style: "font-weight:600;", text: def.name || "Badge" })]));
    box.append(header);

    if (def.description) box.append(el("p", { class: "muted", text: def.description }));

    box.append(el("p", { class: "muted", text: `${holderCount} holder${holderCount === 1 ? "" : "s"}` }));

    const unitRef = typeof def.unitRef === "string" ? def.unitRef : "";
    const unit = parseUnitRef(unitRef);
    if (unit && unit.trackId && unit.unitId) {
      box.append(el("p", {}, [el("a", { href: `#/track/${encodeURIComponent(unit.trackId)}/unit/${encodeURIComponent(unit.unitId)}`, text: `Tutorial: ${unitRef}` })]));
    } else if (unitRef) {
      box.append(el("p", { class: "muted", text: `Tutorial: ${unitRef}` }));
    }

    if (creatorPubkey) {
      const creatorName = getBestDisplayName(creatorProfile, creatorPubkey);
      box.append(
        el("p", {}, [
          document.createTextNode("Created by: "),
          el("a", { href: `#/p/${encodeURIComponent(creatorPubkey)}`, text: creatorName }),
          el("span", { class: "muted", text: ` (${shortHex(creatorPubkey)})` }),
        ])
      );
    }

    const holdersTitle = el("h3", { text: "Holders", style: "margin: 16px 0 10px;" });
    box.append(holdersTitle);

    if (holderPubkeys.length === 0) {
      box.append(el("p", { class: "muted", text: "No one has been awarded this badge yet." }));
      return;
    }

    const list = el("ul", { style: "list-style:none; padding:0; margin:0; display:grid; gap: 8px;" });
    const maxShow = 60;
    const shown = holderPubkeys.slice(0, maxShow);
    for (const pk of shown) {
      const prof = holdersProfiles?.[pk] || null;
      const name = getBestDisplayName(prof, pk);
      list.append(el("li", {}, [el("a", { href: `#/p/${encodeURIComponent(pk)}`, text: name }), el("span", { class: "muted", text: ` (${shortHex(pk)})` })]));
    }
    box.append(list);
    if (holderPubkeys.length > maxShow) {
      box.append(el("p", { class: "muted", text: `Showing ${maxShow} of ${holderPubkeys.length}.` }));
    }
  };

  const renderProfile = async (pubkeyHex, options = {}) => {
    setPageTitle(["Profile"]);
    const seq = ++renderSeq;
    const pubkey = normalizeHexPubkey(pubkeyHex);
    app.innerHTML = "";

    if (!pubkey) {
      app.append(el("p", { class: "muted", text: "Missing pubkey." }));
      return;
    }

    const isSelf = Boolean(options.isSelf);
    app.append(el("h2", { text: isSelf ? "Your Profile" : "Profile", style: "margin: 0 0 12px;" }));

    const profileBox = el("div", {}, [el("p", { class: "muted", text: "Loading profile…" })]);
    app.append(profileBox);

    let profile = null;
    try {
      profile = await fetchProfile(pubkey);
    } catch {
      profile = null;
    }
    if (seq !== renderSeq) return;

    profileBox.innerHTML = "";
    const displayName = getBestDisplayName(profile, pubkey);
    setPageTitle(["Profile", displayName]);

    const bannerUrl = getProfileBannerUrl(profile);
    if (bannerUrl) {
      profileBox.append(
        el("img", {
          class: "profile-banner",
          src: bannerUrl,
          alt: "",
          loading: "lazy",
          decoding: "async",
          referrerpolicy: "no-referrer",
        })
      );
    }

    const header = el("div", { class: "profile-header" });
    if (typeof profile?.picture === "string" && profile.picture.trim()) {
      header.append(
        el("img", {
          class: "profile-pic",
          src: profile.picture.trim(),
          alt: "",
          loading: "lazy",
          decoding: "async",
        })
      );
    }
    header.append(el("div", {}, [el("div", { text: displayName }), el("div", { class: "muted", text: shortHex(pubkey) })]));
    profileBox.append(header);

    const aboutText = typeof profile?.about === "string" ? profile.about.trim() : "";
    if (aboutText) {
      profileBox.append(el("p", { class: "muted", style: "margin: 8px 0 0; white-space: pre-wrap;" }, [document.createTextNode(aboutText)]));
    }

    const isOwnProfile = normalizeHexPubkey(signedInPubkey) === pubkey;
    if (isOwnProfile) {
      const box = el("div", { class: "composer", style: "margin-top: 12px;" });

      const aboutLabel = document.createElement("label");
      aboutLabel.textContent = "Profile description";
      const about = document.createElement("textarea");
      about.rows = 3;
      about.placeholder = "Tell people about yourself…";
      about.value = typeof profile?.about === "string" ? profile.about : "";
      aboutLabel.append(about);

      const picLabel = document.createElement("label");
      picLabel.textContent = "Profile picture URL";
      const picture = document.createElement("input");
      picture.placeholder = "https://… (a publicly accessible image URL)";
      picture.value = typeof profile?.picture === "string" ? profile.picture : "";
      picLabel.append(picture);

      const bannerLabel = document.createElement("label");
      bannerLabel.textContent = "Profile banner URL";
      const banner = document.createElement("input");
      banner.placeholder = "https://… (a publicly accessible image URL)";
      banner.value = typeof profile?.banner === "string" ? profile.banner : "";
      bannerLabel.append(banner);

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.textContent = "Save profile";

      const saveStatus = el("div", { class: "muted", style: "min-height: 1.2em;" });

      saveBtn.addEventListener("click", async () => {
        saveStatus.textContent = "";
        if (!window.nostr || typeof window.nostr.signEvent !== "function") {
          saveStatus.textContent = "Missing signer: Install/enable a Nostr signer (Alby).";
          return;
        }
        if (!signedInPubkey) {
          saveStatus.textContent = "Not signed in.";
          return;
        }

        const nextAbout = String(about.value || "").trim();
        const nextPic = String(picture.value || "").trim();
        const nextBanner = String(banner.value || "").trim();

        const base = safeParseJsonObject(typeof profile?.content === "string" ? profile.content : "");
        // `fetchProfile()` already expands the JSON; use that as the base so we preserve all fields.
        for (const [k, v] of Object.entries(profile || {})) {
          if (k === "pubkey" || k === "created_at") continue;
          if (v === undefined) continue;
          base[k] = v;
        }
        if (nextAbout) base.about = nextAbout;
        else delete base.about;
        if (nextPic) base.picture = nextPic;
        else delete base.picture;
        if (nextBanner) base.banner = nextBanner;
        else delete base.banner;

        const now = Math.floor(Date.now() / 1000);
        const unsignedEvent = {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify(base),
          pubkey: normalizeHexPubkey(signedInPubkey),
        };

        saveBtn.disabled = true;
        saveStatus.textContent = "Signing…";

        let signedEvent;
        try {
          signedEvent = await window.nostr.signEvent(unsignedEvent);
        } catch (err) {
          saveStatus.textContent = `Sign failed: ${err?.message || String(err)}`;
          saveBtn.disabled = false;
          return;
        }

        saveStatus.textContent = `Publishing ${signedEvent.id}…`;
        const results = await publishEventToRelays(RELAYS, signedEvent);
        const ok = Object.values(results).some((r) => r?.ok);
        if (!ok) {
          saveStatus.textContent = "Publish failed (no relays reported OK).";
          saveBtn.disabled = false;
          return;
        }

        profilesByPubkey.set(pubkey, { pubkey, created_at: now, ...base });
        saveStatus.textContent = "Saved.";
        saveBtn.disabled = false;
        await renderProfile(pubkey, options);
      });

      box.append(aboutLabel, picLabel, bannerLabel, saveBtn, saveStatus);
      profileBox.append(box);
    }

    app.append(el("h3", { text: "Earned badges", style: "margin: 16px 0 10px;" }));
    const badgesBox = el("div", {}, [el("p", { class: "muted", text: "Loading badges…" })]);
    app.append(badgesBox);

    let awarded = null;
    let badgePrefs = null;
    try {
      [awarded, badgePrefs] = await Promise.all([fetchAwardedBadges(pubkey), fetchBadgePrefs(pubkey)]);
    } catch {
      awarded = { awards: [], definitionsByAddress: {} };
      badgePrefs = null;
    }
    if (seq !== renderSeq) return;

    const hiddenSet = new Set(Array.isArray(badgePrefs?.hidden) ? badgePrefs.hidden : []);
    const latestAwardByAddr = new Map(); // addr -> { addr, def, awardAt }
    for (const ev of awarded?.awards || []) {
      const addr = getTagValues(ev?.tags, "a")[0] || "";
      if (!addr) continue;
      const awardAt = typeof ev?.created_at === "number" ? ev.created_at : Number(ev?.created_at) || 0;
      const prev = latestAwardByAddr.get(addr);
      if (!prev || awardAt > prev.awardAt) {
        const def = awarded?.definitionsByAddress?.[addr] || null;
        latestAwardByAddr.set(addr, { addr, def, awardAt });
      }
    }

    const earnedBadges = Array.from(latestAwardByAddr.values()).sort((a, b) => b.awardAt - a.awardAt);
    const visibleBadges = earnedBadges.filter((b) => !hiddenSet.has(b.addr));

    const renderBadgeCards = (badges, { editable } = {}) => {
      badgesBox.innerHTML = "";
      if (!Array.isArray(badges) || badges.length === 0) {
        badgesBox.append(el("p", { class: "muted", text: "No badges yet." }));
        return { checkboxByAddr: new Map() };
      }

      const checkboxByAddr = new Map();
      const grid = el("div", { class: "badge-grid" });
      for (const b of badges) {
        const title = b.def?.name || "Badge";
        const unitRef = typeof b.def?.unitRef === "string" ? b.def.unitRef : "";
        const unit = parseUnitRef(unitRef);
        const unitHref =
          unit && unit.trackId && unit.unitId
            ? `#/track/${encodeURIComponent(unit.trackId)}/unit/${encodeURIComponent(unit.unitId)}`
            : "";

        const card = el("div", { class: "badge-card" });
        if (b.def?.imageUrl) {
          card.append(
            el("img", {
              class: "badge-icon",
              src: b.def.imageUrl,
              alt: "",
              loading: "lazy",
              decoding: "async",
              referrerpolicy: "no-referrer",
            })
          );
        } else {
          card.append(el("div", { class: "badge-icon badge-icon--empty", text: "★" }));
        }

        const meta = el("div", { class: "badge-meta" });
        meta.append(el("div", { class: "badge-title", text: title }));
        if (unitHref) meta.append(el("a", { href: unitHref, class: "muted", text: unitRef }));
        else if (unitRef) meta.append(el("div", { class: "muted", text: unitRef }));
        meta.append(el("div", { class: "muted", text: `Awarded: ${formatTimestamp(b.awardAt)}` }));
        card.append(meta);

        if (editable) {
          const label = document.createElement("label");
          label.className = "muted";
          label.style.display = "flex";
          label.style.alignItems = "center";
          label.style.gap = "8px";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = !hiddenSet.has(b.addr);
          label.append(cb, document.createTextNode("Show on profile"));
          card.append(label);
          checkboxByAddr.set(b.addr, cb);
        }

        grid.append(card);
      }
      badgesBox.append(grid);
      return { checkboxByAddr };
    };

    const isOwnProfileForBadges = normalizeHexPubkey(signedInPubkey) === pubkey;
    const { checkboxByAddr } = renderBadgeCards(isOwnProfileForBadges ? earnedBadges : visibleBadges, {
      editable: isOwnProfileForBadges,
    });

    if (isOwnProfileForBadges) {
      const saveRow = el("div", { style: "margin-top: 10px; display:flex; gap: 10px; align-items: center; flex-wrap: wrap;" });
      const saveBtn = el("button", { type: "button", text: "Save badge display settings" });
      const saveStatus = el("div", { class: "muted", style: "min-height: 1.2em;" });
      saveRow.append(saveBtn, saveStatus);
      badgesBox.append(saveRow);

      saveBtn.addEventListener("click", async () => {
        saveStatus.textContent = "";
        if (!window.nostr || typeof window.nostr.signEvent !== "function") {
          saveStatus.textContent = "Missing signer: Install/enable a Nostr signer (Alby).";
          return;
        }

        const hidden = [];
        for (const [addr, cb] of checkboxByAddr.entries()) {
          if (!cb.checked) hidden.push(addr);
        }

        saveBtn.disabled = true;
        saveStatus.textContent = "Signing…";
        try {
          const { signedEvent, results } = await publishBadgePrefs({ hidden });
          logRelayResults("badge prefs publish results", results);
          const ok = Object.values(results).some((r) => r?.ok);
          saveStatus.textContent = ok ? `Saved (${signedEvent.id}).` : "Save failed (no relays reported OK).";
        } catch (err) {
          saveStatus.textContent = `Save failed: ${err?.message || String(err)}`;
        } finally {
          saveBtn.disabled = false;
        }

        await renderProfile(pubkey, options);
      });
    }

    app.append(el("h3", { text: "Badges created", style: "margin: 16px 0 10px;" }));
    const createdBadgesBox = el("div", {}, [el("p", { class: "muted", text: "Loading created badges…" })]);
    app.append(createdBadgesBox);

    let createdBadges = [];
    try {
      createdBadges = await fetchBadgesCreatedBy(pubkey, { limit: 200 });
    } catch {
      createdBadges = [];
    }
    if (seq !== renderSeq) return;

    createdBadgesBox.innerHTML = "";
    if (!Array.isArray(createdBadges) || createdBadges.length === 0) {
      createdBadgesBox.append(el("p", { class: "muted", text: "No created badges yet." }));
    } else {
      const grid = el("div", { class: "badge-grid" });
      for (const def of createdBadges) {
        const title = def?.name || "Badge";
        const address = def?.address || "";
        const href = address ? `#/badge/${encodeURIComponent(address)}` : "#/badges";

        const unitRef = typeof def?.unitRef === "string" ? def.unitRef : "";
        const unit = parseUnitRef(unitRef);
        const unitHref =
          unit && unit.trackId && unit.unitId
            ? `#/track/${encodeURIComponent(unit.trackId)}/unit/${encodeURIComponent(unit.unitId)}`
            : "";

        const card = el("div", { class: "badge-card", style: "cursor:pointer;" });
        card.tabIndex = 0;
        const go = () => {
          window.location.hash = href;
        };
        card.addEventListener("click", go);
        card.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") go();
        });

        if (def?.imageUrl) {
          card.append(
            el("img", {
              class: "badge-icon",
              src: def.imageUrl,
              alt: "",
              loading: "lazy",
              decoding: "async",
              referrerpolicy: "no-referrer",
            })
          );
        } else {
          card.append(el("div", { class: "badge-icon badge-icon--empty", text: "★" }));
        }

        const meta = el("div", { class: "badge-meta" });
        meta.append(el("div", { class: "badge-title", text: title }));
        if (unitHref) {
          const a = el("a", { href: unitHref, class: "muted", text: unitRef });
          a.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            window.location.hash = unitHref;
          });
          meta.append(a);
        } else if (unitRef) {
          meta.append(el("div", { class: "muted", text: unitRef }));
        }
        if (address) meta.append(el("div", { class: "muted", text: shortHex(address) }));
        card.append(meta);
        grid.append(card);
      }
      createdBadgesBox.append(grid);
    }

    const postsBox = el("div", {}, [el("p", { class: "muted", text: "Loading posts…" })]);
    app.append(el("h3", { text: "Posts", style: "margin: 16px 0 10px;" }));
    app.append(postsBox);

    let posts = [];
    let pinnedIds = [];
    try {
      const [pinned, fetchedPosts] = await Promise.all([
        fetchPinnedEventIds(pubkey).catch(() => []),
        fetchYoyostrPostsByAuthor(pubkey, { limit: 50 }).catch(() => []),
      ]);
      pinnedIds = Array.isArray(pinned) ? pinned : [];
      posts = Array.isArray(fetchedPosts) ? fetchedPosts : [];
    } catch {
      posts = [];
      pinnedIds = [];
    }
    if (seq !== renderSeq) return;

    const publishPins = async (nextPinnedIds) => {
      try {
        window?.localStorage?.setItem(`yoyostr_pins_${pubkey}`, JSON.stringify(nextPinnedIds));
      } catch {
        // ignore
      }
      if (!isOwnProfile) return;
      if (!window.nostr || typeof window.nostr.signEvent !== "function") return;

      const now = Math.floor(Date.now() / 1000);
      const unsignedEvent = {
        kind: 10001,
        created_at: now,
        tags: nextPinnedIds.map((id) => ["e", id]),
        content: "",
        pubkey: normalizeHexPubkey(signedInPubkey),
      };
      let signedEvent;
      try {
        signedEvent = await window.nostr.signEvent(unsignedEvent);
      } catch (err) {
        setStatus(statusEl, `Pin sign failed: ${err?.message || String(err)}`, { error: true });
        return;
      }
      const results = await publishEventToRelays(RELAYS, signedEvent);
      const ok = Object.values(results).some((r) => r?.ok);
      if (!ok) {
        setStatus(statusEl, "Pin publish failed (no relays reported OK).", { error: true });
        return;
      }
      setStatus(statusEl, "Pins updated.");
    };

    const togglePin = async (eventId) => {
      const id = typeof eventId === "string" ? eventId.trim() : "";
      if (!id) return;
      const existingIdx = pinnedIds.indexOf(id);
      if (existingIdx >= 0) pinnedIds = pinnedIds.filter((x) => x !== id);
      else pinnedIds = [id, ...pinnedIds.filter((x) => x !== id)].slice(0, 3);
      renderPostsWithNames(postsBox, posts);
      publishPins(pinnedIds);
    };

    const orderPosts = (events) => {
      if (!Array.isArray(events) || events.length === 0) return [];
      if (!Array.isArray(pinnedIds) || pinnedIds.length === 0) return events;
      const byId = new Map(events.map((ev) => [ev?.id, ev]));
      const pinned = pinnedIds.map((id) => byId.get(id)).filter(Boolean);
      const pinnedSet = new Set(pinnedIds);
      const rest = events.filter((ev) => !pinnedSet.has(ev?.id));
      return [...pinned, ...rest];
    };

    const renderPostsWithNames = (container, events) => {
      container.innerHTML = "";
      const ordered = orderPosts(events);
      if (!Array.isArray(ordered) || ordered.length === 0) {
        container.append(el("p", { class: "muted", text: "No posts yet." }));
        return;
      }
      const pinnedSet = new Set(pinnedIds);
      for (const ev of ordered) {
        const card = renderPostCard(ev, { linkDate: true });
        const pk = typeof ev?.pubkey === "string" ? normalizeHexPubkey(ev.pubkey) : "";
        const cached = pk ? profilesByPubkey.get(pk) : null;
        const authorEl = card.querySelector?.('[data-role="author"]');
        if (authorEl && pk) authorEl.textContent = getBestDisplayName(cached, pk);
        const avatarEl = card.querySelector?.('[data-role="avatar"]');
        const pic = getProfilePictureUrl(cached);
        if (avatarEl && pic) {
          avatarEl.src = pic;
          avatarEl.style.display = "";
        }

        if (ev?.id && pinnedSet.has(ev.id)) {
          const meta = card.querySelector?.(".post-meta");
          if (meta) meta.append(el("span", { class: "badge", text: "Pinned" }));
        }
        if (isOwnProfile && ev?.id) {
          const meta = card.querySelector?.(".post-meta");
          if (meta) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = pinnedSet.has(ev.id) ? "Unpin" : "Pin";
            btn.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              togglePin(ev.id);
            });
            meta.append(btn);
          }
        }
        container.append(card);
      }
    };
    renderPostsWithNames(postsBox, posts);
    fetchProfiles(
      Array.from(new Set(posts.map((ev) => (typeof ev?.pubkey === "string" ? normalizeHexPubkey(ev.pubkey) : "")).filter(Boolean))).slice(
        0,
        40
      ),
      { limit: 120 }
    )
      .then((batch) => {
        for (const [pubkey, prof] of Object.entries(batch || {})) {
          const pk = normalizeHexPubkey(pubkey);
          if (pk) profilesByPubkey.set(pk, prof);
        }
        if (seq !== renderSeq) return;
        renderPostsWithNames(postsBox, posts);
      })
      .catch(() => {});
  };

  const renderTrack = async (trackId) => {
    setPageTitle([trackId]);
    const seq = ++renderSeq;
    app.innerHTML = "";

    const crumbs = el("div", { class: "crumbs" }, [
      el("a", { href: "#/", text: "Home" }),
      el("span", { class: "muted", text: "›" }),
      el("span", { text: trackId }),
    ]);

    app.append(crumbs);
    if (!tracksLoaded) {
      app.append(el("p", { class: "muted", text: "Loading tracks…" }));
      return;
    }
    const track = tracks.find((t) => String(t?.id || "") === trackId);
    setPageTitle([typeof track?.title === "string" && track.title.trim() ? track.title : trackId]);
    if (track) app.append(renderTrackHeader(track));
    else app.append(el("p", { class: "muted", text: "Track not found." }));

    const actions = el("div", { style: "display:flex; gap:10px; align-items:center; flex-wrap:wrap;" });
    if (isMaintainer) {
      const editTrackBtn = el("button", { type: "button", text: "Edit Track" });
      editTrackBtn.addEventListener("click", () => openAdmin({ mode: "track", trackId }));
      const addBtn = el("button", { type: "button", text: "Add Unit" });
      addBtn.addEventListener("click", () => openAdmin({ mode: "create", trackId }));
      actions.append(editTrackBtn, addBtn);
    }
    app.append(actions);

    const unitsBox = el("div", {}, [el("p", { class: "muted", text: "Loading units…" })]);
    app.append(unitsBox);

    const units = await ensureUnits(trackId);
    if (seq !== renderSeq) return;
    unitsBox.innerHTML = "";
    unitsBox.append(
      renderUnitList(units, {
        isMaintainer,
        trackId,
      })
    );
  };

  const renderUnit = async (trackId, unitId) => {
    setPageTitle([trackId, unitId]);
    const seq = ++renderSeq;
    app.innerHTML = "";

    const crumbs = el("div", { class: "crumbs" }, [
      el("a", { href: "#/", text: "Home" }),
      el("span", { class: "muted", text: "›" }),
      el("a", { href: `#/track/${encodeURIComponent(trackId)}`, text: trackId }),
      el("span", { class: "muted", text: "›" }),
      el("span", { text: unitId }),
    ]);
    app.append(crumbs);

    app.append(el("p", { class: "muted", text: "Loading unit…" }));
    const units = await ensureUnits(trackId);
    if (seq !== renderSeq) return;

    app.innerHTML = "";
    app.append(crumbs);

    const unit = units.find((u) => String(u?.unitId || "") === unitId);
    if (!unit) {
      setPageTitle([trackId, unitId]);
      app.append(el("p", { class: "muted", text: "Unit not found." }));
      return;
    }

    const track = tracks.find((t) => String(t?.id || "") === trackId);
    const trackTitle = typeof track?.title === "string" && track.title.trim() ? track.title : trackId;
    const unitTitle = typeof unit?.title === "string" && unit.title.trim() ? unit.title : unitId;
    setPageTitle([trackTitle, unitTitle]);

    app.append(el("h2", { text: typeof unit.title === "string" ? unit.title : "Untitled unit", style: "margin: 0 0 6px;" }));
    if (unit?.deleted === true) app.append(el("p", { class: "muted", text: "This unit is soft-deleted." }));
    const description = typeof unit.description === "string" ? unit.description : "";
    if (description) app.append(el("p", { class: "muted", text: description }));

    const renderUnitVideos = () => {
      app.append(el("h3", { text: "Videos", style: "margin: 16px 0 10px;" }));

      const videos = Array.isArray(unit.videos) ? unit.videos : [];
      if (videos.length === 0) {
        app.append(el("p", { class: "muted", text: "No videos yet." }));
        return;
      }

      const unitKey = `${trackId}:${unitId}`;
      const selectedIndex = Math.min(
        Math.max(0, Number(selectedVideoByUnitKey.get(unitKey) ?? 0)),
        videos.length - 1
      );

      const embedBox = el("div", {}, [renderEmbedArea(videos[selectedIndex])]);
      const list = el("ul", { class: "video-list" });
      videos.forEach((v, idx) => {
        const label = typeof v?.title === "string" && v.title.trim() ? v.title : `Video ${idx + 1}`;
        const url = typeof v?.url === "string" ? v.url : "";

        const btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("aria-current", idx === selectedIndex ? "true" : "false");
        btn.append(el("div", { text: label }));
        btn.append(el("div", { class: "unit-meta", text: url || "—" }));
        btn.addEventListener("click", () => {
          selectedVideoByUnitKey.set(unitKey, idx);
          renderUnit(trackId, unitId);
        });
        list.append(el("li", {}, [btn]));
      });

      app.append(embedBox);
      app.append(list);
    };

    renderUnitVideos();

    const unitActions = el("div", { style: "display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin: 16px 0 10px;" });
    const proofBtn = el("button", { type: "button", text: "Post proof" });
    proofBtn.disabled = !signedInPubkey;
    proofBtn.addEventListener("click", () =>
      openProofDialog({
        trackId,
        unitId,
        unitTitle: typeof unit?.title === "string" ? unit.title : unitId,
      })
    );
    unitActions.append(proofBtn);
    if (isMaintainer) {
      const editUnitBtn = el("button", { type: "button", text: "Edit Unit" });
      editUnitBtn.addEventListener("click", () => openAdmin({ mode: "editUnit", trackId, unitId }));

      const addVideoBtn = el("button", { type: "button", text: "Add Video to Unit" });
      addVideoBtn.addEventListener("click", () => openAdmin({ mode: "addVideo", trackId, unitId }));

      unitActions.append(editUnitBtn, addVideoBtn);
    }
    if (!signedInPubkey) unitActions.append(el("span", { class: "muted", text: "Sign in to post." }));
    app.append(unitActions);

    const unitRef = `unit:${trackId}:${unitId}`;

    // Badge definition (NIP-58, kind 30009).
    app.append(el("h3", { text: "Badges", style: "margin: 16px 0 10px;" }));
    const badgeBox = el("div", {}, [el("p", { class: "muted", text: "Loading badge…" })]);
    app.append(badgeBox);

    let badgeDefs = [];
    try {
      badgeDefs = await fetchBadgeDefinitionsForUnit(unitRef);
    } catch {
      badgeDefs = [];
    }
    if (seq !== renderSeq) return;

    const existingDSet = new Set(badgeDefs.map((b) => b?.d).filter(Boolean));
    let editingD = "";

    const renderBadgeBox = () => {
      badgeBox.innerHTML = "";

      const canCreate =
        Boolean(signedInPubkey) && Boolean(window.nostr && typeof window.nostr.signEvent === "function");

      if (!Array.isArray(badgeDefs) || badgeDefs.length === 0) {
        badgeBox.append(el("p", { class: "muted", text: "No badges yet." }));
      } else {
        const list = el("div", { style: "display:grid; gap: 10px;" });
        for (const b of badgeDefs) {
          const title = b?.name || "Unnamed badge";
          const creatorPubkey = typeof b?.pubkey === "string" ? b.pubkey : "";
          const creatorLink = creatorPubkey ? `#/p/${encodeURIComponent(creatorPubkey)}` : "#/profile";
          const isCreator = normalizeHexPubkey(signedInPubkey) && normalizeHexPubkey(signedInPubkey) === normalizeHexPubkey(creatorPubkey);

          const row = el("div", { class: "post-card", style: "gap: 8px;" });
          const top = el("div", { style: "display:flex; gap: 12px; align-items: center; flex-wrap: wrap;" });
          if (b?.imageUrl) {
            top.append(
              el("img", {
                src: b.imageUrl,
                alt: "",
                loading: "lazy",
                decoding: "async",
                referrerpolicy: "no-referrer",
                style:
                  "width:48px; height:48px; border-radius: 12px; object-fit: cover; border: 1px solid rgba(127,127,127,.25); background: rgba(127,127,127,.08);",
              })
            );
          }
          top.append(
            el("div", {}, [
              el("div", { text: title }),
              el("div", { class: "muted", text: `Creator: ${creatorPubkey ? shortHex(creatorPubkey) : "unknown"}` }),
            ])
          );
          top.append(el("a", { href: creatorLink, class: "muted", text: "View creator" }));
          if (isCreator) {
            const editBtn = el("button", { type: "button", text: editingD === b.d ? "Editing" : "Edit" });
            editBtn.disabled = editingD === b.d;
            editBtn.addEventListener("click", () => {
              editingD = b.d || "";
              renderBadgeBox();
            });
            top.append(editBtn);
          }
          row.append(top);
          if (b?.description) row.append(el("div", { class: "muted", text: b.description }));
          row.append(el("div", { class: "muted", text: `d: ${b?.d || "—"}` }));
          list.append(row);
        }
        badgeBox.append(list);
      }

      if (!canCreate) {
        badgeBox.append(el("p", { class: "muted", text: "Sign in to create or edit badges." }));
        return;
      }

      const form = el("div", { class: "composer", style: "margin-top: 10px;" });
      form.append(
        el("div", {
          class: "muted",
          text: editingD ? "Edit selected badge (publishes an updated replaceable event)." : "Create a new badge for this unit (NIP-58).",
        })
      );

      const nameLabel = document.createElement("label");
      nameLabel.textContent = "Badge name";
      const name = document.createElement("input");
      name.placeholder = "e.g., Sleeper";
      nameLabel.append(name);

      const descLabel = document.createElement("label");
      descLabel.textContent = "Description";
      const desc = document.createElement("textarea");
      desc.rows = 2;
      desc.placeholder = "What does earning this badge mean?";
      descLabel.append(desc);

      const imgLabel = document.createElement("label");
      imgLabel.textContent = "Image URL (optional)";
      const imageUrl = document.createElement("input");
      imageUrl.placeholder = "https://…";
      imgLabel.append(imageUrl);

      const btnRow = el("div", { style: "display:flex; gap: 10px; align-items:center; flex-wrap: wrap;" });
      const newBtn = el("button", { type: "button", text: "New badge" });
      const publishBtn = el("button", { type: "button", text: editingD ? "Publish badge update" : "Publish new badge" });
      const status = el("div", { class: "muted", style: "min-height: 1.2em;" });

      const setFormFromEditing = () => {
        const current = badgeDefs.find((b) => b?.d === editingD) || null;
        if (!current) return;
        name.value = current.name || "";
        desc.value = current.description || "";
        imageUrl.value = current.imageUrl || "";
      };
      if (editingD) setFormFromEditing();

      newBtn.addEventListener("click", () => {
        editingD = "";
        name.value = "";
        desc.value = "";
        imageUrl.value = "";
        status.textContent = "";
        renderBadgeBox();
      });

      publishBtn.addEventListener("click", async () => {
        status.textContent = "";
        if (!window.nostr || typeof window.nostr.signEvent !== "function") {
          status.textContent = "Missing signer: Install/enable a Nostr signer (Alby).";
          return;
        }
        const n = String(name.value || "").trim();
        if (!n) {
          status.textContent = "Enter a badge name.";
          name.focus();
          return;
        }

        publishBtn.disabled = true;
        newBtn.disabled = true;
        status.textContent = "Signing…";
        try {
          const unitAddress = `30079:${MAINTAINER_PUBKEY_HEX.trim()}:${unitRef}`;
          const nextD = editingD || makeUniqueBadgeD({ unitRef, name: n, existingDSet });
          const { signedEvent, results } = await publishBadgeDefinition({
            badgeId: nextD,
            name: n,
            description: String(desc.value || "").trim(),
            imageUrl: String(imageUrl.value || "").trim(),
            unitRef,
            unitAddress,
          });
          logRelayResults("badge definition publish results", results);
          const ok = Object.values(results).some((r) => r?.ok);
          status.textContent = ok ? `Published ${signedEvent.id}.` : "Publish failed (no relays reported OK).";
        } catch (err) {
          status.textContent = `Publish failed: ${err?.message || String(err)}`;
        } finally {
          publishBtn.disabled = false;
          newBtn.disabled = false;
        }

        try {
          badgeDefs = await fetchBadgeDefinitionsForUnit(unitRef);
        } catch {
          badgeDefs = [];
        }
        if (seq !== renderSeq) return;
        existingDSet.clear();
        for (const b of badgeDefs) if (b?.d) existingDSet.add(b.d);
        if (!editingD) {
          // Keep editing the newly created badge (best guess: latest).
          editingD = badgeDefs[0]?.d || "";
        }
        renderBadgeBox();
      });

      btnRow.append(newBtn, publishBtn);
      form.append(nameLabel, descLabel, imgLabel, btnRow, status);
      badgeBox.append(form);
    };

    renderBadgeBox();

    // Proof review + award.
    app.append(el("h3", { text: "Proofs", style: "margin: 16px 0 10px;" }));
    const proofsBox = el("div", {}, [el("p", { class: "muted", text: "Loading proofs…" })]);
    app.append(proofsBox);

    let proofs = [];
    try {
      proofs = await fetchProofsForUnit(unitRef, { limit: 20 });
    } catch {
      proofs = [];
    }
    if (seq !== renderSeq) return;

    let heldBadgeAddressSet = new Set();
    if (signedInPubkey) {
      try {
        const { awards } = await fetchAwardedBadges(signedInPubkey, { limit: 200 });
        heldBadgeAddressSet = new Set(
          awards
            .flatMap((ev) => getTagValues(ev?.tags, "a"))
            .filter((addr) => typeof addr === "string" && addr.trim())
        );
      } catch {
        heldBadgeAddressSet = new Set();
      }
    }

    const awardableBadges = (badgeDefs || []).filter((b) => {
      const creator = normalizeHexPubkey(b?.pubkey);
      const me = normalizeHexPubkey(signedInPubkey);
      if (!me) return false;
      if (creator && creator === me) return true;
      return Boolean(b?.address && heldBadgeAddressSet.has(b.address));
    });
    const canAwardAny = awardableBadges.length > 0;

    const renderProofsWithNames = (container, events) => {
      container.innerHTML = "";
      if (!Array.isArray(events) || events.length === 0) {
        container.append(el("p", { class: "muted", text: "No proofs yet." }));
        return;
      }

      if (signedInPubkey && (badgeDefs || []).length > 0 && !canAwardAny) {
        container.append(
          el("p", {
            class: "muted",
            text: "Signed in, but not qualified to award badges for this unit yet (must be badge creator or already hold that badge).",
          })
        );
      }

      const list = el("div", { style: "display:grid; gap: 10px;" });
      for (const ev of events) {
        const card = renderPostCard(ev);

        const pk = typeof ev?.pubkey === "string" ? normalizeHexPubkey(ev.pubkey) : "";
        const cached = pk ? profilesByPubkey.get(pk) : null;
        const authorEl = card.querySelector?.('[data-role="author"]');
        if (authorEl && pk) authorEl.textContent = getBestDisplayName(cached, pk);
        const avatarEl = card.querySelector?.('[data-role="avatar"]');
        const pic = getProfilePictureUrl(cached);
        if (avatarEl && pic) {
          avatarEl.src = pic;
          avatarEl.style.display = "";
        }

        const status = el("div", { class: "muted", style: "min-height: 1.2em;" });
        if (canAwardAny) {
          const btnRow = el("div", { style: "display:flex; gap: 10px; align-items: center; flex-wrap: wrap;" });
          let badgeSelect = null;
          if (awardableBadges.length > 1) {
            badgeSelect = document.createElement("select");
            for (const b of awardableBadges) {
              const opt = document.createElement("option");
              opt.value = b.address;
              opt.textContent = b.name || b.d || b.address;
              badgeSelect.append(opt);
            }
            btnRow.append(badgeSelect);
          } else if (awardableBadges[0]) {
            btnRow.append(el("span", { class: "badge", text: awardableBadges[0].name || "Badge" }));
          }

          const approveBtn = el("button", { type: "button", text: "Approve & Award" });
          const denyBtn = el("button", { type: "button", text: "Deny" });

          approveBtn.addEventListener("click", async () => {
            status.textContent = "";
            if (!window.nostr || typeof window.nostr.signEvent !== "function") {
              status.textContent = "Missing signer: Install/enable a Nostr signer (Alby).";
              return;
            }

            const note = window.prompt("Optional note to include with the badge award:", "Approved.");
            approveBtn.disabled = true;
            denyBtn.disabled = true;
            status.textContent = "Signing award…";
            try {
              const selectedAddress =
                (badgeSelect && typeof badgeSelect.value === "string" && badgeSelect.value.trim()) ||
                awardableBadges[0]?.address ||
                "";
              if (!selectedAddress) throw new Error("Missing selected badge.");

              const recipient = typeof ev?.pubkey === "string" ? ev.pubkey : "";
              const proofId = typeof ev?.id === "string" ? ev.id : "";
              const { signedEvent, results } = await publishBadgeAward({
                badgeAddress: selectedAddress,
                recipientPubkeyHex: recipient,
                proofEventId: proofId,
                unitRef,
                note: typeof note === "string" ? note : "",
              });
              logRelayResults("badge award publish results", results);
              const ok = Object.values(results).some((r) => r?.ok);
              status.textContent = ok ? `Awarded (${signedEvent.id}).` : "Award publish failed (no relays reported OK).";
            } catch (err) {
              status.textContent = `Award failed: ${err?.message || String(err)}`;
            } finally {
              approveBtn.disabled = false;
              denyBtn.disabled = false;
            }
          });

          denyBtn.addEventListener("click", async () => {
            status.textContent = "";
            if (!window.nostr || typeof window.nostr.signEvent !== "function") {
              status.textContent = "Missing signer: Install/enable a Nostr signer (Alby).";
              return;
            }

            const reason = window.prompt("Denial reason (optional):", "");
            denyBtn.disabled = true;
            approveBtn.disabled = true;
            status.textContent = "Signing denial…";
            try {
              const proofId = typeof ev?.id === "string" ? ev.id : "";
              const recipient = typeof ev?.pubkey === "string" ? ev.pubkey : "";
              const content = reason ? `Denied: ${reason}` : "Denied.";
              const now = Math.floor(Date.now() / 1000);
              const unsignedEvent = {
                kind: 1,
                created_at: now,
                tags: [
                  ["e", proofId],
                  ...(recipient ? [["p", recipient]] : []),
                  ["t", APP_TAG],
                  ["t", unitRef],
                  ["t", "badge-deny"],
                  ["t", "type:review"],
                ],
                content,
                pubkey: normalizeHexPubkey(signedInPubkey),
              };
              const signedEvent = await window.nostr.signEvent(unsignedEvent);
              const results = await publishEventToRelays(RELAYS, signedEvent);
              logRelayResults("denial publish results", results);
              const ok = Object.values(results).some((r) => r?.ok);
              status.textContent = ok ? `Denied (${signedEvent.id}).` : "Denial publish failed (no relays reported OK).";
            } catch (err) {
              status.textContent = `Deny failed: ${err?.message || String(err)}`;
            } finally {
              denyBtn.disabled = false;
              approveBtn.disabled = false;
            }
          });

          btnRow.append(approveBtn, denyBtn);
          card.append(btnRow);
        }

        card.append(status);
        list.append(card);
      }
      container.append(list);
    };

    renderProofsWithNames(proofsBox, proofs);

    fetchProfiles(
      Array.from(new Set(proofs.map((ev) => (typeof ev?.pubkey === "string" ? normalizeHexPubkey(ev.pubkey) : "")).filter(Boolean))).slice(
        0,
        40
      ),
      { limit: 120 }
    )
      .then((batch) => {
        for (const [pubkey, prof] of Object.entries(batch || {})) {
          const pk = normalizeHexPubkey(pubkey);
          if (pk) profilesByPubkey.set(pk, prof);
        }
        if (seq !== renderSeq) return;
        renderProofsWithNames(proofsBox, proofs);
      })
      .catch(() => {});
  };

    const renderRouteUnsafe = async () => {
      updateAuthUi();
      const route = parseRoute(window.location.hash);
      updateNavUi(route);
      if (route.name === "track") return await renderTrack(route.trackId);
      if (route.name === "unit") return await renderUnit(route.trackId, route.unitId);
      if (route.name === "community") return await renderCommunity();
      if (route.name === "badges") return await renderBadges();
      if (route.name === "badge_view") return await renderBadgeDetail(route.address);
      if (route.name === "post_view") return await renderPostPermalink(route.eventId);
      if (route.name === "profile") {
      if (!signedInPubkey) {
        app.innerHTML = "";
        app.append(el("h2", { text: "Your Profile", style: "margin: 0 0 12px;" }));
        app.append(el("p", { class: "muted", text: "Sign in to view your profile." }));
        setPageTitle(["Profile"]);
        return;
      }
      return await renderProfile(signedInPubkey, { isSelf: true });
    }
    if (route.name === "profile_view") return await renderProfile(route.pubkeyHex, { isSelf: false });
    if (route.name === "not_found") {
      app.innerHTML = "";
      app.append(el("h2", { text: "Not Found", style: "margin: 0 0 12px;" }));
      app.append(el("p", { class: "muted", text: `No route matches ${route.path}` }));
      app.append(el("a", { href: "#/", text: "Go to Home" }));
      setPageTitle(["Not Found"]);
      return;
    }
    renderHome();
  };

    const renderRoute = async () => {
      try {
        return await renderRouteUnsafe();
      } catch (err) {
        showVisibleError(err, { title: "Render error", statusEl, appEl: app });
      }
    };

  async function openAdminWithDefaults(options = {}) {
    if (!adminUi) adminUi = createAdminDialog();

    const closeAdminDialog = () => {
      try {
        adminUi?.dialog?.close?.();
      } catch {}
    };

    if (options.refreshTracksFromNostr !== false) {
      await refreshTracksFromRelays();
    }

    const trackOptions = getTrackOptions();
    setSelectOptions(adminUi.createUnit.track, trackOptions, options.trackId);
    setSelectOptions(adminUi.addVideo.track, trackOptions, options.trackId);
    setSelectOptions(adminUi.trackMgmt.track, trackOptions, options.trackId);
    setSelectOptions(adminUi.editUnit.track, trackOptions, options.trackId);

    const selectedTrackId =
      (options.trackId && Array.from(adminUi.createUnit.track.options).some((o) => o.value === options.trackId))
        ? options.trackId
        : adminUi.createUnit.track.value;

    const setUnitOptions = async (trackId, selectedUnitId) => {
      setSelectOptions(adminUi.addVideo.unit, [{ value: "", label: "Loading…" }], "");
      const units = await ensureUnits(trackId);
      const opts = units
        .filter((u) => typeof u?.unitId === "string" && u.unitId.trim())
        .map((u) => ({
          value: u.unitId,
          label: `${u.title || u.unitId} (${u.unitId})`,
        }));
      setSelectOptions(adminUi.addVideo.unit, [{ value: "", label: "Select a unit…" }, ...opts], selectedUnitId);
    };

    const mode = String(options.mode || "").trim();
    if (mode === "editUnit" || mode === "addVideo") {
      unitsByTrackId.delete(selectedTrackId);
      await ensureUnits(selectedTrackId);
    }

    await setUnitOptions(selectedTrackId, options.unitId);
    await setEditUnitOptions(selectedTrackId, options.unitId);
    populateTrackMgmt(selectedTrackId);

    if (adminUi.dialog.dataset.wired !== "1") {
      adminUi.dialog.dataset.wired = "1";

      adminUi.trackMgmt.addPlaylistBtn.addEventListener("click", () => addTrackPlaylistRow({}));
      adminUi.trackMgmt.track.addEventListener("change", () => {
        const trackId = String(adminUi.trackMgmt.track.value || "").trim();
        const nextTrackOptions = getTrackOptions();
        setSelectOptions(adminUi.createUnit.track, nextTrackOptions, trackId);
        setSelectOptions(adminUi.addVideo.track, nextTrackOptions, trackId);
        setSelectOptions(adminUi.editUnit.track, nextTrackOptions, trackId);
        setUnitOptions(trackId);
        setEditUnitOptions(trackId);
        populateTrackMgmt(trackId);
      });
      adminUi.trackMgmt.publishBtn.addEventListener("click", async () => {
        if (!window.nostr || typeof window.nostr.signEvent !== "function") {
          appendLog(adminUi.log, "Missing signer: Install/enable a Nostr signer (Alby).");
          return;
        }
        if (!signedInPubkey) {
          appendLog(adminUi.log, "Not signed in.");
          return;
        }
        if (!isMaintainer) {
          appendLog(adminUi.log, "Not maintainer.");
          return;
        }

        const trackId = String(adminUi.trackMgmt.track.value || "").trim();
        if (!trackId) return appendLog(adminUi.log, "Publish Track Update: select a track.");
        const existing = tracks.find((t) => String(t?.id || "") === trackId);
        if (!existing) return appendLog(adminUi.log, "Publish Track Update: track not found (refresh?).");

        const title = String(adminUi.trackMgmt.title.value || "").trim();
        const description = String(adminUi.trackMgmt.description.value || "").trim();
        const orderRaw = String(adminUi.trackMgmt.order.value || "").trim();
        const orderNum = orderRaw === "" ? null : Number(orderRaw);
        if (orderRaw !== "" && !Number.isFinite(orderNum)) {
          return appendLog(adminUi.log, "Publish Track Update: order must be a number (or blank).");
        }

        const { created_at, d, ...base } = existing;
        const updatedTrack = {
          ...base,
          id: trackId,
          title: title || existing.title || trackId,
          description: description || undefined,
          playlists: readTrackPlaylistsFromEditor(),
          order: orderNum === null ? undefined : orderNum,
        };

        const now = Math.floor(Date.now() / 1000);
        const unsignedEvent = {
          kind: KIND_TRACK,
          created_at: now,
          tags: [
            ["d", `track:${trackId}`],
            ["t", "yoyostr"],
            ["t", "track"],
          ],
          content: JSON.stringify(updatedTrack),
          pubkey: normalizeHexPubkey(signedInPubkey),
        };

        appendLog(adminUi.log, `Signing track:${trackId} (update)…`);
        let signedEvent;
        try {
          signedEvent = await window.nostr.signEvent(unsignedEvent);
        } catch (err) {
          appendLog(adminUi.log, `Sign failed: ${err?.message || String(err)}`);
          return;
        }

        appendLog(adminUi.log, `Publishing ${signedEvent.id} to ${RELAYS.length} relays…`);
        const results = await publishEventToRelays(RELAYS, signedEvent);
        for (const [relayUrl, result] of Object.entries(results)) {
          const okText = result?.ok ? "OK" : "FAIL";
          const msg = typeof result?.message === "string" && result.message ? ` - ${result.message}` : "";
          const timeoutText = result?.timeout ? " (timeout)" : "";
          appendLog(adminUi.log, `${relayUrl}: ${okText}${timeoutText}${msg}`);
        }

        appendLog(adminUi.log, "Reloading tracks from Nostr…");
        setStatus(statusEl, "Reloading tracks from Nostr…");
        await refreshTracksFromRelays();
        const updatedTrackOptions = getTrackOptions();
        setSelectOptions(adminUi.createUnit.track, updatedTrackOptions, trackId);
        setSelectOptions(adminUi.addVideo.track, updatedTrackOptions, trackId);
        setSelectOptions(adminUi.trackMgmt.track, updatedTrackOptions, trackId);
        setSelectOptions(adminUi.editUnit.track, updatedTrackOptions, trackId);
        populateTrackMgmt(trackId);
        await renderRoute();
        setStatus(statusEl, "Done.");
        appendLog(adminUi.log, "Tracks refreshed.");
        closeAdminDialog();
      });

      adminUi.trackMgmt.overwriteBtn.addEventListener("click", overwriteAllTracksFromFallback);
      adminUi.createUnit.videoUrl.addEventListener("input", () => {
        renderAdminPreview(adminUi.createUnit.preview, adminUi.createUnit.videoUrl.value);
        scheduleCreateUnitVideoTitleAutofill();
      });
      adminUi.addVideo.videoUrl.addEventListener("input", () =>
        renderAdminPreview(adminUi.addVideo.preview, adminUi.addVideo.videoUrl.value)
      );

      adminUi.createUnit.track.addEventListener("change", () => {
        const nextTrackOptions = getTrackOptions();
        setSelectOptions(adminUi.addVideo.track, nextTrackOptions, adminUi.createUnit.track.value);
        setSelectOptions(adminUi.trackMgmt.track, nextTrackOptions, adminUi.createUnit.track.value);
        setSelectOptions(adminUi.editUnit.track, nextTrackOptions, adminUi.createUnit.track.value);
        setUnitOptions(adminUi.createUnit.track.value);
        setEditUnitOptions(adminUi.createUnit.track.value);
        populateTrackMgmt(adminUi.trackMgmt.track.value);
      });
      adminUi.addVideo.track.addEventListener("change", () => {
        const nextTrackOptions = getTrackOptions();
        setSelectOptions(adminUi.createUnit.track, nextTrackOptions, adminUi.addVideo.track.value);
        setSelectOptions(adminUi.trackMgmt.track, nextTrackOptions, adminUi.addVideo.track.value);
        setSelectOptions(adminUi.editUnit.track, nextTrackOptions, adminUi.addVideo.track.value);
        setUnitOptions(adminUi.addVideo.track.value);
        setEditUnitOptions(adminUi.addVideo.track.value);
        populateTrackMgmt(adminUi.trackMgmt.track.value);
      });

      adminUi.editUnit.track.addEventListener("change", () => {
        const trackId = String(adminUi.editUnit.track.value || "").trim();
        const nextTrackOptions = getTrackOptions();
        setSelectOptions(adminUi.createUnit.track, nextTrackOptions, trackId);
        setSelectOptions(adminUi.addVideo.track, nextTrackOptions, trackId);
        setSelectOptions(adminUi.trackMgmt.track, nextTrackOptions, trackId);
        setUnitOptions(trackId);
        setEditUnitOptions(trackId);
        populateTrackMgmt(trackId);
      });

      adminUi.editUnit.unit.addEventListener("change", () => {
        populateEditUnitForm(adminUi.editUnit.track.value, adminUi.editUnit.unit.value);
      });

      adminUi.editUnit.addVideoBtn.addEventListener("click", () => addEditUnitVideoRow({}));

      adminUi.editUnit.publishBtn.addEventListener("click", async () => {
        if (!window.nostr || typeof window.nostr.signEvent !== "function") {
          appendLog(adminUi.log, "Missing signer: Install/enable a Nostr signer (Alby).");
          return;
        }
        if (!signedInPubkey) {
          appendLog(adminUi.log, "Not signed in.");
          return;
        }
        if (!isMaintainer) {
          appendLog(adminUi.log, "Not maintainer.");
          return;
        }

        const trackId = String(adminUi.editUnit.track.value || "").trim();
        const unitId = String(adminUi.editUnit.unit.value || "").trim();
        const title = String(adminUi.editUnit.title.value || "").trim();
        const type = String(adminUi.editUnit.type.value || "other").trim() || "other";
        const orderNum = Number(adminUi.editUnit.order.value);
        const description = String(adminUi.editUnit.description.value || "").trim();
        const deleted = Boolean(adminUi.editUnit.softDelete.checked);
        const videos = readEditUnitVideosFromEditor();

        if (!trackId) return appendLog(adminUi.log, "Publish Unit Update: missing trackId.");
        if (!unitId) return appendLog(adminUi.log, "Publish Unit Update: select a unit.");
        if (!title) return appendLog(adminUi.log, "Publish Unit Update: missing title.");
        if (!Number.isFinite(orderNum)) return appendLog(adminUi.log, "Publish Unit Update: order must be a number.");

        const units = await ensureUnits(trackId);
        const existing = units.find((u) => String(u?.unitId || "") === unitId);
        if (!existing) return appendLog(adminUi.log, "Publish Unit Update: unit not found (refresh?).");

        const { created_at, d, ...base } = existing;
        const updatedUnit = {
          ...base,
          trackId,
          unitId,
          title,
          type,
          order: orderNum,
          description: description || undefined,
          videos,
          deleted: deleted ? true : undefined,
        };

        const now = Math.floor(Date.now() / 1000);
        const unsignedEvent = {
          kind: KIND_UNIT,
          created_at: now,
          tags: [
            ["d", `unit:${trackId}:${unitId}`],
            ["t", "yoyostr"],
            ["t", "unit"],
            ["t", `track:${trackId}`],
            ["t", `type:${type}`],
          ],
          content: JSON.stringify(updatedUnit),
          pubkey: normalizeHexPubkey(signedInPubkey),
        };

        appendLog(adminUi.log, `Signing unit:${trackId}:${unitId} (update)…`);
        let signedEvent;
        try {
          signedEvent = await window.nostr.signEvent(unsignedEvent);
        } catch (err) {
          appendLog(adminUi.log, `Sign failed: ${err?.message || String(err)}`);
          return;
        }

        appendLog(adminUi.log, `Publishing ${signedEvent.id} to ${RELAYS.length} relays…`);
        const results = await publishEventToRelays(RELAYS, signedEvent);
        for (const [relayUrl, result] of Object.entries(results)) {
          const okText = result?.ok ? "OK" : "FAIL";
          const msg = typeof result?.message === "string" && result.message ? ` - ${result.message}` : "";
          const timeoutText = result?.timeout ? " (timeout)" : "";
          appendLog(adminUi.log, `${relayUrl}: ${okText}${timeoutText}${msg}`);
        }

        unitsByTrackId.delete(trackId);
        await ensureUnits(trackId);
        setUnitOptions(trackId);
        setEditUnitOptions(trackId, unitId);
        await renderRoute();
        appendLog(adminUi.log, "Units refreshed.");
        closeAdminDialog();
      });

      adminUi.createUnit.publishBtn.addEventListener("click", async () => {
        if (!window.nostr || typeof window.nostr.signEvent !== "function") {
          appendLog(adminUi.log, "Missing signer: Install/enable a Nostr signer (Alby).");
          return;
        }
        if (!signedInPubkey) {
          appendLog(adminUi.log, "Not signed in.");
          return;
        }
        if (!isMaintainer) {
          appendLog(adminUi.log, "Not maintainer.");
          return;
        }

        const trackId = String(adminUi.createUnit.track.value || "").trim();
        const unitId = String(adminUi.createUnit.unitId.value || "").trim();
        const title = String(adminUi.createUnit.title.value || "").trim();
        const type = String(adminUi.createUnit.type.value || "other").trim();
        const orderNum = Number(adminUi.createUnit.order.value);
        const description = String(adminUi.createUnit.description.value || "").trim();
        const videoTitle = String(adminUi.createUnit.videoTitle.value || "").trim();
        const videoUrl = String(adminUi.createUnit.videoUrl.value || "").trim();

        if (!trackId) return appendLog(adminUi.log, "Create Unit: missing trackId.");
        if (!unitId) return appendLog(adminUi.log, "Create Unit: missing unitId.");
        if (!title) return appendLog(adminUi.log, "Create Unit: missing title.");
        if (!Number.isFinite(orderNum)) return appendLog(adminUi.log, "Create Unit: order must be a number.");
        if (!videoUrl) return appendLog(adminUi.log, "Create Unit: missing videoUrl.");

        const existingUnits = await ensureUnits(trackId);
        const existing = existingUnits.find((u) => String(u?.unitId || "") === unitId);
        if (existing) {
          appendLog(adminUi.log, `Create Unit: unitId already exists: ${unitId}`);
          const ok = window.confirm(`Unit "${unitId}" already exists. Republish/overwrite it?`);
          if (!ok) return;
        }

        const unitObject = {
          trackId,
          unitId,
          title,
          type: type || "other",
          order: orderNum,
          description: description || undefined,
          videos: [{ title: videoTitle || undefined, url: videoUrl }],
        };

        const now = Math.floor(Date.now() / 1000);
        const unsignedEvent = {
          kind: KIND_UNIT,
          created_at: now,
          tags: [
            ["d", `unit:${trackId}:${unitId}`],
            ["t", "yoyostr"],
            ["t", "unit"],
            ["t", `track:${trackId}`],
            ["t", `type:${unitObject.type}`],
          ],
          content: JSON.stringify(unitObject),
          pubkey: normalizeHexPubkey(signedInPubkey),
        };

        appendLog(adminUi.log, `Signing unit:${trackId}:${unitId}…`);
        let signedEvent;
        try {
          signedEvent = await window.nostr.signEvent(unsignedEvent);
        } catch (err) {
          appendLog(adminUi.log, `Sign failed: ${err?.message || String(err)}`);
          return;
        }

        appendLog(adminUi.log, `Publishing ${signedEvent.id} to ${RELAYS.length} relays…`);
        const results = await publishEventToRelays(RELAYS, signedEvent);
        for (const [relayUrl, result] of Object.entries(results)) {
          const okText = result?.ok ? "OK" : "FAIL";
          const msg = typeof result?.message === "string" && result.message ? ` - ${result.message}` : "";
          const timeoutText = result?.timeout ? " (timeout)" : "";
          appendLog(adminUi.log, `${relayUrl}: ${okText}${timeoutText}${msg}`);
        }

        const hadOk = Object.values(results).some((r) => r?.ok);
        if (hadOk) resetCreateUnitForm();

        unitsByTrackId.delete(trackId);
        await ensureUnits(trackId);
        setUnitOptions(trackId);
        setEditUnitOptions(trackId, unitId);
        await renderRoute();
        appendLog(adminUi.log, "Units refreshed.");
        closeAdminDialog();
      });

      adminUi.addVideo.publishBtn.addEventListener("click", async () => {
        if (!window.nostr || typeof window.nostr.signEvent !== "function") {
          appendLog(adminUi.log, "Missing signer: Install/enable a Nostr signer (Alby).");
          return;
        }
        if (!signedInPubkey) {
          appendLog(adminUi.log, "Not signed in.");
          return;
        }
        if (!isMaintainer) {
          appendLog(adminUi.log, "Not maintainer.");
          return;
        }

        const trackId = String(adminUi.addVideo.track.value || "").trim();
        const unitId = String(adminUi.addVideo.unit.value || "").trim();
        const videoTitle = String(adminUi.addVideo.videoTitle.value || "").trim();
        const videoUrl = String(adminUi.addVideo.videoUrl.value || "").trim();

        if (!trackId) return appendLog(adminUi.log, "Add Video: missing trackId.");
        if (!unitId) return appendLog(adminUi.log, "Add Video: select a unit.");
        if (!videoUrl) return appendLog(adminUi.log, "Add Video: missing videoUrl.");

        const units = await ensureUnits(trackId);
        const unit = units.find((u) => String(u?.unitId || "") === unitId);
        if (!unit) return appendLog(adminUi.log, "Add Video: unit not found (refresh?).");

        const { created_at, d, ...base } = unit;
        const updated = {
          ...base,
          videos: Array.isArray(unit.videos) ? [...unit.videos] : [],
        };
        updated.videos.push({ title: videoTitle || undefined, url: videoUrl });

        const now = Math.floor(Date.now() / 1000);
        const unsignedEvent = {
          kind: KIND_UNIT,
          created_at: now,
          tags: [
            ["d", `unit:${trackId}:${unitId}`],
            ["t", "yoyostr"],
            ["t", "unit"],
            ["t", `track:${trackId}`],
            ["t", `type:${typeof updated.type === "string" ? updated.type : "other"}`],
          ],
          content: JSON.stringify(updated),
          pubkey: normalizeHexPubkey(signedInPubkey),
        };

        appendLog(adminUi.log, `Signing unit:${trackId}:${unitId} (add video)…`);
        let signedEvent;
        try {
          signedEvent = await window.nostr.signEvent(unsignedEvent);
        } catch (err) {
          appendLog(adminUi.log, `Sign failed: ${err?.message || String(err)}`);
          return;
        }

        appendLog(adminUi.log, `Publishing ${signedEvent.id} to ${RELAYS.length} relays…`);
        const results = await publishEventToRelays(RELAYS, signedEvent);
        for (const [relayUrl, result] of Object.entries(results)) {
          const okText = result?.ok ? "OK" : "FAIL";
          const msg = typeof result?.message === "string" && result.message ? ` - ${result.message}` : "";
          const timeoutText = result?.timeout ? " (timeout)" : "";
          appendLog(adminUi.log, `${relayUrl}: ${okText}${timeoutText}${msg}`);
        }

        unitsByTrackId.delete(trackId);
        await ensureUnits(trackId);
        setUnitOptions(trackId);
        setEditUnitOptions(trackId, unitId);
        await renderRoute();
        appendLog(adminUi.log, "Units refreshed.");
        closeAdminDialog();
      });
    }

    const applyAdminMode = () => {
      const showAll = !mode;
      const sections = adminUi?.sections || {};
      const rows = adminUi?.rows || {};

      if (sections.track) sections.track.hidden = !(showAll || mode === "track");
      if (sections.unitHeading) sections.unitHeading.hidden = !showAll;
      if (sections.createUnit) sections.createUnit.hidden = !(showAll || mode === "create");
      if (sections.editUnit) sections.editUnit.hidden = !(showAll || mode === "editUnit");
      if (sections.addVideo) sections.addVideo.hidden = !(showAll || mode === "addVideo");
      if (sections.log) sections.log.hidden = false;

      if (rows.trackMgmtTrackRow) rows.trackMgmtTrackRow.hidden = mode === "track";
      if (rows.trackMgmtTrackIdRow) rows.trackMgmtTrackIdRow.hidden = mode === "track";
      if (rows.trackMgmtOverwriteWrap) rows.trackMgmtOverwriteWrap.hidden = mode === "track";

      if (rows.createUnitTrackRow) rows.createUnitTrackRow.hidden = mode === "create";
      if (rows.createUnitPreviewRow) rows.createUnitPreviewRow.hidden = mode === "create";

      const isEditUnitMode = mode === "editUnit";
      if (rows.editUnitTrackRow) rows.editUnitTrackRow.hidden = isEditUnitMode;
      if (rows.editUnitUnitRow) rows.editUnitUnitRow.hidden = isEditUnitMode;
      if (rows.editUnitUnitIdRow) rows.editUnitUnitIdRow.hidden = isEditUnitMode;
      if (rows.editUnitSoftDeleteRow) rows.editUnitSoftDeleteRow.hidden = isEditUnitMode;
      if (rows.editUnitPreviewRow) rows.editUnitPreviewRow.hidden = isEditUnitMode;

      const isAddVideoMode = mode === "addVideo";
      if (rows.addVideoTrackRow) rows.addVideoTrackRow.hidden = isAddVideoMode;
      if (rows.addVideoUnitRow) rows.addVideoUnitRow.hidden = isAddVideoMode;
      if (rows.addVideoPreviewRow) rows.addVideoPreviewRow.hidden = isAddVideoMode;

      if (adminUi?.trackMgmt?.track) adminUi.trackMgmt.track.disabled = mode === "track";
      if (adminUi?.createUnit?.track) adminUi.createUnit.track.disabled = mode === "create";
      if (adminUi?.editUnit?.track) adminUi.editUnit.track.disabled = isEditUnitMode;
      if (adminUi?.editUnit?.unit) adminUi.editUnit.unit.disabled = isEditUnitMode;
      if (adminUi?.addVideo?.track) adminUi.addVideo.track.disabled = isAddVideoMode;
      if (adminUi?.addVideo?.unit) adminUi.addVideo.unit.disabled = isAddVideoMode;
    };

    applyAdminMode();

    if (mode === "create") {
      adminUi.createUnit.track.value = selectedTrackId;
      resetCreateUnitForm();
      adminUi.createUnit.track.value = selectedTrackId;
    }

    if (mode === "track") {
      adminUi.trackMgmt.track.value = selectedTrackId;
      populateTrackMgmt(selectedTrackId);
    }

    if (mode === "editUnit" && options.unitId) {
      adminUi.editUnit.track.value = selectedTrackId;
      adminUi.editUnit.unit.value = String(options.unitId || "").trim();
      await populateEditUnitForm(selectedTrackId, options.unitId);
    }

    if (mode === "addVideo") {
      adminUi.addVideo.track.value = selectedTrackId;
      if (options.unitId) adminUi.addVideo.unit.value = String(options.unitId || "").trim();
      adminUi.addVideo.videoTitle.value = "";
      adminUi.addVideo.videoUrl.value = "";
      renderAdminPreview(adminUi.addVideo.preview, "");
    }

    renderAdminPreview(adminUi.createUnit.preview, adminUi.createUnit.videoUrl.value);
    renderAdminPreview(adminUi.addVideo.preview, adminUi.addVideo.videoUrl.value);

    adminUi.dialog.showModal?.();
    if (!adminUi.dialog.open) adminUi.dialog.setAttribute("open", "open");
  }

  const overwriteAllTracksFromFallback = async () => {
    if (!adminUi) return;
    if (!window.nostr || typeof window.nostr.signEvent !== "function") {
      appendLog(adminUi.log, "Missing signer: Install/enable a Nostr signer (Alby).");
      return;
    }
    if (!signedInPubkey) {
      appendLog(adminUi.log, "Not signed in.");
      return;
    }

    adminUi.trackMgmt.overwriteBtn.disabled = true;
    appendLog(adminUi.log, "Loading fallback tracks…");

    let fallbackTracks = [];
    try {
      fallbackTracks = await loadFallbackTracks();
    } catch (err) {
      appendLog(adminUi.log, `Failed to load ./data/tracks.json: ${err?.message || String(err)}`);
      adminUi.trackMgmt.overwriteBtn.disabled = false;
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    for (const track of fallbackTracks) {
      const trackId = track?.id;
      if (trackId === undefined || trackId === null || String(trackId).trim() === "") {
        appendLog(adminUi.log, "Skipping track with missing id.");
        continue;
      }

      const unsignedEvent = {
        kind: KIND_TRACK,
        created_at: now,
        tags: [
          ["d", `track:${String(trackId)}`],
          ["t", "yoyostr"],
          ["t", "track"],
        ],
        content: JSON.stringify(track),
        pubkey: normalizeHexPubkey(signedInPubkey),
      };

      appendLog(adminUi.log, `Signing track:${String(trackId)}…`);
      let signedEvent;
      try {
        signedEvent = await window.nostr.signEvent(unsignedEvent);
      } catch (err) {
        appendLog(adminUi.log, `Sign failed for track:${String(trackId)}: ${err?.message || String(err)}`);
        continue;
      }

      appendLog(adminUi.log, `Publishing ${signedEvent.id} to ${RELAYS.length} relays…`);
      const results = await publishEventToRelays(RELAYS, signedEvent);
      for (const [relayUrl, result] of Object.entries(results)) {
        const okText = result?.ok ? "OK" : "FAIL";
        const msg = typeof result?.message === "string" && result.message ? ` - ${result.message}` : "";
        const timeoutText = result?.timeout ? " (timeout)" : "";
        appendLog(adminUi.log, `${relayUrl}: ${okText}${timeoutText}${msg}`);
      }
    }

    appendLog(adminUi.log, "Reloading from Nostr…");
    setStatus(statusEl, "Reloading tracks from Nostr…");
    const updatedTracks = await loadTracksNostrFirst();
    tracks.splice(0, tracks.length, ...updatedTracks);
    unitsByTrackId.clear();
    const updatedTrackOptions = getTrackOptions();
    const selectedTrackId = String(adminUi.trackMgmt.track.value || "") || updatedTrackOptions[0]?.value || "";
    setSelectOptions(adminUi.createUnit.track, updatedTrackOptions, selectedTrackId);
    setSelectOptions(adminUi.addVideo.track, updatedTrackOptions, selectedTrackId);
    setSelectOptions(adminUi.trackMgmt.track, updatedTrackOptions, selectedTrackId);
    setSelectOptions(adminUi.editUnit.track, updatedTrackOptions, selectedTrackId);
    setEditUnitOptions(selectedTrackId);
    populateTrackMgmt(selectedTrackId);
    await renderRoute();
    setStatus(statusEl, "Done.");
    appendLog(adminUi.log, "Done.");
    adminUi.trackMgmt.overwriteBtn.disabled = false;
  };

    if (signInBtn) signInBtn.addEventListener("click", signIn);
    if (signOutBtn) signOutBtn.addEventListener("click", signOut);
    if (adminBtn) adminBtn.addEventListener("click", () => openAdmin({}));
    window.addEventListener("hashchange", renderRoute);
  window.addEventListener("focus", () => updateAuthUi());

  updateAuthUi();
  if (!window.location.hash) window.location.hash = "#/";
  await renderRoute();
  loadTracks();
  } catch (err) {
    showVisibleError(err, { title: "Boot error", statusEl, appEl: app });
  }
}

window.addEventListener("error", (event) => {
  const err = event?.error || new Error(event?.message || "Unhandled error");
  showVisibleError(err, { title: "Unhandled error" });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event?.reason;
  const err = reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : String(reason));
  showVisibleError(err, { title: "Unhandled rejection" });
});

window.addEventListener("DOMContentLoaded", () => {
  init();
});
