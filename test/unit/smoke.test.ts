import { describe, expect, it } from 'vitest';

// Placeholder until phase 1 brings real tests, but it still asserts something that
// can fail: storage uses node:sqlite, which only exists on Node 22.13 and newer
// (D-002). If the toolchain ever runs on an older runtime, this is the first thing
// to go red rather than a confusing failure deep in the repository layer.
describe('runtime', () => {
  it('runs on a Node version that ships node:sqlite', async () => {
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);

    expect(major > 22 || (major === 22 && minor >= 13)).toBe(true);
    await expect(import('node:sqlite')).resolves.toHaveProperty('DatabaseSync');
  });
});
