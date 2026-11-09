import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Windows + Node 24 下 fork IPC teardown 偶发 ERR_IPC_CHANNEL_CLOSED。
    // 单线程池仍覆盖全部测试，只牺牲部分并行速度，换取稳定门禁。
    ...(process.platform === 'win32'
      ? {
          pool: 'threads' as const,
          fileParallelism: false,
          poolOptions: { threads: { singleThread: true } },
        }
      : {}),
  },
});
