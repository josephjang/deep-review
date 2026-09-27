import { maxDecodeBytes, outputLines, type WorkerOutputs } from '../../src/runtime/adapter.ts';

/** A worker's outputs given as text, handed to an adapter the way the launcher hands them over. */
export function textOutputs(stdout: string, stderr = '', finalMessage: string | null = null): WorkerOutputs {
  const bytes = Buffer.from(stdout, 'utf8');
  return { stdout: bytes.length > maxDecodeBytes ? null : stdout, stdoutLines: outputLines(bytes), stderr, finalMessage };
}
