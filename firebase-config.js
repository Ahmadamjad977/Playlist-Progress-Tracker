/* ==========================================================
   Firebase settings for optional account login and sync.

   1. Open the Firebase console, then Project settings, then "Your apps" (Web app).
   2. Copy the values from the config shown there into the fields below.
   3. Leave the PASTE_... text as it is if you do not want cloud sync.
      The app then works exactly as before, using this browser only.

   These values only identify your Firebase project. They are not passwords.
   Your data is protected by the Firestore security rules and by the
   "Authorized domains" list in Firebase Authentication (see README.md).
   ========================================================== */

window.FIREBASE_CONFIG = {
  apiKey: "PASTE_YOUR_FIREBASE_API_KEY",
  authDomain: "PASTE_YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_YOUR_PROJECT_ID",
  appId: "PASTE_YOUR_APP_ID"
};
