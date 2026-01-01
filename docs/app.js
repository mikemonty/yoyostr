import { fetchTracksFromRelays } from "./nostr.js";

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

    const links = el("div", { class: "track-links" });
    for (const p of playlists) {
      if (!p || typeof p.url !== "string") continue;
      const label = typeof p.label === "string" ? p.label : p.url;
      links.append(
        el("a", { href: p.url, target: "_blank", rel: "noreferrer", text: label })
      );
    }

    const card = el("article", { class: "track-card" }, [
      el("h3", { text: title }),
      el("p", { text: description }),
      links,
    ]);
    container.append(card);
  }
}

async function init() {
  const adminBtn = document.getElementById("adminBtn");
  if (adminBtn) adminBtn.hidden = true;

  const container = document.getElementById("tracks");
  if (!container) return;
  container.textContent = "Loading…";

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

  renderTracks(container, tracks);
}

init();

