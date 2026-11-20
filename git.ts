// Git smart HTTP: pkt-line framing, packfiles, protocol v2 and v0.
// No deltas are ever sent (plain objects only, as the client's writePack
// does); deltas in incoming packs are resolved.
import { inflateSync, deflateSync } from 'node:zlib';
import { sha1Hex, hashObject, ZERO_OID, type Repo, type Store } from './store.ts';

export function pktLine(data: string | Buffer): Buffer {
  const b = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = b.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), b]);
}
export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESP_END = Buffer.from('0002', 'ascii');

export interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer; }
export function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = []; let i = 0;
  while (i + 4 <= buf.length) {
    const lenHex = buf.subarray(i, i + 4).toString('ascii');
    if (lenHex === '0000') { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (lenHex === '0001') { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (lenHex === '0002') { out.push({ kind: 'end', payload: Buffer.alloc(0) }); i += 4; continue; }
    const len = parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

// ---- packfile ----
export interface PackObject { type: string; data: Buffer; oid: string; }
export function writePack(objects: { type: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0); head.writeUInt32BE(2, 4); head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  const typeCode: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const obj of objects) {
    const code = typeCode[obj.type] ?? 3;
    const size = obj.data.length;
    // varint: first byte low 4 bits size, then 7 bits per byte, msb continuation
    const header: number[] = [];
    let s = size;
    header.push(((code << 4) | (s & 0x0f)) | (s >> 4 ? 0x80 : 0));
    s >>= 4;
    while (s > 0) { header.push((s & 0x7f) | (s >> 7 ? 0x80 : 0)); s >>= 7; }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let byte = buf[pos]!; let value = byte & 0x0f; let shift = 4; let i = pos + 1;
  while (byte & 0x80) { byte = buf[i]!; value |= (byte & 0x7f) << shift; shift += 7; i += 1; }
  return { value, next: i };
}
export function readPack(buf: Buffer): Map<string, PackObject> {
  const out = new Map<string, PackObject>();
  if (buf.length < 12 || buf.subarray(0, 4).toString() !== 'PACK') return out;
  const count = buf.readUInt32BE(8);
  let pos = 12;
  const typeName: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  // First pass: read all objects, remembering offsets for OFS_DELTA
  interface Raw { type: number; data: Buffer; oid: string; baseOid?: string; baseOffset?: number; offset: number; }
  const raws: Raw[] = [];
  for (let n = 0; n < count; n += 1) {
    const offset = pos;
    const type = (buf[pos]! >> 4) & 0x07;
    const { value: size, next } = readVarint(buf, pos);
    pos = next;
    if (type === 6) {
      let byte = buf[pos]!; pos += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) { byte = buf[pos]!; pos += 1; value = ((value + 1) * 128) + (byte & 0x7f); }
      const baseOffset = offset - value;
      const { data, consumed } = inflateWithLength(buf.subarray(pos)); pos += consumed;
      raws.push({ type, data, oid: '', baseOffset, offset });
      continue;
    }
    if (type === 7) {
      const baseOid = buf.subarray(pos, pos + 20).toString('hex'); pos += 20;
      const { data, consumed } = inflateWithLength(buf.subarray(pos)); pos += consumed;
      raws.push({ type, data, oid: '', baseOid, offset });
      continue;
    }
    // Plain object: inflate with consumed-length tracking via a helper that
    // inflates incrementally using zlib's `inflateSync` on a window is not
    // available, so use `inflateSync` on the remaining buffer and then find
    // the compressed length by binary search on the deflate stream end:
    // Node's zlib does not expose it, so instead use a streaming inflate.
    const { data, consumed } = inflateWithLength(buf.subarray(pos));
    pos += consumed;
    const oid = hashObject(typeName[type] ?? 'blob', data);
    raws.push({ type, data, oid, offset });
  }
  // Resolve deltas, including OFS_DELTA bases found by offset.
  const byOffset = new Map<number, (typeof raws)[number]>();
  for (const raw of raws) byOffset.set(raw.offset, raw);
  const resolve = (raw: (typeof raws)[number]): { type: string; data: Buffer; oid: string } | null => {
    if (raw.type !== 6 && raw.type !== 7) return { type: typeName[raw.type] ?? 'blob', data: raw.data, oid: raw.oid };
    const baseRaw = raw.baseOid ? raws.find((r) => r.oid === raw.baseOid) : (raw.baseOffset !== undefined ? byOffset.get(raw.baseOffset) : undefined);
    if (!baseRaw) return null;
    const base = resolve(baseRaw); if (!base) return null;
    const data = applyDelta(base.data, raw.data);
    return { type: base.type, data, oid: hashObject(base.type, data) };
  };
  for (const raw of raws) {
    const obj = resolve(raw);
    if (obj) out.set(obj.oid, obj);
  }
  return out;
}

// Inflate one zlib stream; returns data and consumed bytes, using Node's
// inflateSync info:true (engine.bytesWritten), as the suite's client does.
export function inflateWithLength(buf: Buffer): { data: Buffer; consumed: number } {
  const result = inflateSync(buf, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, consumed: result.engine.bytesWritten };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVar = (): number => {
    let v = 0; let shift = 0;
    while (true) { const b = delta[pos]!; pos += 1; v |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) break; }
    return v;
  };
  readVar(); // source size
  const targetSize = readVar();
  const out: Buffer[] = [];
  while (pos < delta.length) {
    const op = delta[pos]!; pos += 1;
    if (op & 0x80) {
      let offset = 0; let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { offset |= delta[pos]! << (8 * i); pos += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { size |= delta[pos]! << (8 * i); pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
    } else if (op) {
      out.push(delta.subarray(pos, pos + op)); pos += op;
    } else throw new Error('delta opcode 0');
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta size mismatch');
  return result;
}

// ---- object reachability ----
export function collectReachable(repo: Repo, tips: string[], maxDepth?: number): Map<string, { type: string; data: Buffer }> {
  const out = new Map<string, { type: string; data: Buffer }>();
  const queue: { oid: string; gen: number }[] = tips.map((oid) => ({ oid, gen: 0 }));
  const seen = new Set<string>();
  const store = repo.objects;
  const addObject = (oid: string, gen: number) => {
    if (seen.has(oid)) return; seen.add(oid);
    const obj = store.get(oid); if (!obj) return;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      if (maxDepth !== undefined && gen >= maxDepth) return;
      const info = parseCommit(obj.data);
      for (const p of info.parents) queue.push({ oid: p, gen: gen + 1 });
      queue.push({ oid: info.tree, gen });
    } else if (obj.type === 'tree') {
      // tree entries are added via walk below
      const entries = parseTreeData(obj.data);
      for (const e of entries) queue.push({ oid: e.oid, gen });
    } else if (obj.type === 'tag') {
      const target = parseTag(obj.data);
      if (target) queue.push({ oid: target, gen });
    }
  };
  // BFS by generation so depth limiting is correct for commits; trees/blobs
  // of a commit at gen g are included even if the commit is at the boundary.
  while (queue.length) {
    const item = queue.shift()!;
    addObject(item.oid, item.gen);
  }
  return out;
}
const parseCommitCache = new WeakMap<Buffer, { tree: string; parents: string[] }>();
export function parseCommit(data: Buffer): { tree: string; parents: string[] } {
  const hit = parseCommitCache.get(data);
  if (hit) return hit;
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  const parents: string[] = []; let tree = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  const out = { tree, parents };
  parseCommitCache.set(data, out);
  return out;
}
export function parseTag(data: Buffer): string | null {
  const text = data.toString('utf8');
  for (const line of text.split('\n')) if (line.startsWith('object ')) return line.slice(7).trim();
  return null;
}
export function parseTreeData(data: Buffer): { mode: string; name: string; oid: string }[] {
  const entries: { mode: string; name: string; oid: string }[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i); const nul = data.indexOf(0, sp);
    entries.push({ mode: data.subarray(i, sp).toString(), name: data.subarray(sp + 1, nul).toString(), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    i = nul + 21;
  }
  return entries;
}
export function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur); if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') { const t = parseTag(obj.data); if (!t) return null; cur = t; continue; }
    return null;
  }
  return null;
}
