import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/** 生产 P3-4 唯一支持的模型与量化规格；换模型必须走新的评测与审批。 */
export const BGE_MODEL_ID = 'bge-small-zh-v1.5-onnx';
export const BGE_MODEL_DIMENSION = 512;

export interface ModelFileSpec {
  /** 相对模型目录的路径。 */
  path: string;
  /** 大写 SHA-256。 */
  sha256: string;
  bytes: number;
}

/**
 * 哈希是运行时的信任锚，必须留在代码里。
 * 模型目录里的 manifest 仅作文档和安装校验，不作为运行时信任来源。
 */
export const BGE_MODEL_FILES: readonly ModelFileSpec[] = [
  {
    path: 'config.json',
    sha256: '34FA1EA6278C257DE3CC8CE7E9BDC48647B802145A9DA0FC32E95DB620EFD04F',
    bytes: 904,
  },
  {
    path: 'tokenizer_config.json',
    sha256: '7E3BD6113F18C20975EAA8E8CC03C95B727FD83D6357F8E171E22B3736BF706D',
    bytes: 414,
  },
  {
    path: 'tokenizer.json',
    sha256: '3D09C84EBD10306706A79A8276B3AB736A40D8EC03251C7639F4E52C3A1A4F8E',
    bytes: 362_603,
  },
  {
    path: 'onnx/model_quantized.onnx',
    sha256: '99A6E522710C00220C89F8C52E0CC5AA09D4CBB1C34C0E932EAB3A9DFDC65DF3',
    bytes: 168_002,
  },
  {
    path: 'onnx/model_quantized.onnx_data',
    sha256: '952623481CA8BEEA884E3D3C9ECAF8A3C7BF1D0C21DE29E970CD31AF9D37A90B',
    bytes: 23_774_208,
  },
];

export type VerifyModelResult =
  | { ok: true }
  | { ok: false; reason: string };

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex').toUpperCase();
}

/**
 * 在加载 native runtime 之前完成完整性与大小校验。
 * 报错只使用相对路径，避免把用户目录写进日志。
 */
export async function verifyModelFiles(
  modelDir: string,
  files: readonly ModelFileSpec[] = BGE_MODEL_FILES,
): Promise<VerifyModelResult> {
  for (const file of files) {
    const path = join(modelDir, file.path);
    try {
      const info = await stat(path);
      if (info.size !== file.bytes) {
        return { ok: false, reason: `模型文件大小不符：${file.path}` };
      }
      const hash = await sha256File(path);
      if (hash !== file.sha256) {
        return { ok: false, reason: `模型文件哈希不符：${file.path}` };
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { ok: false, reason: `模型文件缺失：${file.path}` };
      }
      return { ok: false, reason: `模型文件不可读：${file.path}` };
    }
  }
  return { ok: true };
}
