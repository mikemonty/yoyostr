function normalizeInputUrl(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function cleanYouTubeId(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  if (!/^[a-zA-Z0-9_-]{6,}$/.test(v)) return null;
  return v;
}

function isYouTubeHost(host) {
  const h = typeof host === "string" ? host.toLowerCase() : "";
  return h === "youtube.com" || h === "www.youtube.com" || h === "m.youtube.com" || h === "youtu.be";
}

function getYouTubeVideoId(url) {
  const normalized = normalizeInputUrl(url);
  if (!normalized) return null;

  let u;
  try {
    u = new URL(normalized);
  } catch {
    return null;
  }

  const host = u.hostname.toLowerCase();
  if (!isYouTubeHost(host)) return null;

  const path = u.pathname || "/";
  if (host === "youtu.be") return cleanYouTubeId(path.replace(/^\//, "").split("/")[0]);
  if (path === "/watch") return cleanYouTubeId(u.searchParams.get("v"));
  if (path.startsWith("/shorts/")) return cleanYouTubeId(path.split("/")[2]);
  if (path.startsWith("/embed/")) return cleanYouTubeId(path.split("/")[2]);
  return null;
}

export function getEmbedInfo(url) {
  const normalized = normalizeInputUrl(url);
  if (!normalized) return { provider: null, embedUrl: null, thumbnailUrl: null, isEmbeddable: false };

  let u;
  try {
    u = new URL(normalized);
  } catch {
    return { provider: null, embedUrl: null, thumbnailUrl: null, isEmbeddable: false };
  }

  const host = u.hostname.toLowerCase();
  const isYouTube = isYouTubeHost(host);

  if (!isYouTube) return { provider: null, embedUrl: null, thumbnailUrl: null, isEmbeddable: false };

  const path = u.pathname || "/";

  const videoId = getYouTubeVideoId(url);
  if (videoId) {
    return {
      provider: "youtube",
      embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      isEmbeddable: true,
    };
  }

  if (path === "/playlist") {
    const list = cleanYouTubeId(u.searchParams.get("list"));
    if (!list) return { provider: "youtube", embedUrl: null, thumbnailUrl: null, isEmbeddable: false };
    return {
      provider: "youtube",
      embedUrl: `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(list)}`,
      thumbnailUrl: null,
      isEmbeddable: true,
    };
  }

  return { provider: "youtube", embedUrl: null, thumbnailUrl: null, isEmbeddable: false };
}
