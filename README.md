# Beat Rater PWA v0.1.0

A private, installable iPhone web app that mirrors the behavior of Beat Rater v0.1.14 while using the PC-generated waveform timing cache.

## Book files

For each book select:

- `audiobook.mp4`
- `book_beats.csv`
- `book_beats.timings.json`

The app reads `effective_stop_ms` from the timing JSON. Turning **Waveform-aware Beat stopping** off switches to the CSV `Stop_Time` values.

## Implemented behavior

- Scores `-2, -1, 0, +1, +2`
- Early rating: saves immediately, keeps playing, suppresses that Beat's boundary pause
- Rating at an automatic boundary pause: advances and resumes from the same audio position with no seek
- Skip rating: leaves Score unchanged and continues naturally
- Beat/Scene/Sequence/Movement navigation
- Backward navigation preserves play/pause state
- Beat-forward jumps to current effective pause point
- Higher-level forward skip with optional bulk-score overwrite prompt
- Next unrated Beat
- Unrated Review Mode
- First Beat action
- Auto-pause toggle
- Playback speed 0.5x to 3.0x
- Start-after-jump option
- Waveform-aware timing toggle
- Per-book score/progress persistence in browser storage
- Resume saved Beat and exact position
- CSV export/share using the original CSV filename
- OLED true-black UI
- Screen Wake Lock request while playing when supported
- Offline app shell after first successful load

## Important iPhone limitation

Automatic boundary timing should be used with the PWA visible in the foreground. iOS may throttle JavaScript timers when a web app is backgrounded or the screen is locked. Beat Rater requests a screen wake lock while playing where supported.

## PC preview

Double-click `serve_preview.bat` if Python is installed, then test at `http://localhost:8000`.

For iPhone installation, host this folder over HTTPS (GitHub Pages is free) and use Safari's **Add to Home Screen** / **Open as Web App**.
