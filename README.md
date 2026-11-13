# Playlist Progress Tracker

A simple dashboard for tracking your progress through YouTube playlists. Paste a public playlist link, import every video, and tick videos off as you finish them. Built with plain HTML, CSS and JavaScript. No frameworks.

## Features

- Import any public (or unlisted) YouTube playlist using the YouTube Data API v3
- Shows playlist title, thumbnail, total videos, and each video's thumbnail, title and duration
- Fetches all videos, including playlists with more than 50 videos
- Tick and untick videos manually; progress updates instantly
- Progress percentage, progress bar and completed / total count for each playlist
- Overall progress across all playlists
- Search videos and filter by All, Completed or Pending
- Saves everything in your browser (LocalStorage), so progress survives a refresh or restart
- Multiple playlists, each with its own progress; duplicate imports are blocked
- Sync a playlist with YouTube to pick up new videos without losing progress
- Responsive dark theme for desktop, tablet and mobile

> Watching a video on YouTube does **not** update this app. You mark videos as completed yourself.

## Project structure

```
Playlist-Progress-Tracker/
  index.html
  style.css
  script.js
  assets/
    favicon.svg
    placeholder.svg
  README.md
```

## How to run

No installation or build step is needed.

1. Download or clone this project.
2. Open `index.html` in a browser (double-click it).
3. Add your API key (see the next section).
4. Paste a playlist link in the top bar and click **Import playlist**.

## Getting a YouTube API key

The app needs your own free API key. It is **not** stored in the code.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in.
2. Create a new project (top bar, then **New Project**).
3. Open **APIs & Services**, then **Library**. Search for **YouTube Data API v3** and click **Enable**.
4. Open **APIs & Services**, then **Credentials**, then **Create credentials**, then **API key**.
5. Give the key any name you like (it is only a label) and click **Create**.
6. Copy the key (it starts with `AIza`).
7. Recommended: open the key and, under **API restrictions**, choose **Restrict key** and select only **YouTube Data API v3**.

## Adding the key in the app

1. Open the app and click **Settings** in the sidebar.
2. Paste the key into the **API key** field (use **Show** to check it).
3. Click **Save key**.

The key is saved only in your browser's LocalStorage and is sent only to Google's API. Use **Remove key** to delete it.

## How to use

1. **Import:** paste a link such as `https://www.youtube.com/playlist?list=PLxxxxxxxx` and click **Import playlist**. A video link that contains `list=` also works.
2. **Track:** open a playlist and tick the checkbox next to each video you finish. Untick to mark it as not completed.
3. **Find videos:** use the search box and the All / Completed / Pending buttons.
4. **Watch:** click **Watch on YouTube** on any video.
5. **Update a playlist:** click **Sync from YouTube** to fetch newly added videos. Your progress is kept.
6. **Start over:** use **Reset progress** to clear the ticks in one playlist, or **Remove** on a playlist card to delete it.

## Common errors

| Message | What to do |
| --- | --- |
| Add your YouTube API key in Settings | Save your key in Settings first |
| API key is not valid | Copy the key again and check for extra spaces |
| YouTube Data API v3 is not enabled | Enable it for the same Google Cloud project as your key |
| Daily quota is used up | Try again tomorrow; the free quota resets daily |
| Playlist is private or not found | Only public and unlisted playlists can be imported |
| Does not look like a playlist link | The link must contain `list=` followed by the playlist ID |
| This playlist is already imported | Open it from My Playlists instead |

Private and deleted videos are skipped, so the total counts only videos that are available.

## Uploading to GitHub

The project is safe to upload because the API key is never written in the code.

**Using the website**

1. On github.com click **+**, then **New repository**. Name it `Playlist-Progress-Tracker` and click **Create repository**.
2. Click **uploading an existing file**.
3. Drag in the files **inside** the project folder (`index.html`, `style.css`, `script.js`, `assets`, `README.md`), so that `index.html` is at the top level of the repository.
4. Click **Commit changes**.

**Using Git**

```
git init
git add .
git commit -m "Playlist Progress Tracker"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/Playlist-Progress-Tracker.git
git push -u origin main
```

## Publishing online with GitHub Pages

1. In your repository open **Settings**, then **Pages**.
2. Under **Source** choose **Deploy from a branch**, select branch `main` and folder `/ (root)`, then **Save**.
3. After a minute your site is live at `https://YOUR-USERNAME.github.io/Playlist-Progress-Tracker/`.

Every visitor must add their own API key in Settings. If you use your own key on the live site, restrict it in Google Cloud: open the key, set **Application restrictions** to **Websites**, and add `https://YOUR-USERNAME.github.io/*`.

## Security notes

- Never write your API key into `script.js`, `index.html` or this README.
- Never commit a key to GitHub. If a key is exposed, delete or regenerate it in Google Cloud and save the new one in Settings.
- Playlist data and progress are stored per browser. Clearing browser data removes them.

## Tech stack

HTML5, CSS3, vanilla JavaScript, YouTube Data API v3, LocalStorage.
