import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = ['styles.css', 'review.css', 'ui.css']
  .map((file) => readFileSync(`${process.cwd()}/src/${file}`, 'utf8'))
  .join('');

describe('responsive CSS contract', () => {
  it('has focus, sizing and overflow protections', () => {
    expect(css).toContain(':focus-visible');
    expect(css).toMatch(/outline:\s*3px/);
    expect(css).toContain('100dvh');
    expect(css).toMatch(/min-height:\s*44px/);
    expect(css).toMatch(/html,\s*body\s*\{\s*overflow-x:\s*hidden/);
    expect(css).not.toMatch(/(?<!max-)width:\s*(?:36[1-9]|3[7-9]\d|[4-9]\d\d)px/);
  });

  it('bounds the tip dialog and wallet picker to the available width at 360 px', () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    for (const selector of ['.dialog', '.wallet-picker']) {
      const declarations = rules
        .filter(([, selectors]) => selectors.split(',').map((s) => s.trim()).includes(selector))
        .map(([, , body]) => body)
        .join(';');
      expect(declarations).toMatch(/max-width:\s*100%/);
      for (const [, width] of declarations.matchAll(/(?:^|;)\s*width:\s*(\d+)px/g)) {
        expect(Number(width)).toBeLessThanOrEqual(360);
      }
    }
    expect(css).toMatch(/\.dialog\s*\{[^}]*width:\s*min\(500px,\s*100%\)/);
    expect(css).toMatch(/\.dialog-backdrop\s*\{[^}]*padding:\s*16px/);
  });
});
