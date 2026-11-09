import { redact } from './redact.ts';

function clock(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function info(message: string): void {
  console.log(`[${clock()}] ${redact(message)}`);
}

export function warn(message: string): void {
  console.warn(`[warn ${clock()}] ${redact(message)}`);
}

export function error(message: string): void {
  console.error(`[error ${clock()}] ${redact(message)}`);
}
