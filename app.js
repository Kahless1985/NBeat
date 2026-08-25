(() => {
  'use strict';
  const C = globalThis.BeatRaterCore;
  const $ = id => document.getElementById(id);
  const APP_VERSION = '0.1.6';
  const BACKUP_CHANGE_THRESHOLD = 50;
  const BACKUP_TIME_THRESHOLD_MS = 60 * 60 * 1000;

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

      // Keep one explicit playback intent plus media-event state. The old PWA
      // let the HTMLAudioElement and the logical clock disagree, which caused
      // stale icons, frozen timers, and missed Beat boundaries on iOS.
      this.playIntent = false;
      this.mediaState = 'paused'; // paused | starting | playing | buffering | seeking | ended
      this.pausePinMs = null;
      this.lastActualMediaMs = 0;
      this.lastVisualUpdate = 0;
      this.lastCheckpoint = 0;
      this.playRequestStartedAt = 0;
      this.pollLastMediaMs = 0;
      this.pollLastMediaAt = Date.now();
      this.boundaryTimer = null;
      this.frameRequest = null;
      this.wakeLock = null;
      this.bulkResolver = null;
      this.pendingBooks = [];

      this.bindUI();
      this.bindAudio();
      this.applyOptionsToUI();
      this.render();
      if (!new URLSearchParams(location.search).has('test')) {
        this.startLoop();
        this.registerServiceWorker();
      }
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
      $('backupBtn').addEventListener('click', () => this.exportCSV());
      $('skipBtn').addEventListener('click', () => this.skipRating());
      $('unratedBtn').addEventListener('click', () => this.jumpToNextUnrated(true));
      document.querySelectorAll('.nav-chip').forEach(b => b.addEventListener('click', () => this.setNav(b.dataset.nav)));

      $('bookFolder').addEventListener('change', e => this.prepareBookCandidates(e.target.files, 'folder'));
      $('bookFiles').addEventListener('change', e => this.prepareBookCandidates(e.target.files, 'files'));
      $('loadBookBtn').addEventListener('click', () => this.loadSelectedBook());

      // Every button gets immediate touch feedback. Rating buttons use a colored
      // fill flash; other controls use a shorter neutral pulse.
      document.querySelectorAll('button').forEach(button => {
        button.addEventListener('pointerdown', () => this.animateButtonPress(button));
      });
      $('cancelLoadBtn').addEventListener('click', () => this.hide('loadModal'));
      $('resumeBtn').addEventListener('click', () => this.startFromSaved());
      $('firstBtn').addEventListener('click', () => this.startFromFirst());

      $('closeOptionsBtn').addEventListener('click', () => this.hide('optionsModal'));
      $('pauseAtEndOpt').addEventListener('change', e => this.setOption('pauseAtBeatEnd', e.target.checked));
      $('speedOpt').addEventListener('input', e => {
        const n = Math.max(.5, Math.min(3, Number(e.target.value)));
        const pos = this.displayPositionMs();
        this.options.playbackSpeed = n;
        this.saveOptions();
        this.audio.playbackRate = n;
        this.clock.setRate(n);
        if (this.clock.playing) this.clock.setPosition(pos, true);
        $('speedOut').textContent = `${n.toFixed(2)}×`;
        this.scheduleBoundaryTimer();
        this.render();
      });
      $('defaultNavOpt').addEventListener('change', e => this.setOption('defaultNavigationUnit', e.target.value));
      $('startAfterJumpOpt').addEventListener('change', e => this.setOption('startPlaybackAfterJump', e.target.checked));
      $('bulkPromptOpt').addEventListener('change', e => this.setOption('promptScoreForwardSkip', e.target.checked));
      $('unratedReviewOpt').addEventListener('change', e => this.setOption('unratedReviewMode', e.target.checked));
      $('waveformOpt').addEventListener('change', e => {
        this.setOption('waveformAwareStopping', e.target.checked);
        this.scheduleBoundaryTimer();
        this.render('Timing mode changed.');
      });
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
        if (this.book) this.saveState(this.displayPositionMs());
        if (!document.hidden) {
          if (!this.audio.paused && this.playIntent) {
            this.syncPlayingClock('visibility');
            this.checkBoundary('visibility');
            this.requestWakeLock();
          }
          this.render();
        }
      });
      window.addEventListener('pagehide', () => { if (this.book) this.saveState(this.displayPositionMs()); });
    }

    bindAudio() {
      this.audio.addEventListener('play', () => {
        this.playIntent = true;
        if (!this.playRequestStartedAt) this.playRequestStartedAt = Date.now();
        this.mediaState = 'starting';
        this.render();
      });

      this.audio.addEventListener('playing', () => {
        this.playIntent = true;
        this.playRequestStartedAt = 0;
        this.mediaState = 'playing';
        this.syncPlayingClock('playing');
        this.scheduleBoundaryTimer();
        this.requestWakeLock();
        this.render();
      });

      this.audio.addEventListener('pause', () => {
        const pin = this.pausePinMs;
        this.pausePinMs = null;
        const pos = pin == null ? this.actualMediaMs() : pin;
        this.playIntent = false;
        this.playRequestStartedAt = 0;
        this.mediaState = this.audio.ended ? 'ended' : 'paused';
        this.clock.pause(pos);
        this.cancelBoundaryTimer();
        this.releaseWakeLock();
        if (this.book) this.saveState(pos);
        this.render();
      });

      this.audio.addEventListener('waiting', () => {
        // 'waiting' means the media timeline really has stopped for data. Freeze
        // the logical clock until 'playing' resumes so it cannot pause early.
        if (!this.audio.paused && this.playIntent) {
          const pos = this.actualMediaMs();
          this.mediaState = 'buffering';
          this.clock.pause(pos);
          this.cancelBoundaryTimer();
          this.render();
        }
      });

      this.audio.addEventListener('stalled', () => {
        // IMPORTANT: stalled does not necessarily mean playback stopped. The
        // v0.1.0 PWA paused its clock here and could leave it frozen while audio
        // kept playing. Do not alter playback state from this event.
        this.render();
      });

      this.audio.addEventListener('canplay', () => {
        // Do not restart the logical clock merely because data is available.
        // Resume only on 'playing' or on an advancing 'timeupdate'; this avoids
        // running the Beat clock ahead of audio during WebKit buffer recovery.
        this.render();
      });

      this.audio.addEventListener('seeking', () => {
        this.mediaState = 'seeking';
        this.clock.pause(this.actualMediaMs());
        this.cancelBoundaryTimer();
        this.render();
      });

      this.audio.addEventListener('seeked', () => {
        const pos = this.actualMediaMs();
        this.lastActualMediaMs = pos;
        if (this.playIntent && !this.audio.paused) {
          this.mediaState = 'playing';
          this.clock.setPosition(pos, true);
          this.scheduleBoundaryTimer();
        } else {
          this.mediaState = 'paused';
          this.clock.setPosition(pos, false);
        }
        this.render();
      });

      this.audio.addEventListener('timeupdate', () => {
        if (!this.book) return;
        const actual = this.actualMediaMs();
        const previousActual = this.lastActualMediaMs;
        this.lastActualMediaMs = actual;

        if (this.playIntent && !this.audio.paused) {
          // If WebKit resumed media but omitted/late-fired 'playing', an advancing
          // media timeline is definitive evidence that playback is active.
          if (this.mediaState !== 'playing' && actual > previousActual + 5) {
            this.playRequestStartedAt = 0;
            this.mediaState = 'playing';
            this.clock.setPosition(actual, true);
            this.scheduleBoundaryTimer();
          } else if (this.mediaState === 'playing' && this.clock.playing) {
            const logical = this.clock.nowMs();
            // Only re-anchor on a real media timeupdate; never repeatedly pull a
            // smooth clock backward from a coarse/stale currentTime sample.
            if (Math.abs(actual - logical) > 180) this.clock.setPosition(actual, true);
          }
          this.checkBoundary('timeupdate');
        }
      });

      this.audio.addEventListener('ratechange', () => {
        const rate = Number(this.audio.playbackRate) || Number(this.options.playbackSpeed) || 1;
        this.clock.setRate(rate);
        if (this.mediaState === 'playing' && !this.audio.paused) this.clock.setPosition(this.actualMediaMs(), true);
        this.scheduleBoundaryTimer();
      });

      this.audio.addEventListener('ended', () => {
        this.playIntent = false;
        this.playRequestStartedAt = 0;
        this.mediaState = 'ended';
        this.clock.pause(this.actualMediaMs());
        this.cancelBoundaryTimer();
        this.releaseWakeLock();
        this.saveState();
        this.render('Reached end of audio.');
      });

      this.audio.addEventListener('error', () => this.render('Audio playback error. Try reopening the MP3/MP4.'));
    }

    setOption(name, value) {
      this.options[name] = value;
      this.saveOptions();
      this.applyOptionsToUI();
      if (name === 'pauseAtBeatEnd') this.scheduleBoundaryTimer();
      this.render();
    }

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
    showLoadModal(canCancel) {
      $('cancelLoadBtn').classList.toggle('hidden', !canCancel);
      $('loadError').textContent = '';
      this.show('loadModal');
    }

    animateButtonPress(button) {
      if (!button?.classList) return;
      const ratingLike = button.classList.contains('rating') || button.dataset?.bulkScore !== undefined;
      const cls = ratingLike ? 'rating-pulse' : 'control-pulse';
      button.classList.remove(cls);
      // Restart the CSS animation even for very fast repeated taps.
      void button.offsetWidth;
      button.classList.add(cls);
      setTimeout(() => button.classList.remove(cls), ratingLike ? 240 : 190);
    }

    prepareBookCandidates(fileList, source) {
      const result = C.discoverBookSets(fileList);
      this.pendingBooks = result.books;
      const count = Array.from(fileList || []).length;
      if (source === 'folder') $('bookFolderName').textContent = count ? `${count} file(s) visible in selected folder` : 'No folder selected';
      else $('bookFilesName').textContent = count ? `${count} file(s) selected` : 'No files selected';

      const choice = $('bookChoice');
      choice.innerHTML = '';
      for (let i = 0; i < result.books.length; i++) {
        const book = result.books[i];
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = book.dir || book.audioFile.name;
        choice.appendChild(opt);
      }
      choice.value = '0';
      $('bookChoiceWrap').classList.toggle('hidden', result.books.length <= 1);
      $('loadBookBtn').disabled = result.books.length === 0;

      if (result.books.length === 1) {
        const b = result.books[0];
        $('detectedBook').textContent = `Ready: ${b.audioFile.name} · ${b.csvFile.name}${b.csvFiles?.length > 1 ? ` (newest of ${b.csvFiles.length} CSVs)` : ''} · ${b.timingFile.name}`;
        $('loadError').textContent = '';
      } else if (result.books.length > 1) {
        $('detectedBook').textContent = `Found ${result.books.length} complete book folders. Choose one below.`;
        $('loadError').textContent = '';
      } else {
        $('detectedBook').textContent = 'No complete book folder found.';
        const first = result.incomplete[0];
        $('loadError').textContent = first
          ? `Each book folder must contain exactly one MP3/MP4, at least one CSV, and exactly one JSON file. ${first.issues.join('; ')}.`
          : 'No MP3/MP4, CSV, and JSON set was found.';
      }
    }

    async loadSelectedBook() {
      const selected = Math.max(0, Math.min(Number($('bookChoice').value) || 0, this.pendingBooks.length - 1));
      const candidate = this.pendingBooks[selected];
      $('loadError').textContent = '';
      if (!candidate) {
        $('loadError').textContent = 'Choose a folder containing exactly one MP3/MP4, at least one CSV, and exactly one JSON file.';
        return;
      }
      return this.loadBookFiles(candidate.audioFile, candidate.csvFile, candidate.timingFile, candidate.exportCsvName);
    }

    async loadBookFiles(audioFile, csvFile, timingFile, exportCsvName = csvFile?.name || 'book_beats.csv') {
      try {
        const csvText = await csvFile.text();
        const parsed = C.parseCSV(csvText);
        const sourceScores = this.collectScores(parsed.rows);
        const timingPayload = JSON.parse(await timingFile.text());
        const timing = await C.validateTimings(timingPayload, parsed.rows, audioFile);
        const unitStarts = C.buildUnitStarts(parsed.rows);
        const legacyKey = C.bookStateKey(parsed.rows, audioFile.name, csvFile.name);
        const key = C.structuralBookKey(parsed.rows);
        const boundaryHash = (await C.sha256Hex(C.boundaryHashText(parsed.rows))) || key;

        this.stopPlaybackForBookChange();
        if (this.book?.audioURL) URL.revokeObjectURL(this.book.audioURL);
        const audioURL = URL.createObjectURL(audioFile);
        this.book = {
          audioFile, csvFile, timingFile, exportCsvName, headers: parsed.headers, rows: parsed.rows,
          timingStops: timing.stops, unitStarts, key, legacyKey, boundaryHash, audioURL,
          timingVersion: timing.version, sourceScores,
          backupDirty: false, backupChangeCount: 0, backupDirtySince: 0, lastExportAt: 0
        };
        this.currentIdx = 0;
        this.navUnit = this.options.defaultNavigationUnit;
        this.autoPaused = false;
        this.preRatedIdx = null;
        this.playIntent = false;
        this.mediaState = 'paused';
        this.audio.src = audioURL;
        this.audio.load();
        this.audio.playbackRate = this.options.playbackSpeed;
        await this.waitForMetadata();
        this.clock.setPosition(parsed.rows[0]._start_ms, false);
        this.lastActualMediaMs = parsed.rows[0]._start_ms;
        const saved = this.readState();
        this.restoreSavedScores(saved);
        this.initializeBackupState(saved);
        this.hide('loadModal');
        this.book.warning = timing.warnings.join(' ');
        if (saved && saved.boundaryHash === boundaryHash) {
          this.restoreProgress(saved);
          $('resumeInfo').textContent = `Saved Beat ${this.currentIdx + 1} / ${this.book.rows.length} at ${C.msToTimestamp(saved.positionMs ?? this.book.rows[this.currentIdx]._start_ms)}.`;
          this.show('resumeModal');
        } else {
          this.currentIdx = 0;
          this.preRatedIdx = null;
          this.navUnit = this.options.defaultNavigationUnit;
          await this.seekMs(this.book.rows[0]._start_ms, false);
          const started = await this.safePlay();
          const loadMessage = started
            ? `Loaded ${this.book.rows.length} Beats; playing from the first Beat.`
            : `Loaded ${this.book.rows.length} Beats. Tap Play to start.`;
          this.render(this.book.warning ? `${this.book.warning} ${loadMessage}` : loadMessage);
        }
      } catch (err) {
        console.error(err);
        $('loadError').textContent = err?.message || String(err);
      }
    }

    stopPlaybackForBookChange() {
      this.cancelBoundaryTimer();
      this.playIntent = false;
      this.pausePinMs = null;
      try { this.audio.pause(); } catch {}
      this.clock.pause(this.displayPositionMs());
      this.mediaState = 'paused';
      this.releaseWakeLock();
    }

    waitForMetadata() {
      if (this.audio.readyState >= 1) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error('Could not read audio metadata.')); };
        const cleanup = () => { clearTimeout(timer); this.audio.removeEventListener('loadedmetadata', done); this.audio.removeEventListener('error', fail); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out reading audio metadata.')); }, 15000);
        this.audio.addEventListener('loadedmetadata', done, { once: true });
        this.audio.addEventListener('error', fail, { once: true });
      });
    }

    stateKey() { return this.book ? `beat-rater:book:${this.book.key}` : null; }
    legacyStateKey() { return this.book?.legacyKey ? `beat-rater:book:${this.book.legacyKey}` : null; }

    readState() {
      if (!this.book) return null;
      try {
        const current = JSON.parse(localStorage.getItem(this.stateKey()) || 'null');
        if (current) return current;
        const legacyKey = this.legacyStateKey();
        return legacyKey ? JSON.parse(localStorage.getItem(legacyKey) || 'null') : null;
      } catch { return null; }
    }

    collectScores(rows = this.book?.rows || []) {
      const scores = {};
      rows.forEach((r, i) => {
        if (C.isRated(r)) scores[C.beatId(r, i)] = Number(r.Score);
      });
      return scores;
    }

    scoreMapsEqual(a = {}, b = {}) {
      const ak = Object.keys(a); const bk = Object.keys(b);
      if (ak.length !== bk.length) return false;
      for (const key of ak) if (Number(a[key]) !== Number(b[key])) return false;
      return true;
    }

    scoreDifferenceCount() {
      if (!this.book) return 0;
      const current = this.collectScores();
      const source = this.book.sourceScores || {};
      const keys = new Set([...Object.keys(current), ...Object.keys(source)]);
      let changed = 0;
      for (const key of keys) {
        const a = Object.prototype.hasOwnProperty.call(current, key) ? Number(current[key]) : null;
        const b = Object.prototype.hasOwnProperty.call(source, key) ? Number(source[key]) : null;
        if (a !== b) changed++;
      }
      return changed;
    }

    restoreSavedScores(state = this.readState()) {
      if (!state || state.boundaryHash !== this.book.boundaryHash || !state.scores) return;
      const byId = new Map(this.book.rows.map((r, i) => [C.beatId(r, i), i]));
      for (const [id, score] of Object.entries(state.scores)) {
        const idx = byId.get(id);
        if (idx != null && [-2,-1,0,1,2].includes(Number(score))) this.book.rows[idx].Score = String(score);
      }
    }

    initializeBackupState(state) {
      if (!this.book) return;
      const differences = this.scoreDifferenceCount();
      this.book.backupDirty = differences > 0;
      if (this.book.backupDirty) {
        this.book.backupChangeCount = Math.max(differences, Number(state?.backupChangeCount) || 0);
        this.book.backupDirtySince = Number(state?.backupDirtySince) || Number(state?.updatedAt) || Date.now();
      } else {
        this.book.backupChangeCount = 0;
        this.book.backupDirtySince = 0;
      }
      this.book.lastExportAt = Number(state?.lastExportAt) || 0;
    }

    recordScoreChanges(count = 1) {
      if (!this.book || count <= 0) return;
      const differences = this.scoreDifferenceCount();
      if (differences === 0) {
        this.book.backupDirty = false;
        this.book.backupChangeCount = 0;
        this.book.backupDirtySince = 0;
        return;
      }
      if (!this.book.backupDirty) this.book.backupDirtySince = Date.now();
      this.book.backupDirty = true;
      this.book.backupChangeCount = (Number(this.book.backupChangeCount) || 0) + count;
    }

    backupRecommended() {
      if (!this.book?.backupDirty) return false;
      return (Number(this.book.backupChangeCount) || 0) >= BACKUP_CHANGE_THRESHOLD ||
        (Number(this.book.backupDirtySince) > 0 && Date.now() - Number(this.book.backupDirtySince) >= BACKUP_TIME_THRESHOLD_MS);
    }

    markExportComplete() {
      if (!this.book) return;
      this.book.sourceScores = this.collectScores();
      this.book.backupDirty = false;
      this.book.backupChangeCount = 0;
      this.book.backupDirtySince = 0;
      this.book.lastExportAt = Date.now();
      this.saveState();
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
      const state = {
        version: 3,
        appVersion: APP_VERSION,
        boundaryHash: this.book.boundaryHash,
        currentIdx: this.currentIdx,
        beatId: C.beatId(this.book.rows[this.currentIdx], this.currentIdx),
        preRatedBeatId: this.preRatedIdx === this.currentIdx ? C.beatId(this.book.rows[this.currentIdx], this.currentIdx) : '',
        navUnit: this.navUnit,
        positionMs: Math.max(0, Math.round(positionMs ?? this.displayPositionMs())),
        scores: this.collectScores(),
        backupChangeCount: Number(this.book.backupChangeCount) || 0,
        backupDirtySince: Number(this.book.backupDirtySince) || 0,
        lastExportAt: Number(this.book.lastExportAt) || 0,
        updatedAt: Date.now()
      };
      try {
        localStorage.setItem(this.stateKey(), JSON.stringify(state));
        const legacyKey = this.legacyStateKey();
        if (legacyKey && legacyKey !== this.stateKey()) localStorage.removeItem(legacyKey);
      } catch (err) { console.warn('Could not save local checkpoint', err); }
    }

    async seekAndPlayFromUserGesture(ms) {
      // iOS can reject media playback when play() happens only after an awaited
      // seek. Call play() synchronously in the button's user-activation turn,
      // then let WebKit finish the seek while playback is already requested.
      if (!this.book) return false;
      const target = Math.max(0, Number(ms) || 0);
      this.cancelBoundaryTimer();
      this.pausePinMs = null;
      this.autoPaused = false;
      this.playIntent = true;
      this.playRequestStartedAt = Date.now();
      this.mediaState = 'starting';
      this.audio.playbackRate = this.options.playbackSpeed;
      this.clock.setRate(this.options.playbackSpeed);
      this.clock.setPosition(target, false);
      try { this.audio.currentTime = target / 1000; } catch {}
      this.render();

      let playPromise;
      try {
        playPromise = this.audio.play();
      } catch (err) {
        this.playIntent = false;
        this.playRequestStartedAt = 0;
        this.mediaState = 'paused';
        this.clock.pause(this.actualMediaMs());
        this.render('iPhone blocked playback. Tap Play once to start audio.');
        return false;
      }

      try {
        await playPromise;
        await this.waitForSeek(target);
        if (!this.audio.paused) {
          this.playRequestStartedAt = 0;
          this.mediaState = 'playing';
          this.syncPlayingClock('gesture-resume');
          this.scheduleBoundaryTimer();
          await this.requestWakeLock();
        }
        return !this.audio.paused;
      } catch (err) {
        this.playIntent = false;
        this.playRequestStartedAt = 0;
        this.mediaState = 'paused';
        this.clock.pause(this.actualMediaMs());
        this.render('iPhone blocked playback. Tap Play once to start audio.');
        return false;
      }
    }

    async startFromSaved() {
      this.hide('resumeModal');
      const target = this.savedPositionMs ?? this.book.rows[this.currentIdx]._start_ms;
      const started = await this.seekAndPlayFromUserGesture(target);
      this.saveState(target);
      this.render(this.book.warning || (started ? 'Resumed saved position; playing.' : 'Resumed saved position. Tap Play to start.'));
    }

    async startFromFirst() {
      this.hide('resumeModal');
      this.currentIdx = 0;
      this.preRatedIdx = null;
      this.navUnit = this.options.defaultNavigationUnit;
      const start = this.book.rows[0]._start_ms;
      const started = await this.seekAndPlayFromUserGesture(start);
      this.saveState(start);
      this.render(started ? 'Started at first Beat; playing.' : 'Started at first Beat. Tap Play to start.');
    }

    effectiveStopMs(idx = this.currentIdx) {
      return this.options.waveformAwareStopping ? this.book.timingStops[idx] : this.book.rows[idx]._stop_ms;
    }

    actualMediaMs() {
      const n = Number(this.audio.currentTime) * 1000;
      return Number.isFinite(n) ? Math.max(0, Math.round(n)) : Math.max(0, this.clock.nowMs());
    }

    displayPositionMs() {
      if (this.clock.playing && this.playIntent && !this.audio.paused) return this.clock.nowMs();
      if (this.book && this.audio.readyState >= 1) return this.actualMediaMs();
      return this.clock.nowMs();
    }

    displayClock(ms) {
      // The running position clock is intentionally whole-second resolution.
      // Internal boundary timing remains millisecond-accurate.
      return C.msToTimestamp(ms).replace(/[.,]\d{3}$/, '');
    }

    isPlaying() {
      // The actual media element remains the authoritative playback state.
      return !!this.book && !this.audio.paused && !this.audio.ended;
    }

    offerPauseControl() {
      // The media element is authoritative. Keep a short optimistic grace period
      // after a user taps Play so the label changes immediately, then let the
      // polling loop self-correct if WebKit remains paused or drops an event.
      if (this.isPlaying()) return true;
      if (!this.book || !this.playIntent || this.mediaState !== 'starting') return false;
      const age = Date.now() - (this.playRequestStartedAt || 0);
      return age >= 0 && age < 500;
    }

    syncPlayPauseControl() {
      const offerPause = this.offerPauseControl();
      $('playIcon').textContent = offerPause ? 'Ⅱ' : '▶';
      $('playLabel').textContent = offerPause ? 'Pause' : 'Play';
    }

    pollMediaState() {
      if (!this.book) { this.syncPlayPauseControl(); return; }
      const now = Date.now();
      const actual = this.actualMediaMs();
      const mediaPlaying = !this.audio.paused && !this.audio.ended;
      const advanced = actual > this.pollLastMediaMs + 5;
      let stateChanged = false;

      // If iOS changes the real media state without delivering the matching
      // event promptly, repair our logical state from the element itself.
      if (!this.audio.seeking && !mediaPlaying && this.mediaState !== 'ended') {
        const requestAge = this.playRequestStartedAt ? now - this.playRequestStartedAt : Number.POSITIVE_INFINITY;
        const optimistic = this.playIntent && this.mediaState === 'starting' && requestAge < 500;
        if (!optimistic && (this.playIntent || this.mediaState === 'playing' || this.clock.playing)) {
          this.playIntent = false;
          this.playRequestStartedAt = 0;
          this.mediaState = 'paused';
          this.clock.pause(actual);
          this.cancelBoundaryTimer();
          this.releaseWakeLock();
          stateChanged = true;
        }
      } else if (!this.audio.seeking && mediaPlaying && advanced) {
        if (!this.playIntent || this.mediaState !== 'playing' || !this.clock.playing) {
          this.playIntent = true;
          this.playRequestStartedAt = 0;
          this.mediaState = 'playing';
          this.clock.setRate(Number(this.audio.playbackRate) || Number(this.options.playbackSpeed) || 1);
          this.clock.setPosition(actual, true);
          this.scheduleBoundaryTimer();
          this.requestWakeLock();
          stateChanged = true;
        }
        this.checkBoundary('media-poll');
      }

      this.pollLastMediaMs = actual;
      this.pollLastMediaAt = now;
      if (stateChanged) this.render();
      else this.syncPlayPauseControl();
    }

    syncPlayingClock() {
      const pos = this.actualMediaMs();
      this.lastActualMediaMs = pos;
      this.clock.setRate(Number(this.audio.playbackRate) || Number(this.options.playbackSpeed) || 1);
      this.clock.setPosition(pos, true);
    }

    async safePlay() {
      if (!this.book) return false;
      this.playIntent = true;
      this.autoPaused = false;
      this.playRequestStartedAt = Date.now();
      this.mediaState = 'starting';
      this.audio.playbackRate = this.options.playbackSpeed;
      this.clock.setRate(this.options.playbackSpeed);
      // Update the Play/Pause control before awaiting WebKit's play promise.
      this.render();
      try {
        await this.audio.play();
        // Usually 'playing' handles the clock. This fallback covers WebKit event
        // ordering where play() resolves before our handler has observed it.
        if (!this.audio.paused && this.mediaState !== 'playing') {
          this.playRequestStartedAt = 0;
          this.mediaState = 'playing';
          this.syncPlayingClock('play-promise');
        }
        this.scheduleBoundaryTimer();
        await this.requestWakeLock();
      } catch (err) {
        this.playIntent = false;
        this.playRequestStartedAt = 0;
        this.mediaState = 'paused';
        this.clock.pause(this.actualMediaMs());
        this.render('iPhone blocked playback. Tap Play once to start audio.');
        return false;
      }
      this.render();
      return true;
    }

    pausePlayback({ manual = true, message = null } = {}) {
      if (!this.book) return;
      const pos = this.displayPositionMs();
      this.playIntent = false;
      this.playRequestStartedAt = 0;
      this.mediaState = 'paused';
      this.pausePinMs = pos;
      this.clock.pause(pos);
      this.cancelBoundaryTimer();
      this.audio.pause();
      if (manual) this.autoPaused = false;
      this.releaseWakeLock();
      this.saveState(pos);
      this.render(message ?? (manual ? 'Paused.' : 'Reached Beat pause point.'));
    }

    waitForSeek(targetMs) {
      const target = Math.max(0, Number(targetMs) || 0);
      if (!this.audio.seeking && Math.abs(this.actualMediaMs() - target) <= 75) return Promise.resolve();
      return new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.audio.removeEventListener('seeked', finish);
          resolve();
        };
        const timer = setTimeout(finish, 1500);
        this.audio.addEventListener('seeked', finish, { once: true });
      });
    }

    async seekMs(ms, playAfter) {
      if (!this.book) return;
      const target = Math.max(0, Number(ms) || 0);
      this.cancelBoundaryTimer();
      this.playIntent = false;
      this.playRequestStartedAt = 0;
      // A seek is not a Beat-boundary pause. Never leave a pinned pause value
      // behind when the element was already paused; it could corrupt the next
      // real pause event.
      this.pausePinMs = null;
      try { this.audio.pause(); } catch {}
      this.mediaState = 'seeking';
      this.clock.setPosition(target, false);
      this.audio.currentTime = target / 1000;
      await this.waitForSeek(target);
      this.clock.setPosition(this.actualMediaMs(), false);
      this.mediaState = 'paused';
      this.releaseWakeLock();
      if (playAfter) await this.safePlay();
      else this.render();
    }

    async seekToIndex(idx, playAfter = null) {
      if (!this.book) return;
      idx = Math.max(0, Math.min(idx, this.book.rows.length - 1));
      this.currentIdx = idx;
      this.preRatedIdx = null;
      this.autoPaused = false;
      const play = playAfter == null ? this.options.startPlaybackAfterJump : !!playAfter;
      const ms = this.book.rows[idx]._start_ms;
      await this.seekMs(ms, play);
      this.saveState(ms);
    }

    async handlePlayPause() {
      if (!this.book) { this.showLoadModal(false); return; }
      if (!this.audio.paused) {
        this.pausePlayback({ manual: true });
        return;
      }
      if (this.autoPaused) {
        if (this.currentIdx >= this.book.rows.length - 1) { this.render('At the final Beat boundary.'); return; }
        this.currentIdx++;
        this.preRatedIdx = null;
        this.autoPaused = false;
        await this.safePlay();
        this.saveState();
        this.render(`Continued without rating into Beat ${this.currentIdx + 1}.`);
        return;
      }
      await this.safePlay();
      this.saveState();
      this.render('Playing.');
    }

    async rateCurrent(score) {
      if (!this.book) return;
      const oldScore = String(this.book.rows[this.currentIdx].Score ?? '').trim();
      const newScore = String(score);
      this.book.rows[this.currentIdx].Score = newScore;
      if (oldScore !== newScore) this.recordScoreChanges(1);
      this.saveState();
      if (this.options.unratedReviewMode) {
        const dest = C.nextUnratedIndex(this.book.rows, this.currentIdx);
        if (dest == null) { this.render(`Saved score ${score}. No later unrated Beats remain.`); return; }
        await this.seekToIndex(dest, true);
        this.render(`Saved score ${score}; jumped to next unrated Beat ${dest + 1}.`);
        return;
      }

      const stop = this.effectiveStopMs();
      const pos = this.displayPositionMs();
      if (!this.autoPaused && pos < stop) {
        this.preRatedIdx = this.currentIdx;
        this.autoPaused = false;
        await this.safePlay();
        this.saveState();
        this.render(`Saved score ${score}.`);
        return;
      }

      this.preRatedIdx = null;
      if (this.currentIdx >= this.book.rows.length - 1) {
        this.saveState();
        this.render(`Saved score ${score}. This is the final Beat.`);
        return;
      }
      this.currentIdx++;
      this.autoPaused = false;
      await this.safePlay();
      this.saveState();
      this.render(`Saved score ${score}; continuing naturally into Beat ${this.currentIdx + 1}.`);
    }

    async skipRating() {
      if (!this.book) return;
      if (this.options.unratedReviewMode) {
        const dest = C.nextUnratedIndex(this.book.rows, this.currentIdx);
        if (dest == null) { this.render('No later unrated Beats remain.'); return; }
        await this.seekToIndex(dest, true);
        this.render(`Left score unchanged; jumped to Beat ${dest + 1}.`);
        return;
      }
      if (this.currentIdx >= this.book.rows.length - 1) { this.render('This is the final Beat.'); return; }
      this.preRatedIdx = null;
      this.currentIdx++;
      this.autoPaused = false;
      await this.safePlay();
      this.saveState();
      this.render(`Advanced without rating into Beat ${this.currentIdx + 1}.`);
    }

    setNav(unit) {
      if (!C.NAV_UNITS.includes(unit)) return;
      this.navUnit = unit;
      this.saveState();
      this.render(`Navigation set to ${unit.toUpperCase()}.`);
    }

    async goBack() {
      if (!this.book) return;
      const wasPlaying = !this.audio.paused;
      const starts = this.book.unitStarts[this.navUnit];
      const currentStart = C.currentUnitStart(starts, this.currentIdx);
      const unitStartMs = this.book.rows[currentStart]._start_ms;
      const pos = this.displayPositionMs();
      const atStart = this.currentIdx === currentStart && Math.abs(pos - unitStartMs) <= 150;
      const dest = atStart ? C.previousUnitStart(starts, this.currentIdx) : currentStart;
      if (dest == null) { this.render('Already at the first unit.'); return; }
      await this.seekToIndex(dest, wasPlaying);
      this.render(`Jumped to start of ${this.navUnit} at Beat ${dest + 1}; playback remains ${wasPlaying ? 'playing' : 'paused'}.`);
    }

    async goForward() {
      if (!this.book) return;
      if (this.navUnit === 'beat') {
        const idx = this.currentIdx;
        const stop = this.effectiveStopMs(idx);
        const wasPlaying = this.isPlaying();
        const alreadyRated = C.isRated(this.book.rows[idx]);

        // If this Beat is already scored and the listener is currently playing,
        // Beat End means "skip the rest of this rated Beat": seek to its pause
        // point and continue immediately into the next Beat. Starting playback is
        // requested in the button gesture so iOS cannot lose user activation.
        if (alreadyRated && wasPlaying) {
          this.preRatedIdx = null;
          this.autoPaused = false;
          if (idx < this.book.rows.length - 1) {
            this.currentIdx = idx + 1;
            const started = await this.seekAndPlayFromUserGesture(stop);
            this.saveState(stop);
            this.render(started
              ? `Skipped rated Beat ${idx + 1}; continuing into Beat ${this.currentIdx + 1}.`
              : `Skipped rated Beat ${idx + 1}. Tap Play to continue into Beat ${this.currentIdx + 1}.`);
          } else {
            // There is no next Beat, but do not introduce a new pause merely
            // because the final Beat was already rated.
            this.preRatedIdx = idx;
            const started = await this.seekAndPlayFromUserGesture(stop);
            this.saveState(stop);
            this.render(started ? 'Skipped to the end of the rated final Beat; playing.' : 'Skipped to the end of the rated final Beat.');
          }
          return;
        }

        // Unrated Beats, or rated Beats skipped while already paused, still land
        // at the current Beat pause point and remain paused.
        this.preRatedIdx = null;
        await this.seekMs(stop, false);
        this.clock.setPosition(stop, false);
        this.autoPaused = true;
        this.saveState(stop);
        this.render(alreadyRated
          ? 'Jumped to the end of this rated Beat; playback remains paused.'
          : 'Jumped to the current Beat pause point. Rate it or leave it unrated.');
        return;
      }

      const dest = C.nextUnitStart(this.book.unitStarts[this.navUnit], this.currentIdx);
      if (dest == null) { this.render('Already at the last unit.'); return; }
      if (this.options.promptScoreForwardSkip) {
        // Windows pauses unconditionally before presenting this prompt. Do the
        // same rather than consulting a potentially stale logical state.
        if (!this.audio.paused || this.playIntent) this.pausePlayback({ manual: true, message: 'Paused for forward-skip rating.' });
        const choice = await this.promptBulkScore(dest);
        if (choice === null) { this.render('Forward skip cancelled.'); return; }
        if (typeof choice === 'number') {
          let changed = 0;
          for (let i = this.currentIdx; i < dest; i++) {
            const next = String(choice);
            if (String(this.book.rows[i].Score ?? '').trim() !== next) changed++;
            this.book.rows[i].Score = next;
          }
          this.recordScoreChanges(changed);
          this.saveState();
        }
      }
      await this.seekToIndex(dest);
      this.render(`Jumped forward to ${this.navUnit} at Beat ${dest + 1}.`);
    }

    promptBulkScore(dest) {
      $('bulkInfo').textContent = `This ${this.navUnit} skip passes ${Math.max(0, dest - this.currentIdx)} Beat(s). Applying a score overwrites existing scores in that range.`;
      this.show('bulkModal');
      return new Promise(resolve => { this.bulkResolver = resolve; });
    }

    resolveBulk(value) {
      this.hide('bulkModal');
      if (this.bulkResolver) {
        const r = this.bulkResolver;
        this.bulkResolver = null;
        r(value);
      }
    }

    async jumpToNextUnrated(playAfter = true) {
      if (!this.book) return;
      const dest = C.nextUnratedIndex(this.book.rows, this.currentIdx);
      if (dest == null) {
        const remaining = C.unratedCount(this.book.rows);
        this.render(remaining ? `No later unrated Beats; ${remaining} remain earlier.` : 'All Beats are rated.');
        return;
      }
      await this.seekToIndex(dest, playAfter);
      this.render(`Jumped to next unrated Beat ${dest + 1} / ${this.book.rows.length}.`);
    }

    openOptions() {
      if (this.book && (!this.audio.paused || this.playIntent)) this.pausePlayback({ manual: true });
      this.applyOptionsToUI();
      this.show('optionsModal');
    }

    async exportCSV() {
      if (!this.book) return;
      const text = C.serializeCSV(this.book.headers, this.book.rows);
      const exportName = this.book.exportCsvName || this.book.csvFile.name;
      const file = new File([text], exportName, { type: 'text/csv;charset=utf-8' });
      try {
        if (navigator.canShare?.({ files: [file] })) {
          // Share the CSV file only. Supplying a title/text payload causes some
          // iOS Save to Files flows to create an unwanted companion text file.
          await navigator.share({ files: [file] });
          this.markExportComplete();
          this.render('CSV export completed. iOS may create a numbered copy; Beat Rater will use the newest CSV next time this folder is opened.');
        } else {
          const url = URL.createObjectURL(file);
          const a = document.createElement('a');
          a.href = url;
          a.download = exportName;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 3000);
          this.markExportComplete();
          this.render('CSV downloaded.');
        }
      } catch (err) {
        if (err?.name !== 'AbortError') this.render(`Export failed: ${err?.message || err}`);
      }
    }

    startLoop() {
      const frame = now => {
        if (this.book && this.playIntent && !this.audio.paused) {
          if (this.mediaState === 'playing' && this.clock.playing) this.checkBoundary('animation-frame');
          if (now - this.lastVisualUpdate >= 150) {
            this.lastVisualUpdate = now;
            this.render();
          }
          if (now - this.lastCheckpoint >= 5000) {
            this.lastCheckpoint = now;
            this.saveState(this.displayPositionMs());
          }
        }
        this.frameRequest = requestAnimationFrame(frame);
      };
      this.frameRequest = requestAnimationFrame(frame);

      // iOS occasionally delays or drops media events. Poll the real
      // HTMLAudioElement state five times per second so the Play/Pause control
      // and logical playback state can self-correct quickly.
      setInterval(() => this.pollMediaState(), 200);

      // Lower-frequency safety heartbeat. Automatic pausing does not depend on a
      // single 5 ms setInterval anymore; rAF + a boundary timeout + timeupdate +
      // this heartbeat all call the same idempotent boundary checker.
      setInterval(() => {
        if (!this.book) return;
        if (this.playIntent && !this.audio.paused) this.checkBoundary('heartbeat');
        this.render();
      }, 500);
    }

    scheduleBoundaryTimer() {
      this.cancelBoundaryTimer();
      if (!this.book || !this.playIntent || this.audio.paused || this.mediaState !== 'playing' || !this.clock.playing) return;
      const stop = this.effectiveStopMs();
      const pos = this.clock.nowMs();
      const remainingMediaMs = stop - pos;
      if (remainingMediaMs <= 0) {
        this.boundaryTimer = setTimeout(() => this.checkBoundary('boundary-timeout'), 0);
        return;
      }
      const rate = Math.max(0.1, Number(this.audio.playbackRate) || Number(this.options.playbackSpeed) || 1);
      // Re-check at least once a second on long Beats, then schedule close to the
      // expected boundary. Never intentionally stop early; the callback verifies
      // the logical clock before pausing and reschedules if it fired early.
      const delay = Math.max(4, Math.min(1000, remainingMediaMs / rate));
      this.boundaryTimer = setTimeout(() => {
        this.boundaryTimer = null;
        this.checkBoundary('boundary-timeout');
        this.scheduleBoundaryTimer();
      }, delay);
    }

    cancelBoundaryTimer() {
      if (this.boundaryTimer != null) clearTimeout(this.boundaryTimer);
      this.boundaryTimer = null;
    }

    checkBoundary(source) {
      if (!this.book || !this.playIntent || this.audio.paused) return false;
      if (this.mediaState !== 'playing' || !this.clock.playing) return false;

      const stop = this.effectiveStopMs(this.currentIdx);
      // currentTime can occasionally be a little ahead of the extrapolated
      // clock, while the logical clock is smoother between media updates. Using
      // the later of the two prevents a missed boundary without repeatedly
      // re-anchoring to coarse currentTime samples.
      const pos = Math.max(this.clock.nowMs(), this.actualMediaMs());

      if (this.preRatedIdx === this.currentIdx) {
        if (pos < stop) return false;
        if (this.currentIdx < this.book.rows.length - 1) {
          this.currentIdx++;
          this.preRatedIdx = null;
          this.autoPaused = false;
          this.saveState(pos);
          this.render(`Early-rated Beat complete; continuing into Beat ${this.currentIdx + 1}.`);
          this.scheduleBoundaryTimer();
          // If an iOS scheduling gap carried us beyond the next boundary too,
          // immediately let the new current Beat be checked on the next task.
          setTimeout(() => this.checkBoundary('post-early-transition'), 0);
        }
        return true;
      }

      if (!this.options.pauseAtBeatEnd || pos < stop) return false;

      this.autoPaused = true;
      this.playIntent = false;
      this.playRequestStartedAt = 0;
      this.mediaState = 'paused';
      this.pausePinMs = pos;
      this.clock.pause(pos);
      this.cancelBoundaryTimer();
      this.audio.pause();
      this.releaseWakeLock();
      this.saveState(pos);
      this.render('Reached Beat pause point. Rate it, leave it unrated, or navigate.');
      return true;
    }

    pauseDisplayTarget() {
      if (!this.book || !this.options.pauseAtBeatEnd) return null;
      if (this.preRatedIdx === this.currentIdx) {
        if (this.currentIdx >= this.book.rows.length - 1) return { idx: null, prefix: 'Next pause' };
        return { idx: this.currentIdx + 1, prefix: 'Next pause' };
      }
      return { idx: this.currentIdx, prefix: 'Pause' };
    }

    render(message = null) {
      if (message != null) $('message').textContent = message;
      $('versionBadge').textContent = `v${APP_VERSION}`;
      const backupBtn = $('backupBtn');
      const backupLabel = $('backupLabel');
      backupBtn.classList.toggle('hidden', !this.book);
      backupBtn.classList.remove('pending', 'recommended', 'clean');
      if (this.book) {
        if (!this.book.backupDirty) {
          backupBtn.classList.add('clean');
          backupLabel.textContent = 'Backup ✓';
          backupBtn.setAttribute?.('aria-label', 'CSV backup is current');
        } else if (this.backupRecommended()) {
          backupBtn.classList.add('recommended');
          backupLabel.textContent = 'Backup !';
          backupBtn.setAttribute?.('aria-label', 'CSV backup recommended');
        } else {
          backupBtn.classList.add('pending');
          backupLabel.textContent = 'Backup';
          backupBtn.setAttribute?.('aria-label', 'Export pending score changes');
        }
      }

      const playing = this.isPlaying();
      this.syncPlayPauseControl();

      const backLabels = {
        beat: 'Beat Start',
        scene: 'Scene Start',
        sequence: 'Seq. Start',
        movement: 'Move. Start'
      };
      $('backLabel').textContent = backLabels[this.navUnit] || 'Back';

      const forwardLabels = {
        beat: 'Beat End',
        scene: 'Next Scene',
        sequence: 'Next Seq.',
        movement: 'Next Move.'
      };
      $('forwardLabel').textContent = forwardLabels[this.navUnit] || 'Forward';

      if (!this.book) {
        $('playbackStat').textContent = 'Paused';
        $('reviewStat').textContent = 'Review OFF';
        return;
      }

      const r = this.book.rows[this.currentIdx];
      const pos = this.displayPositionMs();
      $('contextLine').textContent = `Movement ${r.Movement} • Sequence ${r.Sequence} • Scene ${r.Scene} • Beat ${r.Beat}`;
      $('beatStat').textContent = `Beat ${this.currentIdx + 1} / ${this.book.rows.length}`;
      $('scoreStat').textContent = `Score: ${C.isRated(r) ? r.Score : 'unrated'}`;
      $('unratedStat').textContent = `Unrated: ${C.unratedCount(this.book.rows)}`;
      $('positionStat').textContent = this.displayClock(pos);

      const pauseTarget = this.pauseDisplayTarget();
      if (!pauseTarget) {
        $('pauseStat').textContent = 'Auto pause OFF';
      } else if (pauseTarget.idx == null) {
        $('pauseStat').textContent = 'Next pause —';
      } else {
        const pauseRow = this.book.rows[pauseTarget.idx];
        const stop = this.effectiveStopMs(pauseTarget.idx);
        const csvStop = pauseRow._stop_ms;
        const delta = stop - csvStop;
        const beatSuffix = pauseTarget.idx !== this.currentIdx ? ` · Beat ${pauseTarget.idx + 1}` : '';
        $('pauseStat').textContent = delta
          ? `${pauseTarget.prefix} ${C.msToTimestamp(stop)}${beatSuffix} · CSV ${C.msToTimestamp(csvStop)} · ${delta > 0 ? '+' : ''}${delta} ms`
          : `${pauseTarget.prefix} ${C.msToTimestamp(stop)}${beatSuffix}`;
      }
      $('progressFill').style.width = `${Math.max(0, Math.min(100, (this.currentIdx + 1) / this.book.rows.length * 100))}%`;

      const stateText = this.mediaState === 'buffering' ? 'Buffering' : (this.mediaState === 'starting' ? 'Starting' : (playing ? 'Playing' : 'Paused'));
      $('playbackStat').textContent = `${stateText} • ${Number(this.options.playbackSpeed).toFixed(2)}×`;
      $('reviewStat').textContent = `Review ${this.options.unratedReviewMode ? 'ON' : 'OFF'}`;

      document.querySelectorAll('.nav-chip').forEach(b => b.classList.toggle('active', b.dataset.nav === this.navUnit));
    }

    async requestWakeLock() {
      if (!('wakeLock' in navigator) || document.hidden || !this.playIntent || this.audio.paused) return;
      try {
        if (this.wakeLock) return;
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      } catch { /* optional */ }
    }

    async releaseWakeLock() {
      try { await this.wakeLock?.release(); } catch {}
      this.wakeLock = null;
    }

    async registerServiceWorker() {
      if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        try {
          const registration = await navigator.serviceWorker.register('./sw.js');
          registration.update().catch(() => {});
        } catch (err) {
          console.warn('Service worker registration failed', err);
        }
      }
    }
  }

  globalThis.__beatRaterApp = new BeatRaterPWA();
})();
