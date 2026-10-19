/**
 * The text a Windows console tool wrote, such as the message of a
 * `taskkill` that failed (the gate of resumable runs). Such a tool writes
 * in the console's code page, which is not UTF-8 on most systems: 949 on a
 * Korean one. A process with no console has no console code page, and the
 * tool then writes in the system's OEM code page, which the registry
 * holds.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** The WHATWG encoding each OEM code page of Windows is decoded with, where `TextDecoder` has one; 437, 850 and their kin have none. */
const decoderLabels: Readonly<Record<number, string>> = {
  866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
};

/** The label `TextDecoder` takes for a code page, or null for one it cannot decode. */
function decoderLabelOf(codePage: number): string | null {
  if (codePage >= 1250 && codePage <= 1258) return `windows-${String(codePage)}`;
  return decoderLabels[codePage] ?? null;
}

/**
 * The text of a console tool's bytes: as they are when they are valid
 * UTF-8, which is also what a console set to code page 65001 writes; else
 * decoded in `oemCodePage()`, which is asked only then. A code page with
 * no decoder, or none found, leaves the UTF-8 reading, its unknown bytes
 * replaced, as before.
 */
export function consoleText(bytes: Uint8Array, oemCodePage: () => number | null): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8: the tool wrote in a code page of its own.
  }
  const codePage = oemCodePage();
  const label = codePage === null ? null : decoderLabelOf(codePage);
  if (label !== null) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // A Node built without the decoder of this code page.
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** The registry tool, by absolute path so the caller's PATH cannot substitute another. */
function regPath(): string {
  return join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'reg.exe');
}

/**
 * The OEM code page of the system, from `HKLM\SYSTEM\CurrentControlSet\
 * Control\Nls\CodePage`, or null off Windows or when it cannot be read.
 * `reg query` prints the value's name and data in ASCII whatever the code
 * page, so its own output needs no decoding.
 */
export function systemOemCodePage(): number | null {
  if (process.platform !== 'win32') return null;
  const query = spawnSync(regPath(), ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'], { windowsHide: true, timeout: 10_000, encoding: 'latin1' });
  if (query.error !== undefined || query.status !== 0) return null;
  const match = /\bOEMCP\s+REG_SZ\s+(\d+)/.exec(query.stdout);
  const codePage = match === null ? Number.NaN : Number(match[1]);
  return Number.isInteger(codePage) && codePage > 0 ? codePage : null;
}
