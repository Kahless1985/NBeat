# Install Beat Rater on iPhone — free, using a Windows PC

## 1. Put the PWA on GitHub Pages

1. Create a free GitHub account if you do not already have one.
2. Create a **public** repository, for example `beat-rater-pwa`.
3. Upload the contents of this folder to the repository root. Do **not** upload audiobook MP4/CSV/timing files; those remain local on your devices.
4. In the repository open **Settings → Pages**.
5. Under **Build and deployment**, choose **Deploy from a branch**.
6. Select branch **main**, folder **/(root)**, then **Save**.
7. Open the GitHub Pages URL shown by GitHub. It will normally look like `https://YOURNAME.github.io/beat-rater-pwa/`.

## 2. Add it to the iPhone Home Screen

1. Open that GitHub Pages URL in **Safari** on the iPhone.
2. Open Safari's menu/share sheet and choose **Add to Home Screen**.
3. Turn on **Open as Web App**.
4. Tap **Add**.
5. Launch **Beat Rater** from the new Home Screen icon.
6. Open it once while online so the offline app shell can be cached.

## 3. Get a book from the Windows PC to the iPhone

You need these three matching files:

- `audiobook.mp4`
- `book_beats.csv`
- `book_beats.timings.json`

A free no-cloud method is to share the book folder from Windows over your local network, then use the iPhone **Files** app:

1. Share the Windows folder on your home network (SMB).
2. On iPhone: **Files → Browse → … → Connect to Server**.
3. Enter your PC's local hostname or IP address and sign in with your Windows account if required.
4. Open the shared folder and copy the three files into a local folder under **On My iPhone** (recommended for reliable playback).

You can also use iCloud Drive or another Files provider if you prefer.

## 4. Use Beat Rater

1. Open Beat Rater from the Home Screen.
2. Select the MP4, CSV, and matching `.timings.json` from the Files picker.
3. Rate normally.
4. Ratings and progress are checkpointed in Beat Rater's local browser storage after actions.
5. When finished, open **Options → Export CSV** and choose **Save to Files** from the iPhone share sheet.
6. Copy the exported CSV back to the PC.

## Timing note

Beat Rater uses the PC-generated `effective_stop_ms` values when Waveform-aware Beat stopping is ON. The PWA uses a high-resolution monotonic JavaScript clock for boundary checks, analogous to the Windows app's high-resolution playback clock.

For reliable automatic boundary pauses, keep Beat Rater visible while listening/rating. iOS can throttle web timers if a PWA is sent to the background or the screen locks.


## Updating an existing installed test copy

After replacing the files in your GitHub Pages repository, open the site in Safari on the iPhone while online and refresh it. Confirm the small version text beside **Beat Rater** says **v0.1.1**. Then close and reopen the Home Screen app. If it still shows an older version, remove the old Home Screen icon and add the site to the Home Screen again. Your source MP4/CSV/timing files are not stored in the website cache.
