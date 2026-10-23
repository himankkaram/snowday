import { describe, expect, it } from 'vitest';
import {
  ActionSchema,
  JoinSchema,
  makeRoomCode,
  parseBoardLine,
  PROTOCOL_VERSION,
} from '../shared/protocol';

const goodJoin = {
  v: PROTOCOL_VERSION,
  room: 'ab12',
  role: 'player',
  name: 'Zain',
  clientId: 'abcdef12-3456',
};

describe('JoinSchema', () => {
  it('accepts a valid join and normalises the room code', () => {
    const r = JoinSchema.parse(goodJoin);
    expect(r.room).toBe('AB12');
  });
  it.each([
    ['wrong version', { ...goodJoin, v: 99 }],
    ['long room', { ...goodJoin, room: 'ABCDE' }],
    ['empty name', { ...goodJoin, name: '   ' }],
    ['html in name', { ...goodJoin, name: '<img src=x>' }],
    ['bad role', { ...goodJoin, role: 'admin' }],
    ['short clientId', { ...goodJoin, clientId: 'x' }],
  ])('rejects %s', (_label, msg) => {
    expect(JoinSchema.safeParse(msg).success).toBe(false);
  });
});

describe('ActionSchema', () => {
  const good = { seq: 1, action: 'throw', aim: 0.2, power: 0.5, source: 'button' };
  it('accepts a valid throw', () => expect(ActionSchema.safeParse(good).success).toBe(true));
  it('rejects aim outside [-1, 1]', () =>
    expect(ActionSchema.safeParse({ ...good, aim: 2 }).success).toBe(false));
  it('rejects NaN / Infinity', () => {
    expect(ActionSchema.safeParse({ ...good, aim: NaN }).success).toBe(false);
    expect(ActionSchema.safeParse({ ...good, power: Infinity }).success).toBe(false);
  });
  it('rejects unknown actions', () =>
    expect(ActionSchema.safeParse({ ...good, action: 'hit' }).success).toBe(false));
  it('rejects non-objects', () => {
    for (const junk of [null, 'throw', 42, [], undefined])
      expect(ActionSchema.safeParse(junk).success).toBe(false);
  });
});

describe('parseBoardLine', () => {
  it('parses steer lines and clamps', () => {
    expect(parseBoardLine('S,-0.42\r')).toEqual({ kind: 'steer', value: -0.42 });
    expect(parseBoardLine('S,3')).toEqual({ kind: 'steer', value: 1 });
  });
  it('parses info lines', () =>
    expect(parseBoardLine('I,calibrated')).toEqual({ kind: 'info', text: 'calibrated' }));
  it('ignores garbage', () => {
    for (const l of ['', 'S,', 'S,abc', 'hello', '\x00\x01']) expect(parseBoardLine(l)).toBeNull();
  });
});

describe('makeRoomCode', () => {
  it('makes 4-char codes without confusable characters', () => {
    for (let i = 0; i < 200; i++) expect(makeRoomCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
  });
});
