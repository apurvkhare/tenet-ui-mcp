import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { decodePngRgba } from './png.js';

const same = (buf: Buffer): void => {
  const want = PNG.sync.read(buf);
  const got = decodePngRgba(buf);
  assert.equal(got.width, want.width);
  assert.equal(got.height, want.height);
  assert.ok(Buffer.from(got.data).equals(want.data), 'RGBA bytes differ from pngjs');
};

test('decodePngRgba matches pngjs on every story baseline', () => {
  const dir = 'snapshots/0.5.0/baselines';
  const files = readdirSync(dir).filter((f) => f.endsWith('.png'));
  assert.ok(files.length > 100);
  for (const f of files) same(readFileSync(`${dir}/${f}`));
});

test('decodePngRgba matches pngjs across colour types and bit depths', () => {
  for (const colorType of [0, 2, 4, 6] as const) {
    for (const bitDepth of [8, 16] as const) {
      const p = new PNG({ width: 37, height: 11, colorType, inputColorType: 6, inputHasAlpha: true, bitDepth });
      for (let i = 0; i < p.data.length; i++) p.data[i] = (i * 37 + (i >> 5)) & 255;
      same(PNG.sync.write(p, { colorType, inputColorType: 6, inputHasAlpha: true, bitDepth }));
    }
  }
});

test('decodePngRgba rejects what it cannot read', () => {
  assert.throws(() => decodePngRgba(Buffer.from('not a png')), /not a PNG/);
});
