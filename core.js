(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BeatRaterCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_COLUMNS = ['Start_Time', 'Stop_Time', 'Movement', 'Sequence', 'Scene', 'Beat', 'Score'];
  const NAV_UNITS = ['beat', 'scene', 'sequence', 'movement'];

  function timestampToMs(value) {
    const s = String(value || '').trim();
    const m = s.match(/^(\d+):([0-5]\d):([0-5]\d)[,.](\d{1,3})$/);
    if (!m) throw new Error(`Invalid timestamp: ${value}`);
    const ms = Number(m[4].padEnd(3, '0'));
    return Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + ms;
  }

  function msToTimestamp(ms) {
    ms = Math.max(0, Math.round(Number(ms) || 0));
    const h = Math.floor(ms / 3600000); ms %= 3600000;
    const m = Math.floor(ms / 60000); ms %= 60000;
    const s = Math.floor(ms / 1000);
    const milli = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
  }

  function parseCSV(text) {
    text = String(text ?? '');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const table = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += ch;
      } else {
        if (ch === '"') quoted = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\r' || ch === '\n') {
          if (ch === '\r' && text[i + 1] === '\n') i++;
          row.push(field); field = '';
          if (row.some(v => v !== '') || table.length === 0) table.push(row);
          row = [];
        } else field += ch;
      }
    }
    if (quoted) throw new Error('CSV ended inside a quoted field.');
    if (field !== '' || row.length) { row.push(field); table.push(row); }
    if (!table.length) throw new Error('CSV is empty.');
    const headers = table[0].map(String);
    const missing = REQUIRED_COLUMNS.filter(c => !headers.includes(c));
    if (missing.length) throw new Error(`CSV is missing required columns: ${missing.join(', ')}`);
    const rows = table.slice(1).filter(r => r.some(v => v !== '')).map((cells, idx) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
      obj._index = idx;
      obj._start_ms = timestampToMs(obj.Start_Time);
      obj._stop_ms = timestampToMs(obj.Stop_Time);
      return obj;
    });
    if (!rows.length) throw new Error('CSV contains no Beat rows.');
    return { headers, rows };
  }

  function csvEscape(value) {
    const s = String(value ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function serializeCSV(headers, rows) {
    const lines = [headers.map(csvEscape).join(',')];
    for (const r of rows) lines.push(headers.map(h => csvEscape(r[h] ?? '')).join(','));
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  function unitKey(row, idx, unit) {
    if (unit === 'beat') return String(idx);
    if (unit === 'scene') return `${row.Movement}\u001f${row.Sequence}\u001f${row.Scene}`;
    if (unit === 'sequence') return `${row.Movement}\u001f${row.Sequence}`;
    if (unit === 'movement') return String(row.Movement);
    throw new Error(`Unknown navigation unit: ${unit}`);
  }

  function buildUnitStarts(rows) {
    const out = {};
    for (const unit of NAV_UNITS) {
      const starts = [0];
      let prev = unitKey(rows[0], 0, unit);
      for (let i = 1; i < rows.length; i++) {
        const key = unitKey(rows[i], i, unit);
        if (key !== prev) { starts.push(i); prev = key; }
      }
      out[unit] = starts;
    }
    return out;
  }

  function currentUnitStart(starts, idx) {
    for (let i = starts.length - 1; i >= 0; i--) if (starts[i] <= idx) return starts[i];
    return 0;
  }

  function nextUnitStart(starts, idx) {
    const current = currentUnitStart(starts, idx);
    for (const s of starts) if (s > current) return s;
    return null;
  }

  function previousUnitStart(starts, idx) {
    const current = currentUnitStart(starts, idx);
    let prev = null;
    for (const s of starts) { if (s >= current) return prev; prev = s; }
    return prev;
  }

  function isRated(row) { return String(row.Score ?? '').trim() !== ''; }
  function unratedCount(rows) { return rows.reduce((n, r) => n + (isRated(r) ? 0 : 1), 0); }
  function nextUnratedIndex(rows, idx) {
    for (let i = idx + 1; i < rows.length; i++) if (!isRated(rows[i])) return i;
    return null;
  }

  function beatId(row, idx) { return String(row.Beat_ID ?? '').trim() || `#${idx}`; }

  function bookStateKey(rows, mediaName, csvName) {
    const id = String(rows[0]?.Beat_ID ?? '').trim();
    if (id.includes(':m')) return id.split(':m', 1)[0];
    return `${String(mediaName).replace(/\.[^.]+$/, '')}::${String(csvName).replace(/\.[^.]+$/, '')}`;
  }

  function boundaryHashText(rows) {
    let s = '';
    rows.forEach((r, i) => { s += `${String(r.Beat_ID ?? '').trim()}|${Number(r._stop_ms)}\n`; });
    return s;
  }

  async function sha256Hex(text) {
    if (!globalThis.crypto?.subtle) return null;
    const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }

  async function validateTimings(payload, rows, mediaFile) {
    if (!payload || typeof payload !== 'object') throw new Error('Timing JSON is not an object.');
    if (!Array.isArray(payload.effective_stop_ms)) throw new Error('Timing JSON has no effective_stop_ms array.');
    if (payload.effective_stop_ms.length !== rows.length) {
      throw new Error(`Timing count ${payload.effective_stop_ms.length} does not match CSV Beat count ${rows.length}.`);
    }
    const stops = payload.effective_stop_ms.map((v, i) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid effective_stop_ms at Beat ${i + 1}.`);
      return Math.round(n);
    });
    const sig = payload.signature || {};
    const warnings = [];
    if (mediaFile && sig.media_name && sig.media_name !== mediaFile.name) warnings.push(`Timing file was built for ${sig.media_name}, selected audio is ${mediaFile.name}.`);
    if (mediaFile && Number.isFinite(Number(sig.media_size)) && Number(sig.media_size) !== mediaFile.size) warnings.push('Audio file size differs from the timing-file signature.');
    if (sig.boundary_hash) {
      const actual = await sha256Hex(boundaryHashText(rows));
      if (actual && actual !== sig.boundary_hash) throw new Error('Timing JSON does not match the CSV Beat IDs/Stop_Time boundaries.');
    }
    return { stops, warnings, version: payload.version ?? null };
  }

  class PlaybackClock {
    constructor(rate = 1, perfNow = () => performance.now()) {
      this.perfNow = perfNow;
      this.rate = Number(rate) || 1;
      this.baseMs = 0;
      this.anchor = this.perfNow();
      this.playing = false;
    }
    nowMs() {
      if (!this.playing) return Math.max(0, Math.round(this.baseMs));
      return Math.max(0, Math.round(this.baseMs + (this.perfNow() - this.anchor) * this.rate));
    }
    setPosition(ms, playing = null) {
      this.baseMs = Math.max(0, Math.round(Number(ms) || 0));
      this.anchor = this.perfNow();
      if (playing !== null) this.playing = !!playing;
    }
    play() { if (!this.playing) { this.anchor = this.perfNow(); this.playing = true; } }
    pause(positionMs = null) {
      const pos = positionMs == null ? this.nowMs() : Math.max(0, Math.round(positionMs));
      this.baseMs = pos; this.anchor = this.perfNow(); this.playing = false; return pos;
    }
    setRate(rate) {
      const pos = this.nowMs(); const wasPlaying = this.playing;
      this.rate = Number(rate) || 1; this.baseMs = pos; this.anchor = this.perfNow(); this.playing = wasPlaying;
    }
  }

  return {
    REQUIRED_COLUMNS, NAV_UNITS, timestampToMs, msToTimestamp, parseCSV, serializeCSV,
    buildUnitStarts, currentUnitStart, nextUnitStart, previousUnitStart,
    isRated, unratedCount, nextUnratedIndex, beatId, bookStateKey,
    boundaryHashText, sha256Hex, validateTimings, PlaybackClock
  };
});
