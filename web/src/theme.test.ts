import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
const token = (name: string) => {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!match?.[1]) throw new Error(`no --color-${name} token`);
  return match[1];
};

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('theme', () => {
  it('has the mockup tokens', () => {
    expect(token('page').toLowerCase()).toBe('#f4f5f7');
    expect(token('accent').toLowerCase()).toBe('#2457d6');
    expect(token('accent-hover').toLowerCase()).toBe('#1a3fa0');
    expect(token('card').toLowerCase()).toBe('#ffffff');
  });

  it.each([
    ['ink', 'page'],
    ['ink', 'card'],
    ['muted', 'page'],
    ['muted', 'card'],
    ['danger', 'card'],
    ['on-accent', 'accent'],
    ['on-accent', 'accent-hover'],
    ['accent', 'card'], // links and focus rings on white
    ['accent', 'page'],
    ['accent-hover', 'card'],
    ['ink', 'accent-soft'],
    ['accent', 'accent-soft'],
    ['warn-ink', 'warn-bg'],
    ['ok-ink', 'ok-bg'],
    ['bad-ink', 'bad-bg'],
    ['info-ink', 'info-bg'],
    ['muted', 'accent-soft'],
  ])('%s on %s meets WCAG AA (4.5:1)', (foreground, background) => {
    expect(ratio(token(foreground), token(background))).toBeGreaterThanOrEqual(4.5);
  });
});
