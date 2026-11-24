import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// README 的安裝指令要釘在這一版：v0.91.0 公開時還寫著 #v0.89.0，照貼的人會裝到舊版
describe('README 的安裝 tag 跟著版號走', () => {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
  for (const file of ['README.md', 'README.zh-TW.md']) {
    it(file, () => {
      const tags = [...readFileSync(file, 'utf8').matchAll(/cinderous-sdk#v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
      expect(tags.length).toBeGreaterThan(0);
      expect(new Set(tags)).toEqual(new Set([version]));
    });
  }
});
