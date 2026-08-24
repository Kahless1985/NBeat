(() => {
  'use strict';
  const C = globalThis.BeatRaterCore;
  const $ = id => document.getElementById(id);

  const DEFAULT_OPTIONS = {
    pauseAtBeatEnd: true,
    playbackSpeed: 1.0,
    defaultNavigationUnit: 'beat',
    startPlaybackAfterJump: true,
    promptScoreForwardSkip: true,
    unratedReviewMode: false,
    waveformAwareStopping: true
  };

  class BeatRaterPWA {
    constructor() {
      this.audio = $('audio');
      this.options = this.loadOptions();
      this.clock = new C.PlaybackClock(this.options.playbackSpeed);
      this.book = null;
      this.currentIdx = 0;
      this.navUnit = this.options.defaultNavigationUnit;
      this.autoPaused = false;
      this.preRatedIdx = null;
      this.wantPlaying = false;
      this.wakeLock = null;
      this.lastVisualUpdate = 0;
      this.lastDriftCheck = 0;
      this.bulkResolver = null;
      this.bindUI();
      this.bindAudio();
      this.applyOptionsToUI();
      this.render();
      this.startLoop();
      this.registerServiceWorker();
    }

    loadOptions() {
      try { return { ...DEFAULT_OPTIONS, ...JSON.parse(localStorage.getItem('beat-rater:options') || '{}') }; }
      catch { return { ...DEFAULT_OPTIONS }; }
    }
    saveOptions() { localStorage.setItem('beat-rater:options', JSON.stringify(this.options)); }

    bindUI() {
      document.querySelectorAll('.rating').forEach(b => b.addEventListener('click', () => this.rateCurrent(Number(b.dataset.score))));
      $('backBtn').addEventListener('click', () => this.goBack());
      $('playBtn').addEventListener('click', () => this.handlePlayPause());
      $('forwardBtn').addEventListener('click', () => this.goForward());
      $('optionsBtn').addEventListener('click', () => this.openOptions());
      $('skipBtn').addEventListener('click', () => this.skipRating());
      $('unratedBtn').addEventListener('click', () => this.jumpToNextUnrated(true));
      document.querySelectorAll('.nav-chip').forEach(b => b.addEventListener('click', () => this.setNav(b.dataset.nav)));

      for (const [inputId, labelId] of [['audioFile','audioName'],['csvFile','csvName'],['timingFile','timingName']]) {
        $(inputId).addEventListener('change', e => { $(labelId).textContent = e.target.files?.[0]?.name || 'Not selected'; });
      }
      $('loadBookBtn').addEventListener('click', () => this.loadBookFromInputs());
      $('cancelLoadBtn').addEventListener('click', () => this.hide('loadModal'));
      $('resumeBtn').addEventListener('click', () => this.startFromSaved());
      $('firstBtn').addEventListener('click', () => this.startFromFirst());

      $('closeOptionsBtn').addEventListener('click', () => this.hide('optionsModal'));
      $('pauseAtEndOpt').addEventListener('change', e => this.setOption('pauseAtBeatEnd', e.target.checked));
      $('speedOpt').addEventListener('input', e => {
        const n = Math.max(.5, Math.min(3, Number(e.target.value)));
        this.options.playbackSpeed = n; this.saveOptions(); this.clock.setRate(n); this.audio.playbackRate = n; $('speedOut').textContent = `${n.toFixed(2)}×`; this.render();
      });
      $('defaultNavOpt').addEventListener('change', e => this.setOption('defaultNavigationUnit', e.target.value));
      $('startAfterJumpOpt').addEventListener('change', e => this.setOption('startPlaybackAfterJump', e.target.checked));
      $('bulkPromptOpt').addEventListener('change', e => this.setOption('promptScoreForwardSkip', e.target.checked));
      $('unratedReviewOpt').addEventListener('change', e => this.setOption('unratedReviewMode', e.target.checked));
      $('waveformOpt').addEventListener('change', e => { this.setOption('waveformAwareStopping', e.target.checked); this.render('Timing mode changed.'); });
      $('firstActionBtn').addEventListener('click', () => { this.hide('optionsModal'); this.seekToIndex(0); });
      $('unratedActionBtn').addEventListener('click', () => { this.hide('optionsModal'); this.jumpToNextUnrated(true); });
      $('skipActionBtn').addEventListener('click', () => { this.hide('optionsModal'); this.skipRating(); });
      $('exportBtn').addEventListener('click', () => this.exportCSV());
      $('openBookActionBtn').addEventListener('click', () => { this.hide('optionsModal'); this.showLoadModal(true); });
      $('helpBtn').addEventListener('click', () => { this.hide('optionsModal'); this.show('helpModal'); });
      $('closeHelpBtn').addEventListener('click', () => this.hide('helpModal'));

      document.querySelectorAll('[data-bulk-score]').forEach(b => b.addEventListener('click', () => this.resolveBulk(Number(b.dataset.bulkScore))));
      $('bulkNoScoreBtn').addEventListener('click', () => this.resolveBulk('no_score'));
      $('bulkCancelBtn').addEventListener('click', () => this.resolveBulk(null));

      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.wantPlaying) this.requestWakeLock();
      });
    }

    bindAudio() {
      this.audio.addEventListener('playing', () => {
        if (this.wantPlaying) this.clock.setPosition(this.audio.currentTime * 1000, true);
        this.requestWakeLock(); this.render();
      });
      this.audio.addEventListener('waiting', () => { if (this.clock.playing) this.clock.pause(this.audio.currentTime * 1000); });
      this.audio.addEventListener('stalled', () => { if (this.clock.playing) this.clock.pause(this.audio.currentTime * 1000); });
      this.audio.addEventListener('canplay', () => { if (this.wantPlaying && !this.audio.paused) this.clock.setPosition(this.audio.currentTime * 1000, true); });
      this.audio.addEventListener('seeked', () => this.clock.setPosition(this.audio.currentTime * 1000, this.wantPlaying && !this.audio.paused));
      this.audio.addEventListener('ended', () => { this.wantPlaying = false; this.clock.pause(this.audio.currentTime * 1000); this.releaseWakeLock(); this.saveState(); this.render('Reached end of audio.'); });
      this.audio.addEventListener('error', () => this.render('Audio playback error. Try reopening the MP4.'));
    }

    setOption(name, value) { this.options[name] = value; this.saveOptions(); this.applyOptionsToUI(); }
    applyOptionsToUI() {
      $('pauseAtEndOpt').checked = !!this.options.pauseAtBeatEnd;
      $('speedOpt').value = String(this.options.playbackSpeed);
      $('speedOut').textContent = `${Number(this.options.playbackSpeed).toFixed(2)}×`;
      $('defaultNavOpt').value = this.options.defaultNavigationUnit;
      $('startAfterJumpOpt').checked = !!this.options.startPlaybackAfterJump;
      $('bulkPromptOpt').checked = !!this.options.promptScoreForwardSkip;
      $('unratedReviewOpt').checked = !!this.options.unratedReviewMode;
      $('waveformOpt').checked = !!this.options.waveformAwareStopping;
      this.audio.playbackRate = Number(this.options.playbackSpeed);
    }

    show(id) { $(id).classList.add('visible'); }
    hide(id) { $(id).classList.remove('visible'); }
    showLoadModal(canCancel) { $('cancelLoadBtn').classList.toggle('hidden', !canCancel); $('loadError').textContent = ''; this.show('loadModal'); }

    async loadBookFromInputs() {
      const audioFile = $('audioFile').files?.[0];
      const csvFile = $('csvFile').files?.[0];
      const timingFile = $('timingFile').files?.[0];
      $('loadError').textContent = '';
      if (!audioFile || !csvFile || !timingFile) { $('loadError').textContent = 'Select the MP4, CSV, and timing JSON.'; return; }
      try {
        const parsed = C.parseCSV(await csvFile.text());
        const timingPayload = JSON.parse(await timingFile.text());
        const timing = await C.validateTimings(timingPayload, parsed.rows, audioFile);
        const unitStarts = C.buildUnitStarts(parsed.rows);
        const key = C.bookStateKey(parsed.rows, audioFile.name, csvFile.name);
        const boundaryHash = (await C.sha256Hex(C.boundaryHashText(parsed.rows))) || C.boundaryHashText(parsed.rows);
        const expectedTimingName = csvFile.name.replace(/\.csv$/i, '') + '.timings.json';
        const nameWarning = timingFile.name !== expectedTimingName ? `Expected ${expectedTimingName}; selected ${timingFile.name}.` : '';

        if (this.book?.audioURL) URL.revokeObjectURL(this.book.audioURL);
        const audioURL = URL.createObjectURL(audioFile);
        this.book = { audioFile, csvFile, timingFile, headers: parsed.headers, rows: parsed.rows, timingStops: timing.stops, unitStarts, key, boundaryHash, audioURL };
        this.currentIdx = 0; this.navUnit = this.options.defaultNavigationUnit; this.autoPaused = false; this.preRatedIdx = null;
        this.wantPlaying = false; this.audio.pause(); this.audio.src = audioURL; this.audio.load(); this.audio.playbackRate = this.options.playbackSpeed;
        await this.waitForMetadata();
        this.clock.setPosition(parsed.rows[0]._start_ms, false);
        this.restoreSavedScores();
        this.hide('loadModal');
        const saved = this.readState();
        const warnings = [...timing.warnings]; if (nameWarning) warnings.push(nameWarning);
        this.book.warning = warnings.join(' ');
        if (saved && saved.boundaryHash === boundaryHash) {
          this.restoreProgress(saved);
          $('resumeInfo').textContent = `Saved Beat ${this.currentIdx + 1} / ${this.book.rows.length} at ${C.msToTimestamp(saved.positionMs ?? this.book.rows[this.currentIdx]._start_ms)}.`;
          this.show('resumeModal');
        } else {
          this.currentIdx = 0; this.preRatedIdx = null; this.navUnit = this.options.defaultNavigationUnit;
          this.seekMs(this.book.rows[0]._start_ms, false);
          this.render(this.book.warning || `Loaded ${this.book.rows.length} Beats. Tap Play to start.`);
        }
      } catch (err) {
        console.error(err); $('loadError').textContent = err?.message || String(err);
      }
    }

    waitForMetadata() {
      if (this.audio.readyState >= 1) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error('Could not read MP4 metadata.')); };
        const cleanup = () => { clearTimeout(timer); this.audio.removeEventListener('loadedmetadata', done); this.audio.removeEventListener('error', fail); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out reading MP4 metadata.')); }, 15000);
        this.audio.addEventListener('loadedmetadata', done, { once: true });
        this.audio.addEventListener('error', fail, { once: true });
      });
    }

    stateKey() { return this.book ? `beat-rater:book:${this.book.key}` : null; }
    readState() { if (!this.book) return null; try { return JSON.parse(localStorage.getItem(this.stateKey()) || 'null'); } catch { return null; } }
    restoreSavedScores() {
      const state = this.readState();
      if (!state || state.boundaryHash !== this.book.boundaryHash || !state.scores) return;
      const byId = new Map(this.book.rows.map((r, i) => [C.beatId(r, i), i]));
      for (const [id, score] of Object.entries(state.scores)) { const idx = byId.get(id); if (idx != null && [-2,-1,0,1,2].includes(Number(score))) this.book.rows[idx].Score = String(score); }
    }
    restoreProgress(state) {
      const byId = new Map(this.book.rows.map((r, i) => [C.beatId(r, i), i]));
      let idx = state.beatId ? byId.get(state.beatId) : null;
      if (idx == null && Number.isInteger(state.currentIdx) && state.currentIdx >= 0 && state.currentIdx < this.book.rows.length) idx = state.currentIdx;
      this.currentIdx = idx ?? 0;
      this.navUnit = C.NAV_UNITS.includes(state.navUnit) ? state.navUnit : this.options.defaultNavigationUnit;
      const preIdx = state.preRatedBeatId ? byId.get(state.preRatedBeatId) : null;
      this.preRatedIdx = preIdx === this.currentIdx ? preIdx : null;
      this.savedPositionMs = Math.max(0, Number(state.positionMs ?? this.book.rows[this.currentIdx]._start_ms));
    }
    saveState(positionMs = null) {
      if (!this.book) return;
      const scores = {};
      this.book.rows.forEach((r, i) => { if (C.isRated(r)) scores[C.beatId(r, i)] = Number(r.Score); });
      const state = {
        version: 1, boundaryHash: this.book.boundaryHash, mediaFile: this.book.audioFile.name, csvFile: this.book.csvFile.name,
        currentIdx: this.currentIdx, beatId: C.beatId(this.book.rows[this.currentIdx], this.currentIdx),
        preRatedBeatId: this.preRatedIdx === this.currentIdx ? C.beatId(this.book.rows[this.currentIdx], this.currentIdx) : '',
        navUnit: this.navUnit, positionMs: Math.max(0, Math.round(positionMs ?? this.clock.nowMs())), scores, updatedAt: Date.now()
      };
      localStorage.setItem(this.stateKey(), JSON.stringify(state));
    }

    startFromSaved() { this.hide('resumeModal'); this.seekMs(this.savedPositionMs ?? this.book.rows[this.currentIdx]._start_ms, true); this.render(this.book.warning || 'Resumed saved position.'); }
    startFromFirst() { this.hide('resumeModal'); this.currentIdx = 0; this.preRatedIdx = null; this.navUnit = this.options.defaultNavigationUnit; this.seekMs(this.book.rows[0]._start_ms, true); this.saveState(this.book.rows[0]._start_ms); this.render('Started at first Beat.'); }

    effectiveStopMs(idx = this.currentIdx) { return this.options.waveformAwareStopping ? this.book.timingStops[idx] : this.book.rows[idx]._stop_ms; }
    isPlaying() { return this.clock.playing && this.wantPlaying; }

    async safePlay() {
      if (!this.book) return;
      this.wantPlaying = true; this.autoPaused = false;
      this.audio.playbackRate = this.options.playbackSpeed;
      this.clock.setRate(this.options.playbackSpeed);
      this.clock.setPosition(this.audio.currentTime * 1000, true);
      try { await this.audio.play(); this.clock.setPosition(this.audio.currentTime * 1000, true); await this.requestWakeLock(); }
      catch (err) { this.wantPlaying = false; this.clock.pause(this.audio.currentTime * 1000); this.render('iPhone blocked autoplay. Tap Play once to start audio.'); }
      this.render();
    }
    pausePlayback({ manual = true } = {}) {
      if (!this.book) return;
      const pos = this.clock.nowMs(); this.wantPlaying = false; this.audio.pause(); this.clock.pause(pos); if (manual) this.autoPaused = false; this.releaseWakeLock(); this.saveState(pos); this.render(manual ? 'Paused.' : 'Reached Beat pause point.');
    }
    seekMs(ms, playAfter) {
      if (!this.book) return;
      const target = Math.max(0, Number(ms) || 0);
      this.wantPlaying = false; this.audio.pause(); this.audio.currentTime = target / 1000; this.clock.setPosition(target, false); this.releaseWakeLock();
      if (playAfter) this.safePlay(); else this.render();
    }
    seekToIndex(idx, playAfter = null) {
      if (!this.book) return;
      idx = Math.max(0, Math.min(idx, this.book.rows.length - 1));
      this.currentIdx = idx; this.preRatedIdx = null; this.autoPaused = false;
      const play = playAfter == null ? this.options.startPlaybackAfterJump : !!playAfter;
      const ms = this.book.rows[idx]._start_ms; this.seekMs(ms, play); this.saveState(ms);
    }

    async handlePlayPause() {
      if (!this.book) { this.showLoadModal(false); return; }
      if (this.isPlaying()) { this.pausePlayback({ manual: true }); return; }
      if (this.autoPaused) {
        if (this.currentIdx >= this.book.rows.length - 1) { this.render('At the final Beat boundary.'); return; }
        this.currentIdx++; this.preRatedIdx = null; this.autoPaused = false; await this.safePlay(); this.saveState(); this.render(`Continued without rating into Beat ${this.currentIdx + 1}.`); return;
      }
      await this.safePlay(); this.saveState(); this.render('Playing.');
    }

    async rateCurrent(score) {
      if (!this.book) return;
      this.book.rows[this.currentIdx].Score = String(score); this.saveState();
      if (this.options.unratedReviewMode) {
        const dest = C.nextUnratedIndex(this.book.rows, this.currentIdx);
        if (dest == null) { this.render(`Saved score ${score}. No later unrated Beats remain.`); return; }
        this.seekToIndex(dest, true); this.render(`Saved score ${score}; jumped to next unrated Beat ${dest + 1}.`); return;
      }
      const stop = this.effectiveStopMs(); const pos = this.clock.nowMs();
      if (!this.autoPaused && pos < stop) {
        this.preRatedIdx = this.currentIdx; this.autoPaused = false; await this.safePlay(); this.saveState(); this.render(`Saved ${score} early; this Beat boundary will not pause.`); return;
      }
      this.preRatedIdx = null;
      if (this.currentIdx >= this.book.rows.length - 1) { this.saveState(); this.render(`Saved score ${score}. This is the final Beat.`); return; }
      this.currentIdx++; this.autoPaused = false; await this.safePlay(); this.saveState(); this.render(`Saved score ${score}; continuing naturally into Beat ${this.currentIdx + 1}.`);
    }

    async skipRating() {
      if (!this.book) return;
      if (this.options.unratedReviewMode) {
        const dest = C.nextUnratedIndex(this.book.rows, this.currentIdx);
        if (dest == null) { this.render('No later unrated Beats remain.'); return; }
        this.seekToIndex(dest, true); this.render(`Left score unchanged; jumped to Beat ${dest + 1}.`); return;
      }
      if (this.currentIdx >= this.book.rows.length - 1) { this.render('This is the final Beat.'); return; }
      this.preRatedIdx = null; this.currentIdx++; this.autoPaused = false; await this.safePlay(); this.saveState(); this.render(`Advanced without rating into Beat ${this.currentIdx + 1}.`);
    }

    setNav(unit) { if (!C.NAV_UNITS.includes(unit)) return; this.navUnit = unit; this.saveState(); this.render(`Navigation set to ${unit.toUpperCase()}.`); }

    goBack() {
      if (!this.book) return;
      const wasPlaying = this.isPlaying(); const starts = this.book.unitStarts[this.navUnit];
      const currentStart = C.currentUnitStart(starts, this.currentIdx); const unitStartMs = this.book.rows[currentStart]._start_ms; const pos = this.clock.nowMs();
      const atStart = this.currentIdx === currentStart && Math.abs(pos - unitStartMs) <= 150;
      let dest = atStart ? C.previousUnitStart(starts, this.currentIdx) : currentStart;
      if (dest == null) { this.render('Already at the first unit.'); return; }
      this.seekToIndex(dest, wasPlaying); this.render(`Jumped to start of ${this.navUnit} at Beat ${dest + 1}; playback remains ${wasPlaying ? 'playing' : 'paused'}.`);
    }

    async goForward() {
      if (!this.book) return;
      if (this.navUnit === 'beat') {
        const stop = this.effectiveStopMs(); this.wantPlaying = false; this.audio.pause(); this.audio.currentTime = stop / 1000; this.clock.setPosition(stop, false); this.preRatedIdx = null; this.autoPaused = true; this.releaseWakeLock(); this.saveState(stop); this.render('Jumped to current Beat pause point.'); return;
      }
      const dest = C.nextUnitStart(this.book.unitStarts[this.navUnit], this.currentIdx);
      if (dest == null) { this.render('Already at the last unit.'); return; }
      if (this.options.promptScoreForwardSkip) {
        if (this.isPlaying()) this.pausePlayback({ manual: true });
        const choice = await this.promptBulkScore(dest);
        if (choice === null) { this.render('Forward skip cancelled.'); return; }
        if (typeof choice === 'number') {
          for (let i = this.currentIdx; i < dest; i++) this.book.rows[i].Score = String(choice);
          this.saveState();
        }
      }
      this.seekToIndex(dest); this.render(`Jumped forward to ${this.navUnit} at Beat ${dest + 1}.`);
    }

    promptBulkScore(dest) {
      $('bulkInfo').textContent = `This ${this.navUnit} skip passes ${Math.max(0, dest - this.currentIdx)} Beat(s). Applying a score overwrites existing scores in that range.`;
      this.show('bulkModal');
      return new Promise(resolve => { this.bulkResolver = resolve; });
    }
    resolveBulk(value) { this.hide('bulkModal'); if (this.bulkResolver) { const r = this.bulkResolver; this.bulkResolver = null; r(value); } }

    jumpToNextUnrated(playAfter = true) {
      if (!this.book) return;
      const dest = C.nextUnratedIndex(this.book.rows, this.currentIdx);
      if (dest == null) { const remaining = C.unratedCount(this.book.rows); this.render(remaining ? `No later unrated Beats; ${remaining} remain earlier.` : 'All Beats are rated.'); return; }
      this.seekToIndex(dest, playAfter); this.render(`Jumped to next unrated Beat ${dest + 1} / ${this.book.rows.length}.`);
    }

    openOptions() { if (this.book && this.isPlaying()) this.pausePlayback({ manual: true }); this.applyOptionsToUI(); this.show('optionsModal'); }

    async exportCSV() {
      if (!this.book) return;
      const text = C.serializeCSV(this.book.headers, this.book.rows);
      const file = new File([text], this.book.csvFile.name, { type: 'text/csv;charset=utf-8' });
      try {
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ title: 'Beat Rater CSV', files: [file] });
          this.render('CSV export opened. Choose Save to Files to keep it on iPhone.');
        } else {
          const url = URL.createObjectURL(file); const a = document.createElement('a'); a.href = url; a.download = this.book.csvFile.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000); this.render('CSV downloaded.');
        }
      } catch (err) { if (err?.name !== 'AbortError') this.render(`Export failed: ${err?.message || err}`); }
    }

    startLoop() {
      setInterval(() => this.tick(), 5);
      setInterval(() => { if (this.book) this.render(); }, 500);
    }
    tick() {
      if (!this.book || !this.clock.playing || !this.wantPlaying) return;
      const now = performance.now(); const pos = this.clock.nowMs(); const stop = this.effectiveStopMs();
      if (this.preRatedIdx === this.currentIdx) {
        if (pos >= stop && this.currentIdx < this.book.rows.length - 1) { this.currentIdx++; this.preRatedIdx = null; this.autoPaused = false; this.saveState(pos); this.render(`Early-rated Beat complete; continuing into Beat ${this.currentIdx + 1}.`); }
        return;
      }
      if (this.options.pauseAtBeatEnd && pos >= stop) {
        this.wantPlaying = false; this.audio.pause(); this.clock.pause(pos); this.autoPaused = true; this.releaseWakeLock(); this.saveState(pos); this.render('Reached Beat pause point. Rate it, skip it, or navigate.'); return;
      }
      if (now - this.lastDriftCheck > 1000 && !this.audio.seeking && this.audio.readyState >= 2) {
        this.lastDriftCheck = now; const actual = this.audio.currentTime * 1000; if (Math.abs(actual - pos) > 250) this.clock.setPosition(actual, true);
      }
    }

    render(message = null) {
      if (message != null) $('message').textContent = message;
      const playing = this.isPlaying(); $('playIcon').textContent = playing ? 'Ⅱ' : '▶'; $('playLabel').textContent = playing ? 'Pause' : 'Play';
      if (!this.book) return;
      const r = this.book.rows[this.currentIdx]; const stop = this.effectiveStopMs(); const csvStop = r._stop_ms; const pos = this.clock.nowMs();
      $('contextLine').textContent = `Movement ${r.Movement} • Sequence ${r.Sequence} • Scene ${r.Scene} • Beat ${r.Beat}`;
      $('beatStat').textContent = `Beat ${this.currentIdx + 1} / ${this.book.rows.length}`;
      $('scoreStat').textContent = `Score: ${C.isRated(r) ? r.Score : 'unrated'}`;
      $('unratedStat').textContent = `Unrated: ${C.unratedCount(this.book.rows)}`;
      $('positionStat').textContent = C.msToTimestamp(pos);
      const delta = stop - csvStop;
      $('pauseStat').textContent = delta ? `Pause ${C.msToTimestamp(stop)} (${delta > 0 ? '+' : ''}${delta} ms)` : `Pause ${C.msToTimestamp(stop)}`;
      $('progressFill').style.width = `${Math.max(0, Math.min(100, (this.currentIdx + 1) / this.book.rows.length * 100))}%`;
      $('timingBadge').textContent = this.options.waveformAwareStopping ? 'Waveform timing' : 'CSV timing';
      document.querySelectorAll('.nav-chip').forEach(b => b.classList.toggle('active', b.dataset.nav === this.navUnit));
      if (this.preRatedIdx === this.currentIdx) $('message').textContent = 'Rated early — this Beat boundary will not pause.';
    }

    async requestWakeLock() {
      if (!('wakeLock' in navigator) || document.hidden || !this.wantPlaying) return;
      try { this.wakeLock = await navigator.wakeLock.request('screen'); this.wakeLock.addEventListener('release', () => { this.wakeLock = null; }); } catch { /* optional */ }
    }
    async releaseWakeLock() { try { await this.wakeLock?.release(); } catch {} this.wakeLock = null; }

    async registerServiceWorker() {
      if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        try { await navigator.serviceWorker.register('./sw.js'); } catch (err) { console.warn('Service worker registration failed', err); }
      }
    }
  }

  new BeatRaterPWA();
})();
