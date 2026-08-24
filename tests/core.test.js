const assert = require('assert');
const C = require('../core.js');

assert.equal(C.timestampToMs('00:02:07,320'), 127320);
assert.equal(C.timestampToMs('00:02:07.320'), 127320);
assert.equal(C.msToTimestamp(127320), '00:02:07.320');

const sample = '\uFEFFStart_Time,Stop_Time,Movement,Sequence,Scene,Beat,Score,Beat_ID,Raw_Text\r\n00:00:00.000,00:00:01.000,1,1,1,1,,book:m0001:s0001:sc0001:b0001,"Hello, ""world"""\r\n00:00:01.001,00:00:02.000,1,1,1,2,1,book:m0001:s0001:sc0001:b0002,"line1\nline2"\r\n';
const parsed = C.parseCSV(sample);
assert.equal(parsed.rows.length, 2);
assert.equal(parsed.rows[0].Raw_Text, 'Hello, "world"');
assert.equal(parsed.rows[1].Raw_Text, 'line1\nline2');
const round = C.parseCSV(C.serializeCSV(parsed.headers, parsed.rows));
assert.equal(round.rows[0].Raw_Text, parsed.rows[0].Raw_Text);
assert.equal(round.rows[1].Raw_Text, parsed.rows[1].Raw_Text);

const rows = [
  {Movement:'1',Sequence:'1',Scene:'1',Beat:'1',Score:'',Beat_ID:'b1',_stop_ms:1000},
  {Movement:'1',Sequence:'1',Scene:'1',Beat:'2',Score:'0',Beat_ID:'b2',_stop_ms:2000},
  {Movement:'1',Sequence:'1',Scene:'2',Beat:'1',Score:'',Beat_ID:'b3',_stop_ms:3000},
  {Movement:'1',Sequence:'2',Scene:'1',Beat:'1',Score:'',Beat_ID:'b4',_stop_ms:4000},
  {Movement:'2',Sequence:'1',Scene:'1',Beat:'1',Score:'',Beat_ID:'b5',_stop_ms:5000}
];
const starts = C.buildUnitStarts(rows);
assert.deepEqual(starts.scene, [0,2,3,4]);
assert.deepEqual(starts.sequence, [0,3,4]);
assert.deepEqual(starts.movement, [0,4]);
assert.equal(C.currentUnitStart(starts.scene, 1), 0);
assert.equal(C.nextUnitStart(starts.scene, 1), 2);
assert.equal(C.previousUnitStart(starts.scene, 3), 2);
assert.equal(C.unratedCount(rows), 4);
assert.equal(C.nextUnratedIndex(rows, 0), 2);

let t = 0; const clock = new C.PlaybackClock(1, () => t);
clock.setPosition(1000, false); clock.play(); t = 250; assert.equal(clock.nowMs(), 1250);
clock.setRate(2); t = 500; assert.equal(clock.nowMs(), 1750); clock.pause(); assert.equal(clock.playing, false);

(async () => {
  const timing = await C.validateTimings({effective_stop_ms:[950,1950,2950,3950,4950], signature:{}}, rows, {name:'a.mp4',size:1});
  assert.equal(timing.stops[2], 2950);
  console.log('All core tests passed.');
})().catch(err => { console.error(err); process.exit(1); });
