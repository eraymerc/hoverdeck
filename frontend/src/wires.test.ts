// Run with `npm test` (node --test). Excluded from tsc: there are no Node
// type definitions in this project, and none are needed to run it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoRoute, reconcile, normalize, junctions, bends, connected, sameDrawing, labelAnchor,
  moveSegment, moveCorner, splitAt, removePoint, dragEnd, rewirePin, separateAt,
  type Seg, type Terminal, type Pt,
} from './wires.ts';

const clear = () => true;
const term = (x: number, y: number, dir: Terminal['dir'], blockId = 'b' + x + y): Terminal =>
  ({ x, y, dir, blockId, box: null });
const pinsOf = (ts: Terminal[]): Pt[] => ts.map((t) => [t.x, t.y]);
const has = (segs: Seg[], s: Seg) => normalize(segs).some((q) => sameDrawing([q], [s]));

// The net from issue.png: the transistor's emitter (pointing down) and R4's
// top (pointing up) share a column; R5's bottom (pointing down) is to the
// right and higher up.
const emitter = term(616, -64, 'down', 'Q');
const r4 = term(616, -8, 'up', 'R4');
const r5 = term(768, -136, 'down', 'R5');
const issueNet = [r4, r5, emitter];

test('normalize merges overlapping runs and splits at T junctions', () => {
  const out = normalize([[0, 0, 64, 0], [32, 0, 96, 0], [48, 0, 48, 32]]);
  assert.deepEqual(out, [[0, 0, 48, 0], [48, 0, 48, 32], [48, 0, 96, 0]]);
});

test('normalize keeps a split point between two touching runs', () => {
  assert.equal(normalize([[0, 0, 32, 0], [32, 0, 64, 0]]).length, 2);
});

test('auto route of the issue.png net is a single T with a dot', () => {
  const segs = autoRoute(issueNet, clear);
  assert.ok(connected(segs, pinsOf(issueNet)));
  // Emitter and R4 meet in their own column, R5 comes down and across once.
  assert.ok(has(segs, [616, -48, 616, -24]) || has(segs, [616, -48, 616, -8]));
  assert.ok(has(segs, [616, -48, 768, -48]));
  const dots = junctions(segs, pinsOf(issueNet));
  assert.deepEqual(dots, [[616, -48]]);
  // No run to the side for the two pins that are already lined up.
  assert.ok(!segs.some((s) => s[1] === s[3] && s[1] !== -48));
});

test('a vertical leg does not run on through another block', () => {
  const blocked = (x: number, y1: number, y2: number) => !(x === 768 && Math.min(y1, y2) < -60);
  const segs = autoRoute(issueNet, blocked);
  assert.ok(connected(segs, pinsOf(issueNet)));
  // R5 turns at the end of its stub instead of running down to -48.
  assert.ok(has(segs, [616, -120, 768, -120]));
});

test('reconcile leaves a drawing that still fits its pins alone', () => {
  const segs = autoRoute(issueNet, clear);
  assert.ok(sameDrawing(reconcile(segs, issueNet, clear), segs));
});

test('moving one block redraws only its branch', () => {
  const frozen = autoRoute(issueNet, clear);
  const r5moved = term(800, -136, 'down', 'R5');
  const next = reconcile(frozen, [r4, r5moved, emitter], clear);
  assert.ok(connected(next, pinsOf([r4, r5moved, emitter])));
  // The emitter–R4 part is untouched...
  assert.ok(has(next, [616, -64, 616, -48]));
  // ...the old branch to R5 is gone, and a new one reaches it.
  assert.ok(!next.some((s) => (s[0] === 768 && s[2] === 768)));
  assert.ok(next.some((s) => s[0] === 800 || s[2] === 800));
});

test('a pin added in the source attaches to the nearest segment', () => {
  const frozen = autoRoute(issueNet, clear);
  const extra = term(700, 0, 'up', 'C9');
  const next = reconcile(frozen, [...issueNet, extra], clear);
  assert.ok(connected(next, pinsOf([...issueNet, extra])));
  // Straight up from the pin onto the run at y = -48, as one segment.
  assert.ok(has(next, [700, -48, 700, 0]));
});

test('a pin removed from the net has its branch pruned', () => {
  const frozen = autoRoute(issueNet, clear);
  const next = reconcile(frozen, [r4, emitter], clear);
  assert.ok(connected(next, pinsOf([r4, emitter])));
  assert.ok(!next.some((s) => s[0] === 768 || s[2] === 768));
});

test('a bent line can be moved sideways', () => {
  // R5's leg: down from its pin, then left along y = -48. Its vertical part
  // — one segment, pin to bend — is the "bent line" that could not move.
  const segs = autoRoute(issueNet, clear);
  const i = segs.findIndex((s) => s[0] === 768 && s[2] === 768 && Math.min(s[1], s[3]) === -136 && Math.max(s[1], s[3]) === -48);
  assert.ok(i >= 0, 'the vertical part of the R5 leg');
  const next = moveSegment(segs, i, 32, pinsOf(issueNet));
  assert.ok(connected(next, pinsOf(issueNet)));
  assert.ok(next.some((s) => s[0] === 800 && s[2] === 800), 'it now runs at x = 800');
});

test('moving a segment between two pins keeps both lead-outs and steps in between', () => {
  const pins: Pt[] = [[0, 0], [64, 0]];
  const next = moveSegment([[0, 0, 64, 0]], 0, 32, pins);
  assert.ok(connected(next, pins));
  assert.ok(sameDrawing(next, [[0, 0, 16, 0], [16, 0, 16, 32], [16, 32, 48, 32], [48, 0, 48, 32], [48, 0, 64, 0]]));
});

test('a short segment on a pin moves with a connector at the pin itself', () => {
  const pins: Pt[] = [[0, 0]];
  const next = moveSegment([[0, 0, 16, 0]], 0, 8, pins);
  assert.ok(has(next, [0, 0, 0, 8]) && has(next, [0, 8, 16, 8]));
});

test('automatic routes have no bend handles on straight runs', () => {
  const segs = autoRoute(issueNet, clear);
  const straight = bends(segs, pinsOf(issueNet)).filter(([x, y]) => {
    const at = segs.filter((s) => (s[0] === x && s[1] === y) || (s[2] === x && s[3] === y));
    return at.length === 2 && (at[0][1] === at[0][3]) === (at[1][1] === at[1][3]);
  });
  assert.deepEqual(straight, []);
});

test("an edited drawing keeps the split points its user made", () => {
  const pins: Pt[] = [[0, 0], [64, 0]];
  const split: Seg[] = [[0, 0, 32, 0], [32, 0, 64, 0]];
  const t = (x: number): Terminal => term(x, 0, x === 0 ? 'right' : 'left');
  assert.equal(reconcile(split, [t(0), t(64)], clear).length, 2);
  assert.ok(connected(split, pins));
});

test('moving a segment stretches the wires at right angles to it', () => {
  const pins: Pt[] = [[0, 0], [64, 64]];
  const segs: Seg[] = [[0, 0, 32, 0], [32, 0, 32, 64], [32, 64, 64, 64]];
  const next = moveSegment(segs, 1, 16, pins);
  assert.ok(sameDrawing(next, [[0, 0, 48, 0], [48, 0, 48, 64], [48, 64, 64, 64]]));
});

test('a bend moves in both directions', () => {
  const pins: Pt[] = [[0, 0], [64, 64]];
  const segs: Seg[] = [[0, 0, 0, 32], [0, 32, 64, 32], [64, 32, 64, 64]];
  // Drag the bend at (0, 32): the pin at (0, 0) cannot follow, so a
  // connector forms there; the other side stretches.
  const next = moveCorner(segs, [0, 32], 16, 8, pins);
  assert.ok(connected(next, pins));
  assert.ok(bends(next, pins).some(([x, y]) => x === 16 && y === 40));
});

test('split, then drag the middle: a step around an obstacle', () => {
  const pins: Pt[] = [[0, 0], [96, 0]];
  let segs: Seg[] = [[0, 0, 96, 0]];
  segs = splitAt(segs, 0, 31, 0, pins);
  segs = splitAt(segs, segs.findIndex((s) => s[0] === 32 || s[2] === 32 && s[0] !== 0), 64, 0, pins);
  assert.equal(segs.length, 3);
  const mid = segs.findIndex((s) => Math.min(s[0], s[2]) === 32);
  segs = moveSegment(segs, mid, -24, pins);
  assert.ok(connected(segs, pins));
  assert.ok(has(segs, [32, -24, 64, -24]));
  assert.ok(has(segs, [0, 0, 32, 0]) && has(segs, [64, 0, 96, 0]));
});

test('double-clicking a bend takes out its shorter side', () => {
  const pins: Pt[] = [[0, 0], [96, 16]];
  // A small step: across, down 16, across.
  const segs: Seg[] = [[0, 0, 48, 0], [48, 0, 48, 16], [48, 16, 96, 16]];
  const next = removePoint(segs, [48, 0], pins);
  assert.ok(connected(next, pins));
  assert.ok(!next.some((s) => s[0] === 48 && s[2] === 48), 'the 16px jog is gone');
});

test('double-clicking a split point merges it back', () => {
  const pins: Pt[] = [[0, 0], [64, 0]];
  const next = removePoint([[0, 0, 32, 0], [32, 0, 64, 0]], [32, 0], pins);
  assert.deepEqual(next, [[0, 0, 64, 0]]);
});

test('pins are never moved, bent or removed', () => {
  const pins: Pt[] = [[0, 0], [64, 0]];
  const segs: Seg[] = [[0, 0, 64, 0]];
  assert.equal(moveCorner(segs, [0, 0], 8, 8, pins), segs);
  assert.equal(removePoint(segs, [0, 0], pins), segs);
});

test('the label sits on the wire, not on a pin', () => {
  const segs = autoRoute(issueNet, clear);
  // R5's pin is the highest point; the label goes on the junction instead.
  assert.deepEqual(labelAnchor(segs, pinsOf(issueNet)), [616, -48]);
});

test('an automatic channel steps aside from a block it would run through', () => {
  // Three blocks stacked in one column, each read from the top by a chip
  // above — the channel would run straight down through them.
  const chip = term(0, 0, 'down', 'chip');
  const ts = [chip, term(0, 64, 'up', 'A'), term(0, 160, 'up', 'B'), term(0, 256, 'up', 'C')];
  // Each block occupies x -24..24 and the 64px above the next pin.
  const blocks = [{ id: 'A', y: 64 }, { id: 'B', y: 160 }, { id: 'C', y: 256 }];
  const columnClear = (x: number, y1: number, y2: number, own: string) =>
    !blocks.some((b) => b.id !== own && x > -24 && x < 24 && Math.max(y1, y2) > b.y && Math.min(y1, y2) < b.y + 64);
  const segs = autoRoute(ts, columnClear);
  assert.ok(connected(segs, pinsOf(ts)));
  const channel = segs.find((s) => s[0] === s[2] && Math.abs(s[3] - s[1]) > 64)!;
  assert.ok(channel, 'a long vertical channel');
  assert.ok(Math.abs(channel[0]) >= 24, `the channel at x = ${channel[0]} clears the blocks`);
});

// ── Moving a block: the wire stretches, Simulink-style ──

// An edited two-pin wire, as in the FOC sheet: out of a pin pointing up,
// across, and down into another pin pointing up.
const twoPin: Seg[] = [[0, 0, 0, -32], [0, -32, 160, -32], [160, -32, 160, 0]];
const twoPins: Pt[] = [[0, 0], [160, 0]];

test('moving a block along its lead only lengthens the lead', () => {
  // The block with the pin at (160, 0) moves up 16: its lead shortens.
  const next = dragEnd(twoPin, [160, 0], [160, -16], [[0, 0]])!;
  assert.ok(sameDrawing(next, [[0, 0, 0, -32], [0, -32, 160, -32], [160, -32, 160, -16]]));
});

test('moving a block sideways slides its lead and stretches the run', () => {
  const next = dragEnd(twoPin, [160, 0], [208, 0], [[0, 0]])!;
  // The rest of the wire is untouched; the run across simply gets longer.
  assert.ok(sameDrawing(next, [[0, 0, 0, -32], [0, -32, 208, -32], [208, -32, 208, 0]]));
});

test('moving a block diagonally keeps the shape', () => {
  const next = dragEnd(twoPin, [160, 0], [192, -64], [[0, 0]])!;
  assert.ok(connected(next, [[0, 0], [192, -64]]));
  // Still three segments: up, across, and the lead into the moved pin.
  assert.equal(next.length, 3);
  assert.ok(has(next, [0, 0, 0, -32]), 'the far pin\'s lead is untouched');
});

test('when the far end is another pin, a connector keeps it in place', () => {
  // A straight pin-to-pin wire: moving one block up makes a step.
  const straight: Seg[] = [[0, 0, 96, 0]];
  const next = dragEnd(straight, [96, 0], [96, -32], [[0, 0]])!;
  assert.ok(connected(next, [[0, 0], [96, -32]]));
  assert.ok(has(next, [0, 0, 0, -32]), 'a connector at the fixed pin');
});

test('dragEnd declines a pin the wire is not attached to', () => {
  assert.equal(dragEnd(twoPin, [999, 999], [1000, 1000], twoPins), null);
});

// ── Turning a block: new bends to the ports where they now are ──

// A vertical resistor centred on the origin, pins at (0, ±32). Its top pin's
// wire goes up to y = -64 and off to the right, to a pin at (96, -64).
const resistorBox = { x: -16, y: -32, w: 32, h: 64 };
const topWire: Seg[] = [[0, -32, 0, -64], [0, -64, 96, -64]];

test('turning a block keeps the wire and bends round to the new port', () => {
  // Rotated a quarter turn: the top pin is now at (32, 0), facing right.
  const turnedBox = { x: -32, y: -16, w: 64, h: 32 };
  const next = rewirePin(topWire, [0, -32], 'up', [32, 0], 'right', [[96, -64]], turnedBox)!;
  assert.ok(connected(next, [[32, 0], [96, -64]]));
  // The far part of the wire is untouched.
  assert.ok(has(next, [0, -64, 96, -64]) || next.some((s) => s[1] === -64 && s[3] === -64 && Math.max(s[0], s[2]) === 96));
  // The new port is left along its new direction.
  assert.ok(next.some((s) => (s[0] === 32 && s[1] === 0 && s[3] === 0 && s[2] > 32) || (s[2] === 32 && s[3] === 0 && s[1] === 0 && s[0] > 32)));
  // And no new segment cuts through the turned block.
  const inside = (s: Seg) => Math.max(s[0], s[2]) > turnedBox.x && Math.min(s[0], s[2]) < turnedBox.x + turnedBox.w &&
    Math.max(s[1], s[3]) > turnedBox.y && Math.min(s[1], s[3]) < turnedBox.y + turnedBox.h;
  assert.deepEqual(next.filter(inside), [], 'nothing through the block');
});

test('mirroring a block re-attaches to the mirrored port', () => {
  // Mirrored left-right, a pin on the right edge facing right moves to the left facing left.
  const wire: Seg[] = [[32, 0, 96, 0]];
  const next = rewirePin(wire, [32, 0], 'right', [-32, 0], 'left', [[96, 0]], { x: -32, y: -16, w: 64, h: 32 })!;
  assert.ok(connected(next, [[-32, 0], [96, 0]]));
});

test('rewirePin declines a pin the wire is not attached to', () => {
  assert.equal(rewirePin(topWire, [9, 9], 'up', [10, 10], 'left', [], resistorBox), null);
});

// ── Separating and merging ──

test('double-click on a horizontal run pushes its left part down into a step', () => {
  const pins: Pt[] = [[0, 0], [96, 0]];
  const next = separateAt([[0, 0, 96, 0]], 0, 50, 0, pins);
  assert.ok(connected(next, pins));
  // The pin keeps its lead-out; the left part runs 16 lower; a jog at x = 48.
  assert.ok(sameDrawing(next, [[0, 0, 16, 0], [16, 0, 16, 16], [16, 16, 48, 16], [48, 0, 48, 16], [48, 0, 96, 0]]));
});

test('double-click on a vertical run pushes its upper part to the left', () => {
  const pins: Pt[] = [[0, 0], [0, 96]];
  const next = separateAt([[0, 0, 0, 96]], 0, 0, 48, pins);
  assert.ok(connected(next, pins));
  assert.ok(has(next, [-16, 16, -16, 48]), 'the upper part runs 16 to the left');
});

test('dragging a separated part back into line merges it into one run', () => {
  const pins: Pt[] = [[0, 0], [96, 0]];
  const step = separateAt([[0, 0, 96, 0]], 0, 48, 0, pins);
  const low = step.findIndex((s) => s[1] === 16 && s[3] === 16);
  const back = moveSegment(step, low, -16, pins);
  assert.deepEqual(back, [[0, 0, 96, 0]]);
});

test('a run dragged on top of another merges with it', () => {
  // A U under two pins; lifting its bottom up onto the pins' line leaves one run.
  const pins: Pt[] = [[0, 0], [64, 0]];
  const u: Seg[] = [[0, 0, 0, 32], [0, 32, 64, 32], [64, 32, 64, 0]];
  const flat = moveSegment(u, 1, -32, pins);
  assert.deepEqual(flat, [[0, 0, 64, 0]]);
});

test('merging never swallows a junction', () => {
  // A T whose stem is dragged sideways: the junction slides along with it,
  // and the run it sits on stays split there — merged straight through, the
  // junction would lose its dot.
  const pins: Pt[] = [[0, 0], [64, 0], [32, 32]];
  const t: Seg[] = [[0, 0, 32, 0], [32, 0, 64, 0], [32, 0, 32, 32]];
  const next = moveSegment(t, 2, 16, pins);
  assert.ok(connected(next, pins));
  assert.ok(!next.some((s) => s[1] === 0 && s[3] === 0 && Math.min(s[0], s[2]) === 0 && Math.max(s[0], s[2]) === 64),
    'the run is not merged through the junction');
  assert.deepEqual(junctions(next, pins), [[48, 0]]);
});

test('separating never folds away a pin lead: it pushes the other way instead', () => {
  // The FOC case: a pin at (80, 48) facing up, a 16px lead to (80, 32), and
  // the run going right. Pushing the left part down would land it on the pin.
  const pins: Pt[] = [[80, 48], [288, 64]];
  const wire: Seg[] = [[80, 32, 80, 48], [80, 32, 288, 32], [288, 32, 288, 64]];
  const next = separateAt(wire, 1, 112, 32, pins);
  assert.ok(connected(next, pins));
  const lead = next.find((s) => (s[0] === 80 && s[1] === 48) || (s[2] === 80 && s[3] === 48))!;
  assert.ok(lead[0] === lead[2] && Math.min(lead[1], lead[3]) < 48, 'the pin still leaves upwards');
  assert.ok(next.some((s) => s[1] === 16 && s[3] === 16), 'the left part went up instead');
  // And dragged back into line, it is one run again.
  const up = next.findIndex((s) => s[1] === 16 && s[3] === 16);
  const back = moveSegment(next, up, 16, pins);
  assert.ok(sameDrawing(back, wire));
});
