// 只跑基準測量（tests/bench/*.measure.ts）；`npm test` 的預設比對只收 *.test.ts，所以這些不進 CI。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/bench/**/*.measure.ts'],
  },
});
