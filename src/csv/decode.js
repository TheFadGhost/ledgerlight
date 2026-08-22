const UTF8_BOM = [0xef, 0xbb, 0xbf];

function toUint8Array(buffer) {
  if (buffer instanceof Uint8Array) return buffer;
  return new Uint8Array(buffer ?? []);
}

/**
 * Decode a file buffer to text, detecting BOM-prefixed UTF-8 / UTF-16 LE / BE
 * and falling back from strict UTF-8 to windows-1252 when bytes are invalid.
 * Returns { text, encoding } with encoding in
 * 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252'.
 */
export function decodeBuffer(buffer) {
  const bytes = toUint8Array(buffer);

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2]
  ) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}
