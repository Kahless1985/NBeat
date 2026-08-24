# Windows Beat Rater v0.1.14 vs iPhone PWA v0.1.1

The Windows v0.1.14 player is the behavioral reference.

## Windows behavior that the PWA now implements

- -2 / -1 / 0 / +1 / +2 scoring.
- Early rating saves immediately, keeps the same Beat current, keeps playing, and suppresses that Beat's boundary pause.
- Rating at the automatic boundary pause advances the Beat pointer and resumes from the same media position without seeking.
- Skip leaves Score unchanged and continues naturally without seeking.
- Beat / Scene / Sequence / Movement navigation.
- Back goes to the current unit start, or the previous unit if already at the start, and preserves play/pause state.
- Beat-mode forward goes to the current effective Beat pause point and deliberately pauses there.
- Scene / Sequence / Movement forward goes to the next unit and can bulk-overwrite skipped Beat scores.
- First Beat action.
- Next Unrated action.
- Unrated Review Mode.
- Pause-at-Beat-end option.
- Playback speed 0.5x-3.0x.
- Default navigation unit.
- Start playback after explicit jump option.
- Forward bulk-score prompt option.
- Waveform-aware stopping toggle using PC-produced effective_stop_ms values.
- Exact Beat / Scene / Sequence / Movement boundaries from the CSV.
- Resume by Beat_ID with row fallback and exact playback position.
- Early-rating state persists across resume.
- Main display includes current hierarchy, score, unrated count, playback state, speed, review mode, effective pause point, CSV pause point when adjusted, and position.
- New-book playback is attempted automatically, matching Windows; if iOS blocks the first play, the app falls back to a visible Tap Play instruction.

## Intentional platform differences

- Windows writes Score directly into the source CSV after each rating and creates a .before_beat_rater.bak backup. iOS Safari does not give this PWA a persistent writable handle to the originally selected CSV, so the PWA checkpoints ratings locally and exports an updated CSV.
- Windows remembers files by path. The PWA cannot silently reopen an arbitrary local MP4/CSV/JSON after iOS revokes the file-picker objects, so book files may need to be selected again after a full app restart.
- Windows performs waveform preprocessing itself. The PWA deliberately consumes the portable .timings.json produced on the PC instead.
- Windows has a Quit command. A Home Screen web app is closed using normal iPhone app switching; progress is checkpointed periodically and on pagehide/visibility changes.
- iOS can throttle JavaScript when the app is backgrounded. The PWA requests a screen wake lock, but automatic Beat stops are only considered reliable while the app remains foregrounded.

## v0.1.0 defects found during review

1. The HTML audio element and logical playback clock could disagree about whether playback was active.
2. `stalled` incorrectly paused the logical clock even though a stalled event does not guarantee audible playback stopped. This directly explains a timer freezing while audio continued.
3. The Play/Pause icon was derived from logical flags instead of the actual media element, so system/WebKit play/pause transitions could leave the wrong icon visible.
4. There was no `pause` event handler to synchronize a pause initiated outside Beat Rater's own button logic.
5. WebKit/system-initiated play could occur without restoring Beat Rater's `wantPlaying` state, disabling automatic boundary checks.
6. Automatic stopping depended primarily on a 5 ms JavaScript interval. iOS does not guarantee that scheduling frequency and can delay or batch timers.
7. The clock could remain frozen after buffering/stall event sequences if WebKit did not produce the exact expected recovery event order.
8. Seeks could start playback before the seek had settled, allowing the logical clock to briefly anchor to the wrong media position.
9. Progress was saved on actions but not checkpointed during uninterrupted playback or reliably on PWA lifecycle changes.
10. The cache-first service worker made it unnecessarily easy for an installed test PWA to keep running old JavaScript after the repository had been updated.
11. The generic Forward label hid an important Windows behavior: in Beat navigation, Forward deliberately means "go to this Beat's end and pause," not "start the next Beat."
12. The phone display omitted some Windows status information such as playback speed, Unrated Review state, and the original CSV Stop_Time when waveform timing had adjusted it.

## v0.1.1 playback changes

- Actual HTML media pause state drives the Play/Pause control.
- Explicit handlers synchronize `play`, `playing`, `pause`, `waiting`, `stalled`, `seeking`, `seeked`, `timeupdate`, `ratechange`, and `ended` transitions.
- `stalled` no longer freezes the logical clock.
- `waiting` freezes the clock only while the media timeline is genuinely waiting; `playing` or advancing `timeupdate` resumes it.
- Seeking now waits for the target to settle before optional playback begins.
- Boundary stopping is checked by four independent mechanisms: requestAnimationFrame, a scheduled boundary timeout, media timeupdate events, and a 500 ms safety heartbeat.
- A periodic 5-second progress checkpoint and lifecycle saves reduce resume-position loss.
- Forward is dynamically labeled Beat End / Next Scene / Next Seq. / Next Move. to expose its actual action.
- The service worker now prefers current network files while the test site exists and uses the cache as offline fallback.
- The app displays its version beside the title so an old cached install is easy to identify.
