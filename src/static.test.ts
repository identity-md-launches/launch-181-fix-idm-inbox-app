import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

describe('A2 fixtures stay out of the app', () => {
  it('no non-test src file imports fixtures/', () => {
    const app = files(join(root, 'src')).filter(
      (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes(`${join('src', 'test')}`),
    );
    expect(app.length).toBeGreaterThan(5);
    for (const file of app) expect(readFileSync(file, 'utf8'), file).not.toMatch(/fixtures\//);
  });

  it.skipIf(!existsSync(join(root, 'dist/assets')))('the built bundle has no fixture data', () => {
    for (const file of files(join(root, 'dist/assets'))) {
      const bundled = readFileSync(file, 'utf8').includes('5a579214f4df9d8e');
      expect(bundled, file).toBe(false);
    }
  });
});
