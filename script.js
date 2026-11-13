/* ==========================================================
   Playlist Progress Tracker - script.js
   Vanilla JavaScript. No frameworks.

   Sections:
   1. Constants and app state
   2. Small helpers
   3. LocalStorage (save / load)
   4. Progress calculations
   5. YouTube API (fetch playlist, videos, durations)
   6. Rendering (dashboard, playlists, detail view)
   7. Actions (import, remove, toggle, sync...)
   8. Event listeners and start-up
   ========================================================== */

"use strict";

/* ---------- 1. Constants and app state ---------- */

const DATA_KEY    = "playlistTracker.data.v1";   // playlists + progress
const API_KEY_KEY = "playlistTracker.apiKey";    // user's own API key
const API_BASE    = "https://www.googleapis.com/youtube/v3";
const PLACEHOLDER = "assets/placeholder.svg";

const state = {
  playlists: [],       // [{ id, title, channel, thumbnail, videos: [...] }]
  apiKey: "",
  view: "dashboard",   // dashboard | playlists | detail | settings
  activeId: null,      // playlist shown in the detail view
  filter: "all",       // all | completed | pending
  search: "",
  busy: false          // true while talking to the YouTube API
};

let listTimer = null;  // used to refresh the video list shortly after a tick

/*
  A video looks like:
  { id: "abc123", title: "...", thumbnail: "https://...", duration: 754, completed: false }
  duration is in seconds (or null if YouTube did not provide it).
*/

/* ---------- 2. Small helpers ---------- */

const $  = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

// Escape text before putting it into innerHTML (prevents broken markup / XSS).
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 754 -> "12:34", 3725 -> "1:02:05"
function formatDuration(seconds) {
  if (seconds == null) return "Duration unavailable";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
}

// 12500 -> "3h 28m"
function formatTotalTime(seconds) {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return m + "m";
  return h + "h " + m + "m";
}

// YouTube sends durations like "PT1H2M5S". Convert to seconds.
function parseIsoDuration(iso) {
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!match) return null;
  const [, d, h, m, s] = match.map(Number);
  return (d || 0) * 86400 + (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

function toast(message, type = "ok") {
  const el = document.createElement("div");
  el.className = "toast" + (type === "error" ? " error" : "");
  el.textContent = message;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function setStatus(message, type = "") {
  const el = $("#importStatus");
  el.textContent = message;
  el.className = "status" + (type ? " " + type : "");
}

function getPlaylist(id) {
  return state.playlists.find(p => p.id === id);
}

/* ---------- 3. LocalStorage ---------- */

function saveData() {
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(state.playlists));
  } catch (err) {
    toast("Could not save your progress. Browser storage may be full or disabled.", "error");
  }
}

function loadData() {
  try {
    const saved = JSON.parse(localStorage.getItem(DATA_KEY) || "[]");
    // Basic sanity check so corrupted data cannot break the app.
    state.playlists = Array.isArray(saved)
      ? saved.filter(p => p && p.id && Array.isArray(p.videos))
      : [];
  } catch (err) {
    state.playlists = [];
  }
  state.apiKey = localStorage.getItem(API_KEY_KEY) || "";
}

/* ---------- 4. Progress calculations ---------- */

/*
  Progress is based on TIME, not on the number of videos:

  Progress Percentage = (Total length of completed videos / Total length of all videos) x 100

  A 60 minute video therefore counts more than a 5 minute video.
  If YouTube gave no duration for any video (total length is 0), we fall back to counting videos.
*/
function getStats(videos) {
  const total = videos.length;
  const done = videos.filter(v => v.completed).length;

  const totalSeconds = videos.reduce((sum, v) => sum + (v.duration || 0), 0);
  const doneSeconds = videos.filter(v => v.completed).reduce((sum, v) => sum + (v.duration || 0), 0);

  let percent = 0;
  if (totalSeconds > 0) percent = (doneSeconds / totalSeconds) * 100;
  else if (total > 0) percent = (done / total) * 100;

  return {
    total, done, pending: total - done,
    totalSeconds, doneSeconds, leftSeconds: totalSeconds - doneSeconds,
    percent
  };
}

// Shows progress with decimals so small steps are visible even in long playlists.
// Never shows 100% until every video is completed.
function formatPercent(stats) {
  const p = stats.percent;
  if (p <= 0) return "0%";

  const decimals = stats.total >= 1000 ? 2 : 1;
  const step = Math.pow(10, decimals);
  const almostDone = (100 - 1 / step).toFixed(decimals) + "%";   // e.g. 99.9%

  if (p >= 100) return stats.pending === 0 ? "100%" : almostDone;

  let rounded = Math.round(p * step) / step;
  if (rounded >= 100) return almostDone;      // 99.96 must not look like 100
  if (rounded <= 0) rounded = 1 / step;       // some progress must not look like 0
  return rounded.toFixed(decimals) + "%";
}

function getOverallStats() {
  const all = state.playlists.flatMap(p => p.videos);
  return { ...getStats(all), playlists: state.playlists.length };
}

/* ---------- 5. YouTube API ---------- */

// Pull the playlist ID out of whatever the user pasted.
// Returns null if it does not look like a playlist link.
function extractPlaylistId(input) {
  const text = input.trim();
  if (!text) return null;

  // Allow a bare playlist ID, e.g. PLxxxxxxxxxxxx
  if (/^(PL|UU|OL|FL)[\w-]{10,}$/.test(text)) return text;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : "https://" + text);
  } catch (err) {
    return null;
  }

  const host = url.hostname.replace(/^www\.|^m\./, "");
  if (host !== "youtube.com" && host !== "youtu.be" && host !== "music.youtube.com") return null;

  const id = url.searchParams.get("list");
  return id && /^[\w-]{10,}$/.test(id) ? id : null;
}

// Turn API failures into messages a person can act on.
function describeApiError(status, data) {
  const reason = data?.error?.errors?.[0]?.reason || "";
  const message = data?.error?.message || "";

  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded" || reason === "rateLimitExceeded") {
    return "The YouTube API daily quota is used up. Try again tomorrow, or use a key from another project.";
  }
  if (reason === "keyInvalid" || /API key not valid/i.test(message)) {
    return "Your API key is not valid. Check it in Settings.";
  }
  if (reason === "accessNotConfigured" || (reason === "forbidden" && /not been used|disabled/i.test(message))) {
    return "YouTube Data API v3 is not enabled for this key. Enable it in Google Cloud Console.";
  }
  if (reason === "ipRefererBlocked" || reason === "referrerNotAllowed") {
    return "This API key is restricted and does not allow requests from this website.";
  }
  if (reason === "playlistNotFound" || status === 404) {
    return "Playlist not found. It may be private or deleted.";
  }
  if (reason === "playlistItemsNotAccessible" || reason === "playlistForbidden") {
    return "This playlist is private. Only public and unlisted playlists can be imported.";
  }
  return "YouTube API error (" + status + "). " + (message || "Please try again.");
}

// One place for every API request.
async function apiGet(endpoint, params) {
  const query = new URLSearchParams({ ...params, key: state.apiKey });
  let response;
  try {
    response = await fetch(API_BASE + "/" + endpoint + "?" + query.toString());
  } catch (err) {
    throw new Error("Network error. Check your internet connection and try again.");
  }

  let data = null;
  try { data = await response.json(); } catch (err) { /* ignore */ }

  if (!response.ok) throw new Error(describeApiError(response.status, data));
  return data;
}

// Download every page of playlist items (50 per page).
async function fetchPlaylistItems(playlistId, onProgress) {
  const items = [];
  let pageToken = "";

  do {
    const data = await apiGet("playlistItems", {
      part: "snippet,contentDetails",
      playlistId,
      maxResults: 50,
      pageToken
    });
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || "";
    if (onProgress) onProgress(items.length);
  } while (pageToken);

  return items;
}

// Ask for durations, 50 video IDs at a time.
// Videos that are private or deleted are not returned, so they get skipped.
async function fetchVideoDetails(videoIds) {
  const details = {};
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const data = await apiGet("videos", { part: "contentDetails,snippet", id: chunk.join(",") });
    (data.items || []).forEach(item => {
      details[item.id] = {
        duration: parseIsoDuration(item.contentDetails?.duration),
        title: item.snippet?.title,
        thumbnail: pickThumbnail(item.snippet?.thumbnails)
      };
    });
  }
  return details;
}

function pickThumbnail(thumbs) {
  if (!thumbs) return "";
  return (thumbs.medium || thumbs.high || thumbs.default || {}).url || "";
}

/*
  Builds a complete playlist object from YouTube.
  `previous` (optional) is an existing playlist; it lets "Sync" keep completion status.
*/
async function buildPlaylist(playlistId, previous, onProgress) {
  // 1) Playlist details (title, channel, thumbnail)
  const info = await apiGet("playlists", { part: "snippet,contentDetails", id: playlistId });
  if (!info.items || info.items.length === 0) {
    throw new Error("Playlist not found. It may be private or deleted.");
  }
  const meta = info.items[0].snippet;

  // 2) All playlist items (handles pagination)
  const items = await fetchPlaylistItems(playlistId, onProgress);

  // 3) Unique video IDs, in playlist order
  const ids = [];
  items.forEach(item => {
    const vid = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
    if (vid && !ids.includes(vid)) ids.push(vid);
  });

  // 4) Durations and details (this also drops private / deleted videos)
  const details = await fetchVideoDetails(ids);

  const doneBefore = new Set((previous?.videos || []).filter(v => v.completed).map(v => v.id));

  const videos = ids
    .filter(vid => details[vid])
    .map(vid => ({
      id: vid,
      title: details[vid].title || "Untitled video",
      thumbnail: details[vid].thumbnail,
      duration: details[vid].duration,
      completed: doneBefore.has(vid)
    }));

  if (videos.length === 0) {
    throw new Error("This playlist has no available videos. It may be empty, or all videos are private or deleted.");
  }

  return {
    id: playlistId,
    title: meta.title || "Untitled playlist",
    channel: meta.channelTitle || "Unknown channel",
    thumbnail: pickThumbnail(meta.thumbnails) || videos[0].thumbnail,
    videos
  };
}

/* ---------- 6. Rendering ---------- */

function progressBarHTML(stats) {
  return '<div class="bar"><div class="bar-fill" style="width:' + stats.percent.toFixed(2) + '%"></div></div>';
}

function playlistCardHTML(p) {
  const s = getStats(p.videos);
  return (
    '<article class="card playlist-card">' +
      '<img class="pc-thumb" src="' + esc(p.thumbnail || PLACEHOLDER) + '" alt="" loading="lazy">' +
      '<div class="pc-body">' +
        '<h3>' + esc(p.title) + '</h3>' +
        '<p class="muted tiny">' + esc(p.channel) + ', ' + s.total + ' videos</p>' +
        progressBarHTML(s) +
        '<div class="pc-percent"><span>' + formatPercent(s) + ' complete</span>' +
        '<span>' + s.done + ' / ' + s.total + '</span></div>' +
        '<div class="pc-actions">' +
          '<button class="btn btn-primary" data-action="open" data-id="' + esc(p.id) + '">Open</button>' +
          '<button class="btn btn-ghost" data-action="remove" data-id="' + esc(p.id) + '">Remove</button>' +
        '</div>' +
      '</div>' +
    '</article>'
  );
}

function dashboardRowHTML(p) {
  const s = getStats(p.videos);
  return (
    '<article class="card dash-row">' +
      '<img class="dr-thumb" src="' + esc(p.thumbnail || PLACEHOLDER) + '" alt="" loading="lazy">' +
      '<div class="dr-main">' +
        '<h3>' + esc(p.title) + '</h3>' +
        '<p class="muted tiny">' + esc(p.channel) + '</p>' +
        '<div class="dr-progress">' +
          '<span class="dr-percent">' + formatPercent(s) + '</span>' +
          '<span class="muted">' + formatTotalTime(s.doneSeconds) + ' of ' + formatTotalTime(s.totalSeconds) +
            ' watched (' + s.done + ' of ' + s.total + ' videos)</span>' +
        '</div>' +
        progressBarHTML(s) +
      '</div>' +
      '<button class="btn btn-primary" data-action="open" data-id="' + esc(p.id) + '">Open</button>' +
    '</article>'
  );
}

const EMPTY_HTML =
  '<div class="empty">No playlists yet. Paste a public YouTube playlist link above and choose Import playlist.</div>';

function renderPlaylistLists() {
  // Dashboard: one progress row per playlist. My Playlists page: cards.
  $("#dashboardPlaylists").innerHTML = state.playlists.length
    ? state.playlists.map(dashboardRowHTML).join("")
    : EMPTY_HTML;
  $("#playlistGrid").innerHTML = state.playlists.length
    ? state.playlists.map(playlistCardHTML).join("")
    : EMPTY_HTML;
  $("#playlistBadge").textContent = state.playlists.length;
}

function renderDashboard() {
  const o = getOverallStats();
  $("#overallPercent").textContent = formatPercent(o);
  $("#overallCounts").textContent =
    formatTotalTime(o.doneSeconds) + " of " + formatTotalTime(o.totalSeconds) +
    " watched (" + o.done + " of " + o.total + " videos)";
  $("#overallBar").style.width = o.percent.toFixed(2) + "%";
  $("#statPlaylists").textContent = o.playlists;
  $("#statTotal").textContent = o.total;
  $("#statDone").textContent = o.done;
  $("#statLeft").textContent = o.pending;
}

// Top part of the detail view (title, progress). Does not touch the video list.
function renderDetailHeader() {
  const p = getPlaylist(state.activeId);
  if (!p) return;
  const s = getStats(p.videos);

  $("#detailThumb").src = p.thumbnail || PLACEHOLDER;
  $("#detailTitle").textContent = p.title;
  $("#detailMeta").textContent = p.channel + ", " + s.total + " videos";
  $("#detailPercent").textContent = formatPercent(s);
  $("#detailCounts").textContent = s.done + " completed, " + s.pending + " remaining";
  $("#detailBar").style.width = s.percent.toFixed(2) + "%";
  $("#detailTime").textContent =
    "Watched " + formatTotalTime(s.doneSeconds) + " of " + formatTotalTime(s.totalSeconds) +
    ". About " + formatTotalTime(s.leftSeconds) + " left to watch.";
}

function videoRowHTML(v, number, playlistId) {
  const link = "https://www.youtube.com/watch?v=" + encodeURIComponent(v.id) +
               "&list=" + encodeURIComponent(playlistId);
  return (
    '<li class="video' + (v.completed ? " done" : "") + '" data-video-id="' + esc(v.id) + '">' +
      '<label class="check">' +
        '<input type="checkbox" data-action="toggle" data-id="' + esc(v.id) + '"' + (v.completed ? " checked" : "") +
        ' aria-label="Mark &quot;' + esc(v.title) + '&quot; as completed">' +
        '<span class="box"></span>' +
      '</label>' +
      '<img class="v-thumb" src="' + esc(v.thumbnail || PLACEHOLDER) + '" alt="" loading="lazy">' +
      '<div class="v-info">' +
        '<div class="v-title">' + esc(v.title) + '</div>' +
        '<div class="v-meta">Video ' + number + ', ' + esc(formatDuration(v.duration)) + '</div>' +
      '</div>' +
      '<a class="btn btn-ghost" href="' + link + '" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>' +
    '</li>'
  );
}

// The list of videos, after applying the search box and the filter buttons.
function renderVideoList() {
  const p = getPlaylist(state.activeId);
  if (!p) return;

  const term = state.search.trim().toLowerCase();
  const rows = [];

  p.videos.forEach((v, index) => {
    if (state.filter === "completed" && !v.completed) return;
    if (state.filter === "pending" && v.completed) return;
    if (term && !v.title.toLowerCase().includes(term)) return;
    rows.push(videoRowHTML(v, index + 1, p.id));   // keep the real position in the playlist
  });

  $("#videoList").innerHTML = rows.join("");
  $("#videoEmpty").hidden = rows.length > 0;

  const total = p.videos.length;
  $("#videoCount").textContent = (state.filter === "all" && !term)
    ? total + " videos"
    : "Showing " + rows.length + " of " + total + " videos";
}

function renderAll() {
  renderPlaylistLists();
  renderDashboard();
  if (state.activeId && getPlaylist(state.activeId)) {
    renderDetailHeader();
    renderVideoList();
  }
}

function showView(name) {
  state.view = name;
  $$(".view").forEach(el => { el.hidden = el.id !== "view-" + name; });

  // The detail page belongs to "My Playlists" in the sidebar.
  const navName = name === "detail" ? "playlists" : name;
  $$(".nav-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.view === navName));
  window.scrollTo({ top: 0 });
}

function openPlaylist(id) {
  if (!getPlaylist(id)) return;
  state.activeId = id;
  state.filter = "all";
  state.search = "";
  $("#searchInput").value = "";
  $$(".segmented button").forEach(b => b.classList.toggle("active", b.dataset.filter === "all"));
  renderDetailHeader();
  renderVideoList();
  showView("detail");
}

/* ---------- 7. Actions ---------- */

function setBusy(isBusy) {
  state.busy = isBusy;
  $("#importBtn").disabled = isBusy;
  $("#importBtn").textContent = isBusy ? "Importing..." : "Import playlist";
  $("#syncBtn").disabled = isBusy;
}

async function importPlaylist(rawInput) {
  if (state.busy) return;

  // Validate everything we can before calling the API.
  if (!rawInput.trim()) {
    setStatus("Paste a YouTube playlist link first.", "error");
    return;
  }
  const playlistId = extractPlaylistId(rawInput);
  if (!playlistId) {
    setStatus("That does not look like a YouTube playlist link. It should contain \"list=\" followed by the playlist ID.", "error");
    return;
  }
  if (getPlaylist(playlistId)) {
    setStatus("This playlist is already imported.", "error");
    return;
  }
  if (!state.apiKey) {
    setStatus("Add your YouTube API key in Settings before importing.", "error");
    return;
  }

  setBusy(true);
  setStatus("Fetching playlist...");
  try {
    const playlist = await buildPlaylist(playlistId, null, count => setStatus("Fetched " + count + " videos..."));
    state.playlists.push(playlist);
    saveData();
    renderAll();
    $("#playlistUrl").value = "";
    setStatus("Imported \"" + playlist.title + "\" with " + playlist.videos.length + " videos.", "ok");
    openPlaylist(playlist.id);
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    setBusy(false);
  }
}

async function syncActivePlaylist() {
  const current = getPlaylist(state.activeId);
  if (!current || state.busy) return;
  if (!state.apiKey) { toast("Add your API key in Settings first.", "error"); return; }

  setBusy(true);
  $("#syncBtn").textContent = "Syncing...";
  try {
    const fresh = await buildPlaylist(current.id, current);   // keeps completed videos
    const index = state.playlists.findIndex(p => p.id === current.id);
    state.playlists[index] = fresh;
    saveData();
    renderAll();
    toast("Playlist updated. Your progress was kept.");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    $("#syncBtn").textContent = "Sync from YouTube";
    setBusy(false);
  }
}

function removePlaylist(id) {
  const p = getPlaylist(id);
  if (!p) return;
  if (!confirm("Remove \"" + p.title + "\" and its saved progress?")) return;

  state.playlists = state.playlists.filter(item => item.id !== id);
  if (state.activeId === id) state.activeId = null;
  saveData();
  renderAll();
  if (state.view === "detail") showView("playlists");
  toast("Playlist removed.");
}

// Called when a checkbox changes. Updates every progress display instantly.
function toggleVideo(videoId, checked) {
  const p = getPlaylist(state.activeId);
  const video = p && p.videos.find(v => v.id === videoId);
  if (!video) return;

  video.completed = checked;
  saveData();

  renderDetailHeader();
  renderDashboard();
  renderPlaylistLists();

  // Restyle the row right away, in every case.
  const row = $('.video[data-video-id="' + CSS.escape(videoId) + '"]');
  if (row) row.classList.toggle("done", checked);

  // In the Completed / Pending filters the video no longer belongs in the list after a tick.
  // Wait a moment before refreshing so the list does not jump while you are ticking.
  if (state.filter !== "all") {
    clearTimeout(listTimer);
    listTimer = setTimeout(renderVideoList, 900);
  }
}

function resetProgress() {
  const p = getPlaylist(state.activeId);
  if (!p) return;
  if (!p.videos.some(v => v.completed)) { toast("Nothing to reset."); return; }
  if (!confirm("Mark every video in this playlist as not completed?")) return;

  p.videos.forEach(v => { v.completed = false; });
  saveData();
  renderAll();
  toast("Progress reset.");
}

function saveApiKey() {
  const key = $("#apiKeyInput").value.trim();
  if (!key) { toast("Paste an API key first.", "error"); return; }
  state.apiKey = key;
  localStorage.setItem(API_KEY_KEY, key);
  toast("API key saved in this browser.");
}

function clearApiKey() {
  state.apiKey = "";
  localStorage.removeItem(API_KEY_KEY);
  $("#apiKeyInput").value = "";
  toast("API key removed.");
}

function clearAllData() {
  if (!state.playlists.length) { toast("There are no playlists to remove."); return; }
  if (!confirm("Remove all playlists and progress? This cannot be undone.")) return;
  state.playlists = [];
  state.activeId = null;
  saveData();
  renderAll();
  toast("All playlists removed.");
}

/* ---------- Backup: export / import (move progress between devices) ---------- */

// Keep only the fields we expect, so a bad file cannot break the app.
function cleanPlaylist(p) {
  if (!p || typeof p.id !== "string" || !Array.isArray(p.videos)) return null;
  const videos = p.videos
    .filter(v => v && typeof v.id === "string")
    .map(v => ({
      id: v.id,
      title: String(v.title || "Untitled video"),
      thumbnail: typeof v.thumbnail === "string" ? v.thumbnail : "",
      duration: typeof v.duration === "number" ? v.duration : null,
      completed: v.completed === true
    }));
  if (videos.length === 0) return null;
  return {
    id: p.id,
    title: String(p.title || "Untitled playlist"),
    channel: String(p.channel || "Unknown channel"),
    thumbnail: typeof p.thumbnail === "string" ? p.thumbnail : "",
    videos
  };
}

// New playlists are added. For playlists you already have, completed videos are combined.
function mergeBackup(data) {
  if (!data || !Array.isArray(data.playlists)) {
    throw new Error("This file is not a Playlist Tracker backup.");
  }
  let added = 0, merged = 0;
  data.playlists.map(cleanPlaylist).filter(Boolean).forEach(incoming => {
    const existing = getPlaylist(incoming.id);
    if (!existing) {
      state.playlists.push(incoming);
      added++;
      return;
    }
    const doneIds = new Set(incoming.videos.filter(v => v.completed).map(v => v.id));
    existing.videos.forEach(v => { if (doneIds.has(v.id)) v.completed = true; });
    merged++;
  });
  return { added, merged };
}

function exportBackup() {
  if (!state.playlists.length) { toast("There is nothing to export yet.", "error"); return; }
  const data = {
    app: "playlist-progress-tracker",
    version: 1,
    exportedAt: new Date().toISOString(),
    playlists: state.playlists
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "playlist-progress-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast("Backup file downloaded.");
}

async function importBackupFile(file) {
  if (!file) return;
  try {
    const result = mergeBackup(JSON.parse(await file.text()));
    saveData();
    renderAll();
    toast("Backup imported: " + result.added + " new, " + result.merged + " updated.");
  } catch (err) {
    toast(err instanceof SyntaxError ? "That file could not be read." : err.message, "error");
  }
}

/* ---------- 8. Event listeners and start-up ---------- */

// One click listener handles every button that has a data-action attribute.
document.addEventListener("click", event => {
  const el = event.target.closest("[data-action]");
  if (!el || el.tagName === "INPUT") return;

  switch (el.dataset.action) {
    case "nav":        showView(el.dataset.view); break;
    case "open":       openPlaylist(el.dataset.id); break;
    case "remove":     removePlaylist(el.dataset.id); break;
    case "back":       showView("playlists"); break;
    case "sync":       syncActivePlaylist(); break;
    case "reset":      resetProgress(); break;
    case "save-key":   saveApiKey(); break;
    case "clear-key":  clearApiKey(); break;
    case "clear-data": clearAllData(); break;
    case "export-backup": exportBackup(); break;
    case "import-backup": $("#importFile").click(); break;
    case "toggle-key": {
      const input = $("#apiKeyInput");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      el.textContent = show ? "Hide" : "Show";
      break;
    }
    case "filter":
      state.filter = el.dataset.filter;
      $$(".segmented button").forEach(b => b.classList.toggle("active", b === el));
      renderVideoList();
      break;
  }
});

// Checkbox changes (marking videos completed / incomplete).
document.addEventListener("change", event => {
  const box = event.target;
  if (box.matches('input[data-action="toggle"]')) toggleVideo(box.dataset.id, box.checked);
});

$("#importFile").addEventListener("change", async event => {
  await importBackupFile(event.target.files[0]);
  event.target.value = "";   // allows choosing the same file again
});

$("#searchInput").addEventListener("input", event => {
  state.search = event.target.value;
  renderVideoList();
});

$("#importForm").addEventListener("submit", event => {
  event.preventDefault();
  importPlaylist($("#playlistUrl").value);
});

// Start the app.
function init() {
  loadData();
  // Ask the browser not to clear our saved data when storage is low (ignored if unsupported).
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  $("#apiKeyInput").value = state.apiKey;
  renderAll();
  showView("dashboard");

  if (!state.apiKey) {
    setStatus("Add your YouTube API key in Settings to import playlists.");
  }
}

init();
