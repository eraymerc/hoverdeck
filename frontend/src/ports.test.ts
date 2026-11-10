// Run with `npm test` (node --test). Excluded from tsc, like wires.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { placeOnSymbol, PORT_PITCH, type LogicArg, type LogicSlot } from './ports.ts';

// A vertical source: pins up and down, viewBox 40 x 64 around the origin.
const sourceBox: [number, number, number, number] = [-20, -32, 40, 64];
const sourceSlot: LogicSlot[] = [{ name: '', aliases: [], flow: 'in', x: -16, y: 0, dir: 'left' }];

// The motor: pins up, four named outputs on its rail.
const motorBox: [number, number, number, number] = [-32, -32, 64, 56];
const motorSlots: LogicSlot[] = ['omega_m_out', 'i_d_out', 'i_q_out', 'theta_e_out'].map((name, i) =>
  ({ name, aliases: [], flow: 'out', x: -24 + 16 * i, y: 24, dir: 'down' }));

const ins = (n: number): LogicArg[] => Array.from({ length: n }, (_, i) => ({ arg: i, name: '', flow: 'in' as const }));

test('layer 1: a source takes its control input where its symbol says', () => {
  const p = placeOnSymbol(sourceBox, ['up', 'down'], sourceSlot, ins(1));
  assert.deepEqual(p.ports, [{ arg: 0, x: -16, y: 0, dir: 'left' }]);
  assert.deepEqual(p.rails, []);
});

test('layer 1: the motor\'s outputs land on their named places, whatever order they are passed in', () => {
  const args: LogicArg[] = [
    { arg: 0, name: 'theta_e_out', flow: 'out' },
    { arg: 1, name: 'omega_m_out', flow: 'out' },
  ];
  const p = placeOnSymbol(motorBox, ['up'], motorSlots, args);
  assert.deepEqual(p.ports.map((q) => [q.arg, q.x]), [[0, 24], [1, -24]]);
  assert.deepEqual(p.slots.sort(), ['omega_m_out', 'theta_e_out']);
});

test('layer 2: without places, ports go on free sides — inputs left first', () => {
  const p = placeOnSymbol(sourceBox, ['up', 'down'], [], ins(2));
  assert.ok(p.ports.every((q) => q.dir === 'left' && q.x === -20));
  assert.equal(Math.abs(p.ports[0].y - p.ports[1].y), PORT_PITCH);
  assert.deepEqual(p.rails, []);
});

test('layer 2: a full side spills onto the next free one, never onto a pin side', () => {
  // The left side of a 64-tall source holds 4; the fifth goes right.
  const p = placeOnSymbol(sourceBox, ['up', 'down'], [], ins(5));
  assert.equal(p.ports.filter((q) => q.dir === 'left').length, 4);
  assert.equal(p.ports.filter((q) => q.dir === 'right').length, 1);
  assert.ok(!p.ports.some((q) => q.dir === 'up' || q.dir === 'down'));
  assert.deepEqual(p.rails, []);
});

test('layer 3: when every free side is full, a rail carries the row on past the symbol', () => {
  const p = placeOnSymbol(sourceBox, ['up', 'down'], [], ins(10));
  assert.equal(p.ports.length, 10);
  assert.equal(p.rails.length, 1);
  const [x1, y1, x2, y2] = p.rails[0];
  assert.equal(x1, x2, 'a vertical rail on a vertical side');
  assert.ok(Math.min(y1, y2) < -32 || Math.max(y1, y2) > 32, 'it runs past the symbol');
  // Every port is a pitch from its neighbours on its line.
  const left = p.ports.filter((q) => q.dir === 'left').map((q) => q.y).sort((a, b) => a - b);
  left.slice(1).forEach((y, i) => assert.equal(y - left[i], PORT_PITCH));
});

test('layer 3 with no free side: the rail stands off, with a stem', () => {
  const p = placeOnSymbol(sourceBox, ['up', 'down', 'left', 'right'], [], ins(2));
  assert.equal(p.rails.length, 2, 'the rail and its stem');
  assert.ok(p.ports.every((q) => q.x === -36), 'off the left side by the rail offset');
});

test('ports turn with the symbol: they are placed in its own coordinates', () => {
  // The same call gives the same local answer; the canvas applies the
  // block's rotation to ports exactly as it does to pins.
  const a = placeOnSymbol(sourceBox, ['up', 'down'], sourceSlot, ins(1));
  const b = placeOnSymbol(sourceBox, ['up', 'down'], sourceSlot, ins(1));
  assert.deepEqual(a, b);
});
