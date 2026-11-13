/* ==========================================================
   Playlist Progress Tracker - cloud.js
   Optional account login (Google) and sync using Firebase.

   - If Firebase is not set up, nothing here runs and the app keeps
     working with LocalStorage only.
   - While signed in, every playlist is stored as one document:
       users/{userId}/playlists/{playlistId}
   - LocalStorage stays the first copy, so the app also works offline.

   This file must be loaded BEFORE script.js.
   ========================================================== */

"use strict";

const CLOUD_UID_KEY = "playlistTracker.cloudUid";   // which account this device last used

const cloud = {
  ready: false,        // Firebase started successfully
  auth: null,
  db: null,
  user: null,          // signed-in user, or null
  unsubscribe: null,   // stops the live listener
  firstSnapshot: true, // the first load is merged, later changes are applied
  timers: {}           // playlistId -> timer for a tick that is about to be saved
};

/* ---------- Setup ---------- */

function isCloudConfigured() {
  const c = window.FIREBASE_CONFIG;
  return typeof firebase !== "undefined" && !!c &&
    !!c.apiKey && !/PASTE/i.test(c.apiKey) &&
    !!c.projectId && !/PASTE/i.test(c.projectId);
}

function initCloud() {
  if (isCloudConfigured()) {
    try {
      firebase.initializeApp(window.FIREBASE_CONFIG);
      cloud.auth = firebase.auth();
      cloud.db = firebase.firestore();
      cloud.ready = true;
    } catch (err) {
      console.error(err);
      renderAccount();
      setCloudStatus("Cloud sync could not start: " + err.message, "error");
      return;
    }
  }
  renderAccount();
  if (cloud.ready) cloud.auth.onAuthStateChanged(onAuthChange);
}

/* ---------- Small helpers ---------- */

function setCloudStatus(message, type = "") {
  const el = $("#cloudStatus");
  el.textContent = message;
  el.className = "status" + (type ? " " + type : "");
}

function describeCloudError(err) {
  switch (err && err.code) {
    case "auth/unauthorized-domain":
      return "This website is not allowed to sign in. Add its address under Authentication, Settings, Authorized domains in Firebase.";
    case "auth/operation-not-allowed":
      return "Google sign-in is not turned on in Firebase (Authentication, Sign-in method).";
    case "auth/network-request-failed":
    case "unavailable":
      return "No connection. Your changes are saved on this device and will sync later.";
    case "permission-denied":
      return "Firestore refused the request. Check the security rules in README.md.";
    case "auth/operation-not-supported-in-this-environment":
      return "Sign-in does not work when the page is opened as a file. Open it from your website or a local server.";
    default:
      return (err && err.message) || "Something went wrong with cloud sync.";
  }
}

function cloudError(err) {
  console.error(err);
  setCloudStatus(describeCloudError(err), "error");
}

function playlistsCollection() {
  return cloud.db.collection("users").doc(cloud.user.uid).collection("playlists");
}

function docRef(playlistId) {
  return playlistsCollection().doc(playlistId);
}

function renderAccount() {
  const configured = isCloudConfigured();
  const notConfigured = $("#cloudNotConfigured");

  if (typeof firebase === "undefined") {
    notConfigured.textContent = "Cloud sync could not load. Check your internet connection and refresh the page.";
  } else {
    notConfigured.textContent = "Cloud sync is not set up. To turn it on, paste your Firebase settings into firebase-config.js (see README.md).";
  }
  notConfigured.hidden = configured;

  $("#cloudSignedOut").hidden = !(cloud.ready && !cloud.user);
  $("#cloudSignedIn").hidden = !(cloud.ready && cloud.user);
  if (cloud.user) {
    $("#cloudUser").textContent = cloud.user.displayName || cloud.user.email || "your account";
  }
}

/* ---------- Converting playlists to and from the cloud format ---------- */

/*
  In the cloud the list of videos is stored once and the completed videos are
  a separate list of IDs ("done"). Ticking a video then only has to update "done".
*/
function toCloud(p) {
  return {
    id: p.id,
    title: p.title,
    channel: p.channel,
    thumbnail: p.thumbnail || "",
    videos: p.videos.map(v => ({
      id: v.id,
      title: v.title,
      thumbnail: v.thumbnail || "",
      duration: typeof v.duration === "number" ? v.duration : null
    })),
    done: p.videos.filter(v => v.completed).map(v => v.id),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
}

function fromCloud(data) {
  if (!data || !Array.isArray(data.videos)) return null;
  const done = new Set(Array.isArray(data.done) ? data.done : []);
  return cleanPlaylist({
    id: data.id,
    title: data.title,
    channel: data.channel,
    thumbnail: data.thumbnail,
    videos: data.videos.map(v => ({ ...v, completed: !!v && done.has(v.id) }))
  });
}

/* ---------- Sign in / sign out ---------- */

async function signInWithGoogle() {
  if (!cloud.ready) return;
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await cloud.auth.signInWithPopup(provider);
  } catch (err) {
    if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return;
    if (err.code === "auth/popup-blocked") {
      try { await cloud.auth.signInWithRedirect(provider); return; } catch (e) { err = e; }
    }
    toast(describeCloudError(err), "error");
  }
}

async function signOutCloud(clearThisDevice) {
  if (!cloud.user) return;
  await cloudFlush();                       // save any tick that is still waiting
  try {
    await cloud.auth.signOut();
  } catch (err) {
    toast(describeCloudError(err), "error");
    return;
  }
  if (clearThisDevice) {
    state.playlists = [];
    state.activeId = null;
    saveData();
    renderAll();
    showView("settings");
  }
  toast(clearThisDevice ? "Signed out. Playlists removed from this device." : "Signed out.");
}

function onAuthChange(user) {
  stopListening();
  cloud.user = user;

  if (user) {
    // Playlists left on this device by a different account must not be mixed into this one.
    const lastUid = localStorage.getItem(CLOUD_UID_KEY);
    if (lastUid && lastUid !== user.uid && state.playlists.length) {
      const remove = confirm(
        "This device still has playlists from a different account.\n\n" +
        "OK: remove them from this device\nCancel: add them to this account"
      );
      if (remove) {
        state.playlists = [];
        state.activeId = null;
        saveData();
        renderAll();
        if (state.view === "detail") showView("playlists");
      }
    }
    localStorage.setItem(CLOUD_UID_KEY, user.uid);
  }

  renderAccount();
  if (user) startListening(); else setCloudStatus("");
}

/* ---------- Live sync: cloud -> this device ---------- */

function startListening() {
  cloud.firstSnapshot = true;
  setCloudStatus("Syncing...");
  cloud.unsubscribe = playlistsCollection().onSnapshot(
    snapshot => {
      try {
        if (cloud.firstSnapshot) {
          cloud.firstSnapshot = false;
          handleFirstSnapshot(snapshot);
        } else {
          handleChanges(snapshot);
        }
        setCloudStatus("Synced with your account.", "ok");
      } catch (err) {
        cloudError(err);
      }
    },
    cloudError
  );
}

function stopListening() {
  if (cloud.unsubscribe) cloud.unsubscribe();
  cloud.unsubscribe = null;
  Object.keys(cloud.timers).forEach(id => clearTimeout(cloud.timers[id]));
  cloud.timers = {};
}

/*
  First load after signing in: combine this device with the account.
  - playlists only in the cloud are added here
  - playlists only on this device are uploaded
  - for playlists in both, a video is completed if it is completed on either side
*/
function mergeCloudIntoLocal(cloudList) {
  const cloudIds = new Set(cloudList.map(p => p.id));
  const needsProgressUpload = [];

  cloudList.forEach(cp => {
    const index = state.playlists.findIndex(p => p.id === cp.id);
    if (index === -1) {
      state.playlists.push(cp);
      return;
    }
    const localDone = new Set(state.playlists[index].videos.filter(v => v.completed).map(v => v.id));
    let changed = false;
    cp.videos.forEach(v => {
      if (!v.completed && localDone.has(v.id)) { v.completed = true; changed = true; }
    });
    state.playlists[index] = cp;
    if (changed) needsProgressUpload.push(cp);
  });

  const needsFullUpload = state.playlists.filter(p => !cloudIds.has(p.id));
  return { needsFullUpload, needsProgressUpload };
}

function handleFirstSnapshot(snapshot) {
  const cloudList = snapshot.docs.map(d => fromCloud(d.data())).filter(Boolean);
  const result = mergeCloudIntoLocal(cloudList);

  saveData();
  renderAll();
  if (state.view === "detail" && !getPlaylist(state.activeId)) showView("playlists");

  result.needsFullUpload.forEach(p => cloudSavePlaylist(p));
  result.needsProgressUpload.forEach(p => cloudQueueProgress(p));
}

// Later changes (made on another device) are applied to this device.
function handleChanges(snapshot) {
  let changed = false;

  snapshot.docChanges().forEach(change => {
    if (change.doc.metadata.hasPendingWrites) return;   // our own change, already applied

    if (change.type === "removed") {
      const id = change.doc.id;
      if (getPlaylist(id)) {
        state.playlists = state.playlists.filter(p => p.id !== id);
        if (state.activeId === id) state.activeId = null;
        changed = true;
      }
      return;
    }

    const incoming = fromCloud(change.doc.data());
    if (!incoming) return;
    if (cloud.timers[incoming.id]) return;   // we have a tick that is not saved yet; ours wins

    const index = state.playlists.findIndex(p => p.id === incoming.id);
    if (index === -1) state.playlists.push(incoming);
    else state.playlists[index] = incoming;
    changed = true;
  });

  if (changed) {
    saveData();
    renderAll();
    if (state.view === "detail" && !getPlaylist(state.activeId)) showView("playlists");
  }
}

/* ---------- Saving: this device -> cloud ---------- */
/* All of these do nothing when nobody is signed in. */

function cloudSavePlaylist(p) {
  if (!cloud.user) return;
  clearTimeout(cloud.timers[p.id]);
  delete cloud.timers[p.id];

  // A Firestore document can hold about 1 MB.
  if (JSON.stringify(p.videos).length > 900000) {
    setCloudStatus("\"" + p.title + "\" is too large to sync to your account.", "error");
    return;
  }

  setCloudStatus("Saving...");
  return docRef(p.id).set(toCloud(p))
    .then(() => setCloudStatus("Synced with your account.", "ok"))
    .catch(cloudError);
}

function cloudSaveAll() {
  state.playlists.forEach(p => cloudSavePlaylist(p));
}

// Ticks are saved a moment after the last click, so fast ticking sends one update.
function cloudQueueProgress(p) {
  if (!cloud.user) return;
  clearTimeout(cloud.timers[p.id]);
  setCloudStatus("Saving...");
  cloud.timers[p.id] = setTimeout(() => {
    delete cloud.timers[p.id];
    cloudWriteProgress(p.id);
  }, 800);
}

function cloudWriteProgress(playlistId) {
  const p = getPlaylist(playlistId);
  if (!p || !cloud.user) return Promise.resolve();

  const done = p.videos.filter(v => v.completed).map(v => v.id);
  return docRef(playlistId)
    .update({ done, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
    .catch(err => {
      if (err && err.code === "not-found") return docRef(playlistId).set(toCloud(p));   // doc is missing: create it
      throw err;
    })
    .then(() => setCloudStatus("Synced with your account.", "ok"))
    .catch(cloudError);
}

// Send every waiting tick right now (used before signing out).
function cloudFlush() {
  const ids = Object.keys(cloud.timers);
  ids.forEach(id => { clearTimeout(cloud.timers[id]); delete cloud.timers[id]; });
  return Promise.all(ids.map(cloudWriteProgress));
}

function cloudDeletePlaylist(id) {
  if (!cloud.user) return;
  clearTimeout(cloud.timers[id]);
  delete cloud.timers[id];
  docRef(id).delete().catch(cloudError);
}

function cloudDeleteAll(ids) {
  if (!cloud.user || !ids.length) return;
  ids.forEach(id => { clearTimeout(cloud.timers[id]); delete cloud.timers[id]; });
  const batch = cloud.db.batch();
  ids.forEach(id => batch.delete(docRef(id)));
  batch.commit().catch(cloudError);
}
