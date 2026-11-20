// Forge server: git smart HTTP, REST v3, GraphQL v4, MCP, one process,
// in-memory store, deterministic timestamps (see store.ts).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, ZERO_OID, hashObject, type Repo, type Issue, type Pull } from './store.ts';
import { pktLine, FLUSH, DELIM, parsePktLines, writePack, readPack, parseCommit, parseTreeData, peelToCommit } from './git.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';

type Json = Record<string, unknown>;
function isJson(v: unknown): v is Json { return typeof v === 'object' && v !== null && !Array.isArray(v); }

let reqSeq = 0;
function nextReqId(): string { reqSeq += 1; return `req-${reqSeq.toString(16).padStart(8, '0')}`; }

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': nextReqId(), ...extra });
  res.end(text);
}
function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 64 * 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJsonBody(buf: Buffer): unknown {
  if (buf.length === 0) return {};
  return JSON.parse(buf.toString('utf8'));
}
function pathParts(req: IncomingMessage): string[] {
  try {
    const u = new URL(req.url ?? '/', 'http://entry');
    return u.pathname.split('/').filter((s) => s.length > 0).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  } catch { return []; }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); }
}
function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}
function authed(req: IncomingMessage, store: Store): boolean {
  if (!TOKEN) return true;
  const h = req.headers['authorization'];
  const v = Array.isArray(h) ? h[0] : h;
  return v === `Bearer ${TOKEN}`;
}
function linkHeader(req: IncomingMessage, path: string, page: number, perPage: number, hasNext: boolean): Record<string, string> {
  if (!hasNext) return {};
  const q = new URLSearchParams();
  q.set('per_page', String(perPage)); q.set('page', String(page + 1));
  return { link: `<${originOf(req)}${path}?${q.toString()}>; rel="next"` };
}

// ---- shared domain helpers ----

function viewerEmail(store: Store): string { return `${store.viewer()}@example.invalid`; }

function makeCommit(store: Store, repo: Repo, branchRef: string, files: Map<string, string>, message: string): string {
  const tip = repo.refs.get(branchRef) ?? null;
  const treeOid = store.buildTree(repo, files);
  const stamp = store.commitStamp();
  const who = `${store.viewer()} <${viewerEmail(store)}> ${stamp} +0000`;
  let text = `tree ${treeOid}\n`;
  if (tip) text += `parent ${tip}\n`;
  text += `author ${who}\ncommitter ${who}\n\n${message}\n`;
  const oid = store.putObject(repo, 'commit', Buffer.from(text, 'utf8'));
  repo.refs.set(branchRef, oid);
  return oid;
}

function findMergeBase(store: Store, repo: Repo, a: string, b: string): string | null {
  const anc = new Set<string>();
  const qa = [a]; let ia = 0;
  while (ia < qa.length) { const oid = qa[ia++]!; if (anc.has(oid)) continue; anc.add(oid); const info = store.commitInfo(repo, oid); if (info) for (const p of info.parents) qa.push(p); }
  const qb = [b]; let ib = 0;
  while (ib < qb.length) { const oid = qb[ib++]!; if (anc.has(oid)) return oid; const info = store.commitInfo(repo, oid); if (info) for (const p of info.parents) qb.push(p); }
  return null;
}

function diffPaths(store: Store, repo: Repo, baseSha: string, headSha: string): { path: string; status: 'added' | 'modified' | 'removed'; baseOid: string | null; headOid: string | null }[] {
  const base = baseSha ? store.filesAt(repo, baseSha) : new Map<string, string>();
  const head = headSha ? store.filesAt(repo, headSha) : new Map<string, string>();
  const out: { path: string; status: 'added' | 'modified' | 'removed'; baseOid: string | null; headOid: string | null }[] = [];
  const keys = new Set([...base.keys(), ...head.keys()]);
  for (const k of [...keys].sort()) {
    const b = base.get(k) ?? null; const h = head.get(k) ?? null;
    if (b === h) continue;
    out.push({ path: k, status: b === null ? 'added' : h === null ? 'removed' : 'modified', baseOid: b, headOid: h });
  }
  return out;
}

function mergeConflict(store: Store, repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const mb = findMergeBase(store, repo, pull.headSha, baseTip);
  if (!mb) return false;
  const baseAtMb = store.filesAt(repo, mb);
  const headFiles = store.filesAt(repo, pull.headSha);
  const baseFiles = store.filesAt(repo, baseTip);
  const keys = new Set([...baseAtMb.keys(), ...headFiles.keys(), ...baseFiles.keys()]);
  for (const k of keys) {
    const m = baseAtMb.get(k) ?? null; const h = headFiles.get(k) ?? null; const b = baseFiles.get(k) ?? null;
    if (h !== m && b !== m && h !== b) return true;
  }
  return false;
}

function doMerge(store: Store, repo: Repo, pull: Pull): { ok: boolean; sha?: string; reason?: string } {
  if (pull.state !== 'open') return { ok: false, reason: 'already merged or closed' };
  if (mergeConflict(store, repo, pull)) return { ok: false, reason: 'merge conflict' };
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const mb = findMergeBase(store, repo, pull.headSha, baseTip);
  const baseAtMb = mb ? store.filesAt(repo, mb) : new Map<string, string>();
  const headFiles = store.filesAt(repo, pull.headSha);
  const baseFiles = store.filesAt(repo, baseTip);
  const merged = new Map(baseFiles);
  for (const [k, h] of headFiles) { const m = baseAtMb.get(k) ?? null; if (h !== m) merged.set(k, h); }
  for (const k of [...baseAtMb.keys()]) { if (!headFiles.has(k) && baseFiles.has(k) && baseFiles.get(k) === baseAtMb.get(k)) merged.delete(k); }
  // Apply head deletions: paths in merge base removed in head and unchanged in base.
  for (const k of [...baseAtMb.keys()]) { if (!headFiles.has(k)) merged.delete(k); }
  const sha = makeCommit(store, repo, `refs/heads/${pull.base}`, merged, pull.title);
  pull.state = 'closed'; pull.merged = true; pull.mergedAt = store.stamp(); pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

function createPull(store: Store, repo: Repo, head: string, base: string, title: string, body: string): { pull: Pull | null; status: number; message?: string } {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return { pull: null, status: 422, message: 'head or base branch not found' };
  for (const p of repo.pulls.values()) {
    if (p.state === 'open' && p.head === head && p.base === base) return { pull: null, status: 422, message: 'a pull request already exists for this head and base' };
  }
  const changed = diffPaths(store, repo, baseSha, headSha).map((d) => d.path);
  const pull: Pull = { number: repo.nextPull, title, body: body ?? '', state: 'open', head, base, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null, seq: store.nextSeq(), changedPaths: changed };
  repo.nextPull += 1;
  repo.pulls.set(pull.number, pull);
  return { pull, status: 201 };
}

function createIssue(store: Store, repo: Repo, title: string, body: string, labelNames: string[]): { issue: Issue | null; status: number; message?: string } {
  const labels: { name: string; color: string }[] = [];
  for (const name of labelNames) {
    const l = repo.labels.get(name);
    if (!l) return { issue: null, status: 422, message: `label ${name} does not exist` };
    labels.push(l);
  }
  const issue: Issue = { number: repo.nextIssue, title, body: body ?? '', state: 'open', labels, comments: [], seq: store.nextSeq(), createdAt: store.stamp() };
  repo.nextIssue += 1;
  repo.issues.set(issue.number, issue);
  return { issue, status: 201 };
}

function repoByDatabaseId(store: Store, dbId: number): Repo | null {
  for (const r of store.repos.values()) if (r.databaseId === dbId) return r;
  return null;
}
function parseGlobalId(id: string): { kind: string; db: number; num: number } | null {
  const m = /^([A-Z]+)_(\d+)(?:_(\d+))?(?:_(\d+))?$/.exec(id);
  if (!m) return null;
  return { kind: m[1]!, db: Number(m[2]), num: m[3] ? Number(m[3]) : 0 };
}
function treeAtPath(store: Store, repo: Repo, commitOid: string, dirPath: string): { treeOid: string; entries: { mode: string; name: string; oid: string }[] } | null {
  const info = store.commitInfo(repo, commitOid);
  if (!info) return null;
  let treeOid = info.tree;
  if (dirPath) {
    for (const part of dirPath.split('/')) {
      const tree = repo.objects.get(treeOid);
      if (!tree) return null;
      const entries = store.parseTree(tree.data);
      const hit = entries.find((e) => e.name === part && e.mode === '40000');
      if (!hit) return null;
      treeOid = hit.oid;
    }
  }
  const tree = repo.objects.get(treeOid);
  if (!tree) return null;
  return { treeOid, entries: store.parseTree(tree.data) };
}
function lineCount(b: Buffer): number {
  if (b.length === 0) return 0;
  return b.toString('utf8').split('\n').filter((l) => l.length > 0).length || 1;
}

// ---- REST v3 ----
async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store, parts: string[], body: Buffer): Promise<boolean> {
  const method = req.method ?? 'GET';
  const q = queryOf(req);
  // parts[0] === 'api', parts[1] === 'v3'
  const fail = (status: number, message: string): void => { sendJson(res, status, { message }); };
  const ok = (status: number, data: unknown, extra: Record<string, string> = {}): void => { sendJson(res, status, data, extra); };

  // GET /api/v3/ and /api/v3/meta (no owner involved)
  if (method === 'GET' && parts.length === 2) { ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' }); return true; }
  if (method === 'GET' && parts.length === 3 && parts[2] === 'meta') { ok(200, { installed_version: '1.0.0' }); return true; }
  if (method === 'GET' && parts.length === 3 && parts[2] === 'user') {
    ok(200, { login: store.viewer(), id: 1000, type: 'User', name: store.viewer(), email: viewerEmail(store) });
    return true;
  }

  // POST /api/v3/user/repos
  if (method === 'POST' && parts.length === 4 && parts[2] === 'user' && parts[3] === 'repos') {
    let b: unknown; try { b = parseJsonBody(body); } catch { fail(400, 'malformed JSON body'); return true; }
    if (!isJson(b) || typeof b.name !== 'string' || !b.name) { fail(422, 'name is required'); return true; }
    const existing = store.getRepo(b.name);
    if (existing) { fail(422, 'repository already exists'); return true; }
    const repo = store.createRepo(b.name, b.private === true, typeof b.description === 'string' ? b.description : '');
    if (!repo) { fail(422, 'repository already exists'); return true; }
    ok(201, store.repoJson(repo));
    return true;
  }
  // GET /api/v3/user/repos (paginated)
  if (method === 'GET' && parts.length === 4 && parts[2] === 'user' && parts[3] === 'repos') {
    const perPage = Math.max(1, Math.min(100, Number(q.get('per_page') ?? '30') || 30));
    const page = Math.max(1, Number(q.get('page') ?? '1') || 1);
    const all = [...store.repos.values()];
    const slice = all.slice((page - 1) * perPage, page * perPage);
    ok(200, slice.map((r) => store.repoJson(r)), linkHeader(req, '/api/v3/user/repos', page, perPage, page * perPage < all.length));
    return true;
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (parts.length >= 4 && parts[2] === 'repos') {
    const owner = parts[3]!; const name = parts[4] ?? '';
    const repo = store.resolveRepo(owner, name);
    if (!repo) { fail(404, 'Not Found'); return true; }
    const rest = parts.slice(5);
    // GET / PATCH / DELETE repo itself
    if (rest.length === 0) {
      if (method === 'GET') { ok(200, store.repoJson(repo)); return true; }
      if (method === 'PATCH') {
        let b: unknown = {}; try { b = parseJsonBody(body); } catch { fail(400, 'malformed JSON body'); return true; }
        if (isJson(b) && typeof b.description === 'string') repo.description = b.description;
        ok(200, store.repoJson(repo)); return true;
      }
      if (method === 'DELETE') { store.repos.delete(name); res.writeHead(204, { 'x-github-request-id': nextReqId() }); res.end(); return true; }
      fail(404, 'Not Found'); return true;
    }
    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        let b: unknown; try { b = parseJsonBody(body); } catch { fail(400, 'malformed JSON body'); return true; }
        if (!isJson(b) || typeof b.ref !== 'string' || typeof b.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(b.sha)) { fail(422, 'ref and sha are required'); return true; }
        repo.refs.set(b.ref, b.sha.toLowerCase());
        ok(201, { ref: b.ref, object: { sha: b.sha.toLowerCase(), type: 'commit' } });
        return true;
      }
      if (method === 'GET' && rest.length === 2) {
        ok(200, [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } })));
        return true;
      }
      if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
        const branch = rest.slice(3).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) { fail(404, 'Not Found'); return true; }
        ok(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
        return true;
      }
      fail(404, 'Not Found'); return true;
    }
    // branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const list = [...repo.refs.entries()].filter(([r]) => r.startsWith('refs/heads/')).sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([r, sha]) => ({ name: r.slice('refs/heads/'.length), commit: { sha }, protected: false }));
        ok(200, list); return true;
      }
      if (method === 'GET' && rest.length === 2) {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (!sha) { fail(404, 'Not Found'); return true; }
        ok(200, { name: rest[1], commit: { sha }, protected: false }); return true;
      }
      fail(404, 'Not Found'); return true;
    }
    // commits
    if (rest[0] === 'commits' && method === 'GET') {
      const refName = q.get('sha') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${refName}`) ?? (repo.refs.get(refName) ?? null);
      if (!tip) { ok(200, []); return true; }
      const commits = store.reachableCommits(repo, tip);
      const out = commits.map((oid) => {
        const info = store.commitInfo(repo, oid)!;
        const parseWho = (s: string): { name: string; email: string; date: string } => {
          const m = /^(.+?) <([^>]+)> (\d+) \+0000$/.exec(s);
          if (!m) return { name: s, email: '', date: '2025-01-01T00:00:00Z' };
          return { name: m[1]!, email: m[2]!, date: new Date(Number(m[3]) * 1000).toISOString().replace(/\.\d+Z$/, 'Z') };
        };
        return { sha: oid, commit: { message: info.message.replace(/\n+$/, ''), author: parseWho(info.author), committer: parseWho(info.committer) }, author: { login: store.viewer() }, committer: { login: store.viewer() } };
      });
      ok(200, out); return true;
    }
    // contents
    if (rest[0] === 'contents') {
      const cpath = rest.slice(1).join('/');
      const refName = q.get('ref') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${refName}`) ?? null;
      if (method === 'GET') {
        if (!tip) { fail(404, 'Not Found'); return true; }
        const files = store.filesAt(repo, tip);
        if (cpath === '') {
          const t = treeAtPath(store, repo, tip, '');
          ok(200, (t?.entries ?? []).map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: e.name, sha: e.oid, size: 0 })));
          return true;
        }
        const blobOid = files.get(cpath);
        if (blobOid) {
          const obj = repo.objects.get(blobOid)!;
          ok(200, { type: 'file', encoding: 'base64', content: obj.data.toString('base64'), sha: blobOid, size: obj.data.length, name: cpath.split('/').pop(), path: cpath });
          return true;
        }
        const t = treeAtPath(store, repo, tip, cpath);
        if (t) {
          ok(200, t.entries.map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: `${cpath}/${e.name}`, sha: e.oid, size: 0 })));
          return true;
        }
        fail(404, 'Not Found'); return true;
      }
      if (method === 'PUT') {
        let b: unknown; try { b = parseJsonBody(body); } catch { fail(400, 'malformed JSON body'); return true; }
        if (!isJson(b) || typeof b.content !== 'string' || typeof b.message !== 'string') { fail(422, 'message and content are required'); return true; }
        const branch = typeof b.branch === 'string' && b.branch ? b.branch : repo.defaultBranch;
        const branchRef = `refs/heads/${branch}`;
        const curTip = repo.refs.get(branchRef) ?? null;
        const files = curTip ? store.filesAt(repo, curTip) : new Map<string, string>();
        const existed = files.has(cpath);
        if (existed && typeof b.sha === 'string' && b.sha.toLowerCase() !== files.get(cpath)) { fail(409, 'sha does not match the current file'); return true; }
        const content = Buffer.from(b.content, 'base64');
        const blobOid = store.putObject(repo, 'blob', content);
        files.set(cpath, blobOid);
        const commitSha = makeCommit(store, repo, branchRef, files, b.message);
        ok(existed ? 200 : 201, { content: { sha: blobOid, encoding: 'base64', size: content.length, name: cpath.split('/').pop(), path: cpath }, commit: { sha: commitSha } });
        return true;
      }
      if (method === 'DELETE') {
        let b: unknown = {}; try { b = parseJsonBody(body); } catch { fail(400, 'malformed JSON body'); return true; }
        if (!isJson(b) || typeof b.message !== 'string') { fail(422, 'message is required'); return true; }
        const branchRef = `refs/heads/${repo.defaultBranch}`;
        const curTip = repo.refs.get(branchRef) ?? null;
        if (!curTip) { fail(404, 'Not Found'); return true; }
        const files = store.filesAt(repo, curTip);
        if (!files.has(cpath)) { fail(404, 'Not Found'); return true; }
        if (typeof b.sha === 'string' && b.sha.toLowerCase() !== files.get(cpath)) { fail(409, 'sha does not match the current file'); return true; }
        files.delete(cpath);
        const commitSha = makeCommit(store, repo, branchRef, files, b.message);
        ok(200, { commit: { sha: commitSha } });
        return true;
      }
      fail(404, 'Not Found'); return true;
    }
    // labels
    if (rest[0] === 'labels') {
      if (method === 'POST') {
        let b: unknown; try { b = parseJsonBody(body); } catch { fail(400, 'malformed JSON body'); return true; }
        if (!isJson(b) || typeof b.name !== 'string' || !b.name) { fail(422, 'name is required'); return true; }
        const label = { name: b.name, color: typeof b.color === 'string' ? b.color : 'ededed' };
        repo.labels.set(b.name, label);
        ok(201, label); return true;
      }
      if (method === 'GET') { ok(200, [...repo.labels.values()]); return true; }
      fail(404, 'Not Found'); return true;
    }
    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          let b: unknown; try { b = parseJsonBody(body); } catch { fail(400, 'malformed JSON body'); return true; }
          if (!isJson(b) || typeof b.title !== 'string' || !b.title) { fail(422, 'title is required'); return true; }
          const labelNames: string[] = Array.isArray(b.labels) ? b.labels.map((l) => (typeof l === 'string' ? l : isJson(l) ? String(l.name ?? '') : '')).filter(Boolean) : [];
          const r = createIssue(store, repo, b.title, typeof b.body === 'string' ? b.body : '', labelNames);
          if (!r.issue) { fail(r.status, r.message ?? 'error'); return true; }
          ok(201, store.issueJson(repo, r.issue)); return true;
        }
        if (method === 'GET') {
          let list = [...repo.issues.values()];
          const state = q.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (q.get('sort') === 'created') {
            const dir = q.get('direction') === 'desc' ? -1 : 1;
            list.sort((a, b2) => (a.seq - b2.seq) * dir);
          }
          const perPage = Math.max(1, Math.min(100, Number(q.get('per_page') ?? '100') || 100));
          const page = Math.max(1, Number(q.get('page') ?? '1') || 1);
          const slice = list.slice((page - 1) * perPage, page * perPage);
          ok(200, slice.map((i) => store.issueJson(repo, i)), linkHeader(req, `/api/v3/repos/${owner}/${name}/issues`, page, perPage, page * perPage < list.length));
          return true;
        }
        fail(404, 'Not Found'); return true;
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) { fail(404, 'Not Found'); return true; }
      if (rest.length === 2) {
        const issue = repo.issues.get(num);
        if (!issue) { fail(404, 'Not Found'); return true; }
        if (method === 'GET') { ok(200, store.issueJson(repo, issue)); return true; }
        if (method === 'PATCH') {
          let b: unknown = {}; try { b = parseJsonBody(body); } catch { fail(400, 'malformed JSON body'); return true; }
          if (isJson(b)) {
            if (b.state === 'closed' || b.state === 'open') issue.state = b.state;
            if (typeof b.title === 'string') issue.title = b.title;
            if (typeof b.body === 'string') issue.body = b.body;
          }
          ok(200, store.issueJson(repo, issue)); return true;
        }
        fail(404, 'Not Found'); return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const issue = repo.issues.get(num);
        if (!issue) { fail(404, 'Not Found'); return true; }
        if (method === 'POST') {
          let b: unknown; try { b = parseJsonBody(body); } catch { fail(400, 'malformed JSON body'); return true; }
          if (!isJson(b) || typeof b.body !== 'string') { fail(422, 'body is required'); return true; }
          repo.commentSeq += 1;
          const comment = { id: repo.commentSeq, body: b.body, user: store.viewer() };
          issue.comments.push(comment);
          ok(201, { id: comment.id, body: comment.body, user: { login: store.viewer() } });
          return true;
        }
        if (method === 'GET') { ok(200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: c.user } }))); return true; }
        fail(404, 'Not Found'); return true;
      }
      fail(404, 'Not Found'); return true;
    }
    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          let b: unknown; try { b = parseJsonBody(body); } catch { fail(400, 'malformed JSON body'); return true; }
          if (!isJson(b) || typeof b.head !== 'string' || typeof b.base !== 'string') { fail(422, 'head and base are required'); return true; }
          const r = createPull(store, repo, b.head, b.base, typeof b.title === 'string' ? b.title : '', typeof b.body === 'string' ? b.body : '');
          if (!r.pull) { fail(r.status, r.message ?? 'error'); return true; }
          ok(201, store.pullJson(repo, r.pull)); return true;
        }
        if (method === 'GET') {
          let list = [...repo.pulls.values()];
          const state = q.get('state') ?? 'open';
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          const perPage = Math.max(1, Math.min(100, Number(q.get('per_page') ?? '100') || 100));
          const page = Math.max(1, Number(q.get('page') ?? '1') || 1);
          const slice = list.slice((page - 1) * perPage, page * perPage);
          ok(200, slice.map((p) => store.pullJson(repo, p)), linkHeader(req, `/api/v3/repos/${owner}/${name}/pulls`, page, perPage, page * perPage < list.length));
          return true;
        }
        fail(404, 'Not Found'); return true;
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) { fail(404, 'Not Found'); return true; }
      const pull = repo.pulls.get(num);
      if (rest.length === 2) {
        if (!pull) { fail(404, 'Not Found'); return true; }
        if (method === 'GET') { ok(200, store.pullJson(repo, pull)); return true; }
        fail(404, 'Not Found'); return true;
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pull) { fail(404, 'Not Found'); return true; }
        if (method === 'GET') {
          const diffs = diffPaths(store, repo, pull.baseSha, pull.headSha);
          ok(200, diffs.map((d) => {
            const headData = d.headOid ? repo.objects.get(d.headOid)?.data : null;
            const baseData = d.baseOid ? repo.objects.get(d.baseOid)?.data : null;
            const additions = d.status === 'removed' ? 0 : headData ? Math.max(1, lineCount(headData)) : 0;
            const deletions = d.status === 'added' ? 0 : baseData ? lineCount(baseData) : 0;
            return { filename: d.path, status: d.status === 'modified' ? 'modified' : d.status, additions, deletions, changes: additions + deletions };
          }));
          return true;
        }
        fail(404, 'Not Found'); return true;
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pull) { fail(404, 'Not Found'); return true; }
        if (method === 'PUT') {
          const r = doMerge(store, repo, pull);
          if (!r.ok) {
            if (r.reason === 'merge conflict') { fail(405, 'merge conflict'); return true; }
            fail(409, r.reason ?? 'cannot merge'); return true;
          }
          ok(200, { merged: true, sha: r.sha, message: 'Pull Request successfully merged' });
          return true;
        }
        fail(404, 'Not Found'); return true;
      }
      fail(404, 'Not Found'); return true;
    }
    fail(404, 'Not Found'); return true;
  }
  return false;
}

// ---- Git smart HTTP ----

function refList(repo: Repo): { ref: string; oid: string }[] {
  const out: { ref: string; oid: string }[] = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) out.push({ ref, oid });
  return out;
}
function v0Advertise(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const caps = service === 'receive-pack'
    ? 'report-status side-band-64k delete-refs ofs-delta agent=github-forge/1.0'
    : 'side-band-64k thin-pack ofs-delta shallow multi_ack_detailed symref=HEAD:refs/heads/main agent=github-forge/1.0';
  const parts: Buffer[] = [pktLine(`# service=git-${service}\n`), FLUSH];
  const refs = refList(repo);
  const headOid = repo.refs.get('refs/heads/main') ?? null;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (headOid) parts.push(pktLine(`${headOid} HEAD\0${caps}\n`)), first = false;
    for (const { ref, oid } of refs) {
      const line = first ? `${oid} ${ref}\0${caps}\n` : `${oid} ${ref}\n`;
      parts.push(pktLine(line)); first = false;
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
function v2Advertise(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine('agent=github-forge/1.0\n'),
    FLUSH,
  ]);
}

// Objects to send for a fetch: commits within depth of wants, their tree
// closures and tag objects, minus everything reachable from haves.
function fetchObjects(store: Store, repo: Repo, wants: string[], haves: string[], depth: number | undefined, shallowReq: string[] = []): { objects: { type: string; data: Buffer }[]; shallow: string[]; unshallow: string[]; } {
  const included = new Set<string>();
  const shallow: string[] = [];
  const queue: { oid: string; dist: number }[] = wants.map((oid) => ({ oid, dist: 0 }));
  let qi = 0;
  const seenCommit = new Set<string>();
  const addTreeClosure = (treeOid: string): void => {
    const tq = [treeOid];
    let ti = 0;
    while (ti < tq.length) {
      const oid = tq[ti++]!;
      if (included.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      included.add(oid);
      if (obj.type === 'tree') for (const e of parseTreeData(obj.data)) tq.push(e.oid);
    }
  };
  while (qi < queue.length) {
    const { oid, dist } = queue[qi++]!;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      included.add(oid);
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m) queue.push({ oid: m[1]!, dist });
      continue;
    }
    if (obj.type !== 'commit') { included.add(oid); continue; }
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    if (depth !== undefined && dist >= depth) continue;
    included.add(oid);
    const info = parseCommit(obj.data);
    addTreeClosure(info.tree);
    let hasUnincludedParent = false;
    for (const p of info.parents) {
      if (depth !== undefined && dist + 1 >= depth) hasUnincludedParent = true;
      else queue.push({ oid: p, dist: dist + 1 });
    }
    if (hasUnincludedParent) shallow.push(oid);
  }
  // Held objects: reachable closure of haves, but the walk stops at a
  // shallow boundary: a client that holds a shallow clone has the boundary
  // commit and its tree, not the boundary's parents.
  const boundary = new Set(shallowReq);
  const held = new Set<string>();
  const hq = [...haves];
  let hi = 0;
  while (hi < hq.length) {
    const oid = hq[hi++]!;
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data); hq.push(info.tree);
      if (!boundary.has(oid)) for (const p of info.parents) hq.push(p);
    }
    else if (obj.type === 'tree') { for (const e of parseTreeData(obj.data)) hq.push(e.oid); }
    else if (obj.type === 'tag') { const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8')); if (m) hq.push(m[1]!); }
  }
  const objects: { type: string; data: Buffer }[] = [];
  for (const oid of included) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  return { objects, shallow, unshallow: [] };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([0x01]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([0x01])));
  return Buffer.concat(parts);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store, parts: string[], body: Buffer): Promise<boolean> {
  const method = req.method ?? 'GET';
  // parts: [owner, repo.git, ...]
  if (parts.length < 2 || !parts[1]!.endsWith('.git')) return false;
  const owner = parts[0]!; const name = parts[1]!.slice(0, -4);
  const sub = parts.slice(2);
  const fail = (status: number, message: string): void => { sendJson(res, status, { message }); };
  const repo = store.resolveRepo(owner, name);
  if (!repo) { fail(404, 'Not Found'); return true; }

  // info/refs
  if (method === 'GET' && sub.length === 2 && sub[0] === 'info' && sub[1] === 'refs') {
    const service = queryOf(req).get('service') ?? '';
    const v2 = req.headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
    if (service === 'git-upload-pack') {
      sendBytes(res, 200, v2 ? v2Advertise() : v0Advertise(repo, 'upload-pack'), 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-receive-pack') {
      sendBytes(res, 200, v0Advertise(repo, 'receive-pack'), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    fail(404, 'Not Found'); return true;
  }

  // git-upload-pack
  if (method === 'POST' && sub.length === 1 && sub[0] === 'git-upload-pack') {
    const v2 = req.headers['git-protocol'] === 'version=2';
    let pkts: { kind: string; payload: Buffer }[];
    try { pkts = parsePktLines(body); } catch { fail(400, 'bad pkt-line'); return true; }
    const lines = pkts.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
    if (lines.length === 0 || (!lines[0]!.startsWith('command=') && !lines[0]!.startsWith('want '))) { fail(400, 'bad request'); return true; }
    if (v2 && lines[0]!.startsWith('command=ls-refs')) {
      const args = lines.slice(1);
      const peel = args.some((a) => a.trim() === 'peel');
      const symrefs = args.some((a) => a.trim() === 'symrefs');
      const unborn = args.some((a) => a.trim() === 'unborn');
      const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length).trim());
      const out: Buffer[] = [];
      const headOid = repo.refs.get('refs/heads/main') ?? null;
      if (prefixes.length === 0) {
        if (symrefs) {
          if (headOid) out.push(pktLine(`${headOid} HEAD symref-target:refs/heads/main\n`));
          else if (unborn) out.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
        }
      }
      for (const { ref, oid } of refList(repo)) {
        if (prefixes.length > 0 && !prefixes.some((p) => ref.startsWith(p))) continue;
        let line = `${oid} ${ref}`;
        const obj = repo.objects.get(oid);
        if (peel && obj && obj.type === 'tag') { const peeled = peelToCommit(repo, oid); if (peeled) line += ` peeled:${peeled}`; }
        out.push(pktLine(`${line}\n`));
      }
      out.push(FLUSH);
      sendBytes(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
      return true;
    }
    // fetch (v2 or v0)
    const wants: string[] = []; const haves: string[] = []; const shallowReq: string[] = [];
    let depth: number | undefined;
    for (const line of lines) {
      const t = line.trim();
      const first = t.split('\0')[0]!;
      if (first.startsWith('want ')) wants.push(first.slice(5).trim().split(' ')[0]!);
      else if (first.startsWith('have ')) haves.push(first.slice(5).trim());
      else if (first.startsWith('shallow ')) shallowReq.push(first.slice(8).trim());
      else if (first.startsWith('deepen ')) { const n = Number(first.slice(7).trim()); if (Number.isFinite(n)) depth = n; }
    }
    const { objects, shallow } = fetchObjects(store, repo, wants, haves, depth, shallowReq);
    const unshallow: string[] = [];
    const pack = writePack(objects);
    // unshallow: a previous shallow boundary whose parent commit is in the sent set
    const sentOids = new Set<string>(objects.map((o) => hashObject(o.type, o.data)));
    for (const s of shallowReq) {
      const obj = repo.objects.get(s);
      if (!obj || obj.type !== 'commit') continue;
      const info = parseCommit(obj.data);
      if (info.parents.some((p) => sentOids.has(p))) unshallow.push(s);
    }
    if (v2) {
      const out: Buffer[] = [pktLine('acknowledgments\n')];
      const ackOid = haves.find((h) => repo.objects.has(h));
      if (ackOid) { out.push(pktLine(`ACK ${ackOid}\n`)); out.push(pktLine('ready\n')); } else out.push(pktLine('NAK\n'));
      out.push(FLUSH);
      out.push(pktLine('shallow-info\n'));
      for (const s of shallow) out.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallow) out.push(pktLine(`unshallow ${s}\n`));
      out.push(FLUSH);
      out.push(pktLine('wanted-refs\n'));
      for (const w of wants) {
        const ref = [...repo.refs.entries()].find(([, oid]) => oid === w);
        if (ref) out.push(pktLine(`${w} ${ref[0]}\n`));
      }
      out.push(FLUSH);
      out.push(pktLine('packfile\n'));
      out.push(sidebandPack(pack));
      out.push(FLUSH);
      sendBytes(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
      return true;
    }
    // v0 fetch
    const out: Buffer[] = [];
    const ackOid = haves.find((h) => repo.objects.has(h));
    if (ackOid) out.push(pktLine(`ACK ${ackOid}\n`)); else out.push(pktLine('NAK\n'));
    for (const s of shallow) out.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) out.push(pktLine(`unshallow ${s}\n`));
    out.push(sidebandPack(pack));
    out.push(FLUSH);
    sendBytes(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
    return true;
  }

  // git-receive-pack
  if (method === 'POST' && sub.length === 1 && sub[0] === 'git-receive-pack') {
    const lines: string[] = [];
    let packStart = body.length;
    let i = 0;
    let sideband = true;
    try {
      while (i + 4 <= body.length) {
        const hex = body.subarray(i, i + 4).toString('ascii');
        if (hex === '0000') { packStart = i + 4; break; }
        if (hex === '0001' || hex === '0002') { i += 4; continue; }
        const len = parseInt(hex, 16);
        if (!Number.isFinite(len) || len < 4 || i + len > body.length) { packStart = body.length; break; }
        lines.push(body.subarray(i + 4, i + len).toString('utf8'));
        i += len;
      }
    } catch { fail(400, 'bad pkt-line'); return true; }
    if (lines.length === 0) { fail(400, 'bad request'); return true; }
    const firstCaps = lines[0]!.split('\0')[1] ?? '';
    if (firstCaps) sideband = firstCaps.includes('side-band-64k');
    const commands: { oldOid: string; newOid: string; ref: string }[] = [];
    for (const line of lines) {
      const clean = line.split('\0')[0]!.trim();
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(clean);
      if (m) commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
    }
    // Store pack objects
    let unpackOk = true;
    if (packStart < body.length) {
      try {
        const objs = readPack(body.subarray(packStart));
        for (const obj of objs.values()) store.putObject(repo, obj.type, obj.data);
      } catch { unpackOk = false; }
    }
    const results: string[] = [];
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref) ?? null;
      if (cmd.newOid === ZERO_OID) {
        if (current && cmd.oldOid === current) { repo.refs.delete(cmd.ref); results.push(`ok ${cmd.ref}`); }
        else if (!current && cmd.oldOid === ZERO_OID) results.push(`ok ${cmd.ref}`);
        else results.push(`ng ${cmd.ref} invalid-old-value`);
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        if (current) { results.push(`ng ${cmd.ref} non-fast-forward`); continue; }
        if (!repo.objects.has(cmd.newOid)) { results.push(`ng ${cmd.ref} object-not-found`); continue; }
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push(`ok ${cmd.ref}`);
        continue;
      }
      if (current !== cmd.oldOid) { results.push(`ng ${cmd.ref} non-fast-forward`); continue; }
      if (!store.isAncestor(repo, cmd.oldOid, cmd.newOid)) { results.push(`ng ${cmd.ref} non-fast-forward`); continue; }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push(`ok ${cmd.ref}`);
    }
    const reportLines = [`unpack ${unpackOk ? 'ok' : 'error'}`, ...results];
    let out: Buffer;
    if (sideband) {
      const parts: Buffer[] = [];
      for (const line of reportLines) parts.push(pktLine(Buffer.concat([Buffer.from([0x01]), pktLine(`${line}\n`)])));
      parts.push(FLUSH);
      out = Buffer.concat(parts);
    } else {
      out = Buffer.concat([...reportLines.map((l) => pktLine(`${l}\n`)), FLUSH]);
    }
    sendBytes(res, 200, out, 'application/x-git-receive-pack-result');
    return true;
  }
  fail(404, 'Not Found');
  return true;
}

// ---- GraphQL v4 ----
interface GField { alias: string | null; name: string; args: Record<string, unknown>; children: GField[] | null; fragments: GFragment[]; }
interface GFragment { type: string | null; children: GField[]; }
interface GOp { kind: 'query' | 'mutation'; name: string | null; fields: GField[]; }

function gqlLex(src: string): { kind: string; value: string }[] {
  const toks: { kind: string; value: string }[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '{' || c === '}' || c === '(' || c === ')' || c === ':' || c === '$' || c === '!' || c === '[' || c === ']' || c === '=') { toks.push({ kind: c, value: c }); i += 1; continue; }
    if (src.startsWith('...', i)) { toks.push({ kind: '...', value: '...' }); i += 3; continue; }
    if (c === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) { const n = src[j + 1]!; out += n === 'n' ? '\n' : n === 't' ? '\t' : n === '"' ? '"' : n === '\\' ? '\\' : n; j += 2; } else { out += src[j]!; j += 1; } }
      toks.push({ kind: 'string', value: out }); i = j + 1; continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i; while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j += 1;
      toks.push({ kind: 'number', value: src.slice(i, j) }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) }); i = j; continue;
    }
    i += 1;
  }
  return toks;
}
class GParser {
  toks: { kind: string; value: string }[]; pos = 0; vars: Record<string, unknown>;
  constructor(src: string, vars: Record<string, unknown>) { this.toks = gqlLex(src); this.vars = vars; }
  peek(): { kind: string; value: string } | undefined { return this.toks[this.pos]; }
  next(): { kind: string; value: string } { return this.toks[this.pos++]!; }
  expect(kind: string): { kind: string; value: string } { const t = this.next(); if (t.kind !== kind) throw new Error(`expected ${kind}, got ${t.kind}`); return t; }
  parseValue(): unknown {
    const t = this.next();
    if (t.kind === '$') { const name = this.expect('name').value; return this.vars[name] ?? null; }
    if (t.kind === 'string') return t.value;
    if (t.kind === 'number') return Number(t.value);
    if (t.kind === '[') {
      const arr: unknown[] = [];
      while (this.peek()?.kind !== ']') arr.push(this.parseValue());
      this.expect(']'); return arr;
    }
    if (t.kind === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek()?.kind !== '}') { const k = this.expect('name').value; this.expect(':'); obj[k] = this.parseValue(); }
      this.expect('}'); return obj;
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return t.value; // enum as string
    }
    throw new Error(`unexpected value token ${t.kind}`);
  }
  parseArgs(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (this.peek()?.kind !== '(') return args;
    this.expect('(');
    while (this.peek()?.kind !== ')') { const k = this.expect('name').value; this.expect(':'); args[k] = this.parseValue(); }
    this.expect(')'); return args;
  }
  skipDirectives(): void {
    while (this.peek()?.kind === '@') { this.next(); this.expect('name'); this.parseArgs(); }
  }
  parseSelection(): { fields: GField[]; fragments: GFragment[] } {
    this.expect('{');
    const fields: GField[] = []; const fragments: GFragment[] = [];
    while (this.peek()?.kind !== '}') {
      if (this.peek()?.kind === '...') {
        this.next();
        if (this.peek()?.kind === 'name' && this.peek()!.value === 'on') {
          this.next(); const type = this.expect('name').value; this.skipDirectives();
          const sel = this.parseSelection();
          fragments.push({ type, children: [...sel.fields, ...sel.fragments.flatMap((f) => f.children)] });
        } else if (this.peek()?.kind === 'name') {
          this.next(); this.skipDirectives();
          // named fragment spread: unsupported, treat as no-op
        } else { this.skipDirectives(); this.parseSelection(); }
        continue;
      }
      const first = this.expect('name').value;
      let alias: string | null = null; let name = first;
      if (this.peek()?.kind === ':') { this.next(); alias = first; name = this.expect('name').value; }
      const args = this.parseArgs();
      this.skipDirectives();
      let children: GField[] | null = null; const frags: GFragment[] = [];
      if (this.peek()?.kind === '{') { const sel = this.parseSelection(); children = sel.fields; frags.push(...sel.fragments); }
      fields.push({ alias, name, args, children, fragments: frags });
    }
    this.expect('}');
    return { fields, fragments };
  }
  parseOperation(): GOp {
    let kind: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t?.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) { kind = this.next().value as 'query' | 'mutation'; }
    let name: string | null = null;
    if (this.peek()?.kind === 'name') name = this.next().value;
    if (this.peek()?.kind === '(') {
      // variable definitions: skip balanced parens, resolving nothing
      let depth = 0;
      while (this.pos < this.toks.length) { const tk = this.next(); if (tk.kind === '(') depth += 1; if (tk.kind === ')') { depth -= 1; if (depth === 0) break; } }
    }
    this.skipDirectives();
    const sel = this.parseSelection();
    // inline fragments at top level are merged into fields for execution
    const fields = [...sel.fields];
    for (const f of sel.fragments) fields.push(...f.children);
    return { kind, name, fields };
  }
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'author', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'merged', 'files', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt'],
  User: ['login', 'id'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  SearchType: [],
};
const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function gqlId(kind: string, db: number, num: number): string { return `${kind}_${db}_${num}`; }
function b64(s: string): string { return Buffer.from(s, 'utf8').toString('base64'); }
function unb64(s: string): string { try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return ''; } }

interface Ctx { store: Store; errors: { message: string }[]; }
type Val = Record<string, unknown> | null;

function applySelection(ctx: Ctx, typeName: string, value: Val, fields: GField[], fragments: GFragment[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allFields = [...fields];
  for (const f of fragments) allFields.push(...f.children);
  for (const field of allFields) {
    const key = field.alias ?? field.name;
    const resolved = resolveField(ctx, typeName, value, field);
    out[key] = resolved;
  }
  return out;
}
function resolveField(ctx: Ctx, typeName: string, value: Val, field: GField): unknown {
  const store = ctx.store;
  const name = field.name;
  if (name === '__typename') return typeName;
  // Introspection
  if (name === '__type') {
    const tname = String(field.args['name'] ?? '');
    if (ENUM_VALUES[tname]) {
      return { name: tname, kind: 'ENUM', fields: null, enumValues: ENUM_VALUES[tname].map((n) => ({ name: n })) };
    }
    const fl = TYPE_FIELDS[tname];
    if (!fl) return { name: tname, kind: 'OBJECT', fields: [], enumValues: null };
    return { name: tname, kind: 'OBJECT', fields: fl.map((n) => ({ name: n })), enumValues: null };
  }
  if (name === '__schema') return { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
  if (typeName === 'Query' || typeName === 'Root') {
    if (name === 'viewer') {
      const v = { login: store.viewer() };
      return field.children ? applySelection(ctx, 'User', v as unknown as Val, field.children, field.fragments) : v;
    }
    if (name === 'repository') {
      const owner = String(field.args['owner'] ?? '');
      const rname = String(field.args['name'] ?? '');
      const repo = store.resolveRepo(owner, rname);
      if (!repo) return null;
      return field.children ? applySelection(ctx, 'Repository', repo as unknown as Val, field.children, field.fragments) : repo;
    }
    if (name === 'node') {
      const id = String(field.args['id'] ?? '');
      const parsed = parseGlobalId(id);
      if (!parsed) return null;
      if (parsed.kind === 'R') {
        const repo = repoByDatabaseId(store, parsed.db);
        if (!repo) return null;
        const v = { ...repo, __type: 'Repository' };
        return field.children ? applySelection(ctx, 'Repository', v as unknown as Val, field.children, field.fragments) : v;
      }
      if (parsed.kind === 'I') {
        const repo = repoByDatabaseId(store, parsed.db);
        const issue = repo?.issues.get(parsed.num);
        if (!repo || !issue) return null;
        return field.children ? applySelection(ctx, 'Issue', { ...issue, __repo: repo } as unknown as Val, field.children, field.fragments) : issue;
      }
      if (parsed.kind === 'PR') {
        const repo = repoByDatabaseId(store, parsed.db);
        const pull = repo?.pulls.get(parsed.num);
        if (!repo || !pull) return null;
        return field.children ? applySelection(ctx, 'PullRequest', { ...pull, __repo: repo } as unknown as Val, field.children, field.fragments) : pull;
      }
      return null;
    }
  }
  if (typeName === 'Mutation') {
    if (name === 'createIssue') {
      const input = (field.args['input'] ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input['repositoryId'] ?? ''));
      const repo = parsed ? repoByDatabaseId(store, parsed.db) : null;
      if (!repo) { ctx.errors.push({ message: 'repository not found' }); return null; }
      const r = createIssue(store, repo, String(input['title'] ?? ''), typeof input['body'] === 'string' ? input['body'] : '', []);
      if (!r.issue) { ctx.errors.push({ message: r.message ?? 'cannot create issue' }); return null; }
      const v = { issue: issueVal(store, repo, r.issue) };
      return field.children ? applySelection(ctx, 'CreateIssuePayload', v as unknown as Val, field.children, field.fragments) : v;
    }
    if (name === 'closeIssue') {
      const input = (field.args['input'] ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input['issueId'] ?? ''));
      const repo = parsed ? repoByDatabaseId(store, parsed.db) : null;
      const issue = repo?.issues.get(parsed?.num ?? -1);
      if (!repo || !issue) { ctx.errors.push({ message: 'issue not found' }); return null; }
      issue.state = 'closed';
      const v = { issue: issueVal(store, repo, issue) };
      return field.children ? applySelection(ctx, 'CloseIssuePayload', v as unknown as Val, field.children, field.fragments) : v;
    }
    if (name === 'createPullRequest') {
      const input = (field.args['input'] ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input['repositoryId'] ?? ''));
      const repo = parsed ? repoByDatabaseId(store, parsed.db) : null;
      if (!repo) { ctx.errors.push({ message: 'repository not found' }); return null; }
      const r = createPull(store, repo, String(input['headRefName'] ?? ''), String(input['baseRefName'] ?? ''), String(input['title'] ?? ''), typeof input['body'] === 'string' ? input['body'] : '');
      if (!r.pull) { ctx.errors.push({ message: r.message ?? 'cannot create pull request' }); return null; }
      const v = { pullRequest: pullVal(store, repo, r.pull) };
      return field.children ? applySelection(ctx, 'CreatePullRequestPayload', v as unknown as Val, field.children, field.fragments) : v;
    }
    if (name === 'mergePullRequest') {
      const input = (field.args['input'] ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input['pullRequestId'] ?? ''));
      const repo = parsed ? repoByDatabaseId(store, parsed.db) : null;
      const pull = repo?.pulls.get(parsed?.num ?? -1);
      if (!repo || !pull) { ctx.errors.push({ message: 'pull request not found' }); return null; }
      doMerge(store, repo, pull);
      const v = { pullRequest: pullVal(store, repo, pull) };
      return field.children ? applySelection(ctx, 'MergePullRequestPayload', v as unknown as Val, field.children, field.fragments) : v;
    }
    if (name === 'addComment') {
      const input = (field.args['input'] ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input['subjectId'] ?? ''));
      const repo = parsed ? repoByDatabaseId(store, parsed.db) : null;
      const issue = repo?.issues.get(parsed?.num ?? -1);
      if (!repo || !issue) { ctx.errors.push({ message: 'subject not found' }); return null; }
      repo.commentSeq += 1;
      const comment = { id: repo.commentSeq, body: String(input['body'] ?? ''), user: store.viewer() };
      issue.comments.push(comment);
      const node = { id: gqlId('C', repo.databaseId, comment.id), body: comment.body };
      const v = { commentEdge: { node } };
      return field.children ? applySelection(ctx, 'AddCommentPayload', v as unknown as Val, field.children, field.fragments) : v;
    }
  }
  // Type-specific fields on plain values
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeName === 'User') { if (name === 'login') return v['login']; if (name === 'id') return gqlId('U', 1000, 0); }
    if (typeName === 'Repository') {
      const repo = value as unknown as Repo;
      if (name === 'id') return gqlId('R', repo.databaseId, 0);
      if (name === 'databaseId') return repo.databaseId;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner ?? store.viewer()}/${repo.name}`;
      if (name === 'description') return repo.description;
      if (name === 'owner') {
        const o = { login: repo.owner ?? store.viewer() };
        return field.children ? applySelection(ctx, 'User', o as unknown as Val, field.children, field.fragments) : o;
      }
      if (name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return null;
        const b = { name: repo.defaultBranch };
        return field.children ? applySelection(ctx, 'Ref', b as unknown as Val, field.children, field.fragments) : b;
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'issue') {
        const issue = repo.issues.get(Number(field.args['number'] ?? -1));
        if (!issue) return null;
        return field.children ? applySelection(ctx, 'Issue', { ...issue, __repo: repo } as unknown as Val, field.children, field.fragments) : issueVal(store, repo, issue);
      }
      if (name === 'issues') return issuesConnection(ctx, store, repo, field);
      if (name === 'pullRequests') return pullsConnection(ctx, store, repo, field);
      if (name === 'pullRequest') {
        const pull = repo.pulls.get(Number(field.args['number'] ?? -1));
        if (!pull) return null;
        return field.children ? applySelection(ctx, 'PullRequest', { ...pull, __repo: repo } as unknown as Val, field.children, field.fragments) : pullVal(store, repo, pull);
      }
    }
    if (typeName === 'Issue') {
      const issue = value as unknown as Issue;
      const repo = (v['__repo'] as Repo | undefined) ?? null;
      if (name === 'id') return repo ? gqlId('I', repo.databaseId, issue.number) : `I_0_${issue.number}`;
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'body') return issue.body;
      if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'createdAt') return issue.createdAt;
      if (name === 'url') return '';
    }
    if (typeName === 'PullRequest') {
      const pull = value as unknown as Pull;
      const repo = (v['__repo'] as Repo | undefined) ?? null;
      if (name === 'id') return repo ? gqlId('PR', repo.databaseId, pull.number) : `PR_0_${pull.number}`;
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'headRefName') return pull.head;
      if (name === 'baseRefName') return pull.base;
      if (name === 'mergeable') return repo ? (mergeConflict(store, repo, pull) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN';
      if (name === 'merged') return pull.merged;
      if (name === 'files') {
        if (!repo) return { nodes: [] };
        const first = Number(field.args['first'] ?? 100);
        const nodes = pull.changedPaths.slice(0, first).map((p) => ({ path: p }));
        const conn = { nodes };
        return field.children ? applySelection(ctx, 'PullRequestFileConnection', conn as unknown as Val, field.children, field.fragments) : conn;
      }
    }
    if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestFileConnection') {
      if (name === 'nodes') {
        const nodes = (v['nodes'] as unknown[]) ?? [];
        const childType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestFile';
        if (!field.children) return nodes;
        return nodes.map((n) => applySelection(ctx, childType, n as Val, field.children!, field.fragments));
      }
      if (name === 'edges') return ((v['nodes'] as unknown[]) ?? []).map((n) => ({ node: n, cursor: '' }));
      if (name === 'pageInfo') {
        const pi = (v['pageInfo'] as Record<string, unknown>) ?? { hasNextPage: false, endCursor: null };
        return field.children ? applySelection(ctx, 'PageInfo', pi as Val, field.children, field.fragments) : pi;
      }
      if (name === 'totalCount') return ((v['nodes'] as unknown[]) ?? []).length;
    }
    if (typeName === 'PageInfo') {
      if (name === 'hasNextPage') return v['hasNextPage'] ?? false;
      if (name === 'hasPreviousPage') return false;
      if (name === 'endCursor') return v['endCursor'] ?? null;
      if (name === 'startCursor') return v['startCursor'] ?? null;
    }
    if (typeName === 'Ref') { if (name === 'name') return v['name']; }
    if (typeName === 'PullRequestFile') { if (name === 'path') return v['path']; }
    // Payload wrappers: issue / pullRequest / commentEdge passthrough
    if (name === 'issue' || name === 'pullRequest') {
      const inner = v[name] as Val;
      if (!inner) return null;
      const t = name === 'issue' ? 'Issue' : 'PullRequest';
      return field.children ? applySelection(ctx, t, inner, field.children, field.fragments) : inner;
    }
    if (name === 'commentEdge') {
      const edge = v['commentEdge'] as Val;
      if (!edge) return null;
      return field.children ? applySelection(ctx, 'CommentEdge', edge, field.children, field.fragments) : edge;
    }
    if (typeName === 'CommentEdge') {
      if (name === 'node') {
        const node = v['node'] as Val;
        return field.children ? applySelection(ctx, 'IssueComment', node, field.children, field.fragments) : node;
      }
    }
    if (typeName === 'IssueComment') {
      if (name === 'id') return v['id'];
      if (name === 'body') return v['body'];
    }
    if (name === 'fields' && v['fields']) {
      const fields = v['fields'] as { name: string }[];
      return fields.map((f) => (field.children ? applySelection(ctx, 'Field', f as unknown as Val, field.children!, field.fragments) : f));
    }
    if (name === 'enumValues' && v['enumValues']) {
      const ev = v['enumValues'] as { name: string }[];
      return ev.map((e) => (field.children ? applySelection(ctx, 'EnumValue', e as unknown as Val, field.children!, field.fragments) : e));
    }
    if ((typeName === 'Field' || typeName === 'EnumValue') && name === 'name') return v['name'];
    if (name === 'kind') return v['kind'];
    // Unknown field on a known type: record an error, return null.
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
    return null;
  }
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
  return null;
}
function issueVal(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  void store;
  return { ...issue, id: gqlId('I', repo.databaseId, issue.number), __repo: repo };
}
function pullVal(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  void store;
  return { ...pull, id: gqlId('PR', repo.databaseId, pull.number), __repo: repo };
}
function issuesConnection(ctx: Ctx, store: Store, repo: Repo, field: GField): Record<string, unknown> {
  const args = field.args;
  let list = [...repo.issues.values()];
  const states = args['states'];
  if (Array.isArray(states)) {
    const want = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => want.has(i.state));
  }
  const orderBy = args['orderBy'] as Record<string, unknown> | undefined;
  const dir = String(orderBy?.['direction'] ?? 'ASC').toUpperCase();
  list.sort((a, b) => (dir === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  const after = typeof args['after'] === 'string' ? args['after'] : null;
  if (after) {
    const m = /^n:(\d+)$/.exec(unb64(after));
    if (m) {
      const idx = list.findIndex((i) => i.number === Number(m[1]));
      if (idx >= 0) list = list.slice(idx + 1);
    }
  }
  const first = Number(args['first'] ?? list.length);
  const page = list.slice(0, first);
  const hasNext = list.length > first;
  const endCursor = page.length ? b64(`n:${page[page.length - 1]!.number}`) : null;
  const conn = { nodes: page.map((i) => ({ ...i, __repo: repo })), pageInfo: { hasNextPage: hasNext, endCursor } };
  if (!field.children) return conn;
  return applySelection(ctx, 'IssueConnection', conn as unknown as Val, field.children, field.fragments);
}
function pullsConnection(ctx: Ctx, store: Store, repo: Repo, field: GField): Record<string, unknown> {
  const args = field.args;
  const list = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
  const first = Number(args['first'] ?? list.length);
  const page = list.slice(0, first);
  const conn = { nodes: page.map((p) => ({ ...p, __repo: repo })), pageInfo: { hasNextPage: list.length > first, endCursor: null } };
  if (!field.children) return conn;
  return applySelection(ctx, 'PullRequestConnection', conn as unknown as Val, field.children, field.fragments);
}

function executeGraphQL(store: Store, body: unknown): unknown {
  const runOne = (op: unknown): Record<string, unknown> => {
    if (!isJson(op) || typeof op['query'] !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
    const vars = isJson(op['variables']) ? (op['variables'] as Record<string, unknown>) : {};
    const ctx: Ctx = { store, errors: [] };
    try {
      const parser = new GParser(op['query'], vars);
      const parsed = parser.parseOperation();
      const rootType = parsed.kind === 'mutation' ? 'Mutation' : 'Query';
      const data = applySelection(ctx, rootType, {} as Val, parsed.fields, []);
      const out: Record<string, unknown> = { data };
      if (ctx.errors.length) out['errors'] = ctx.errors;
      return out;
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(body)) return body.map((op) => runOne(op));
  return runOne(body);
}

// ---- MCP ----
interface McpTool { name: string; description: string; inputSchema: { type: string; properties: Record<string, unknown>; required: string[] }; }
const MCP_TOOLS: McpTool[] = [
  { name: 'create_repo', description: 'Create a repository owned by the viewer.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed, or all' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
];
function normName(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function mcpResolveRepo(store: Store, args: Record<string, unknown>): Repo | null {
  let owner = typeof args['owner'] === 'string' ? args['owner'] : '';
  let name = typeof args['repo'] === 'string' ? args['repo'] : '';
  if ((!owner || !name) && typeof args['full_name'] === 'string') {
    const parts = args['full_name'].split('/');
    if (parts.length === 2) { owner = owner || parts[0]!; name = name || parts[1]!; }
  }
  if (!owner || !name) return null;
  return store.resolveRepo(owner, name);
}
function mcpText(obj: unknown): { content: { type: string; text: string }[]; structuredContent: unknown; isError?: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}
function mcpErrorResult(message: string): { content: { type: string; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store, body: Buffer): Promise<void> {
  const sendRpc = (status: number, payload: unknown): void => { sendJson(res, status, payload); };
  let parsed: unknown;
  try { parsed = parseJsonBody(body); } catch {
    sendRpc(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isJson(parsed) || typeof parsed['method'] !== 'string') {
    sendRpc(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const id = parsed['id'] ?? null;
  const method = parsed['method'] as string;
  const params = isJson(parsed['params']) ? (parsed['params'] as Record<string, unknown>) : {};
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202); res.end(); return;
  }
  if (method === 'ping') { sendRpc(200, { jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'server/discover') {
    sendRpc(200, { jsonrpc: '2.0', id, result: {
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: {} },
      serverInfo: { name: 'github-forge', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-forge', version: '1.0.0' } },
    } });
    return;
  }
  if (method === 'initialize') {
    const offered = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '2026-07-28';
    const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    sendRpc(200, { jsonrpc: '2.0', id, result: {
      protocolVersion: supported.includes(offered) ? offered : '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: 'github-forge', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-forge', version: '1.0.0' } },
    } });
    return;
  }
  if (method === 'tools/list') {
    sendRpc(200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params['name'] === 'string' ? params['name'] : '';
    const args = isJson(params['arguments']) ? (params['arguments'] as Record<string, unknown>) : {};
    const norm = normName(name);
    const match = (canonical: string): boolean => norm === normName(canonical) || norm.endsWith(normName(canonical));
    const rpcErr = (code: number, message: string): void => { sendRpc(200, { jsonrpc: '2.0', id, error: { code, message } }); };
    const result = (r: unknown): void => { sendRpc(200, { jsonrpc: '2.0', id, result: r }); };
    if (match('create_repo') || match('create_repository') || match('repo_create')) {
      const rname = typeof args['name'] === 'string' ? args['name'] : typeof args['repo'] === 'string' ? args['repo'] : '';
      if (!rname) { result(mcpErrorResult('name is required')); return; }
      const owner = typeof args['owner'] === 'string' ? args['owner'] : '';
      if (owner) store.bindViewer(owner);
      const existing = store.getRepo(rname);
      if (existing) { result(mcpText(store.repoJson(existing))); return; }
      const repo = store.createRepo(rname, args['private'] === true, typeof args['description'] === 'string' ? args['description'] : '');
      if (!repo) { result(mcpErrorResult('could not create repository')); return; }
      if (owner) repo.owner = owner;
      result(mcpText(store.repoJson(repo))); return;
    }
    if (match('get_repo') || match('get_repository')) {
      const repo = mcpResolveRepo(store, args);
      if (!repo) { result(mcpErrorResult('repository not found')); return; }
      result(mcpText(store.repoJson(repo))); return;
    }
    if (match('create_issue') || match('issue_create')) {
      const title = typeof args['title'] === 'string' ? args['title'] : '';
      const repo = mcpResolveRepo(store, args);
      if (!title || !repo) { result(mcpErrorResult('owner, repo and title are required')); return; }
      const r = createIssue(store, repo, title, typeof args['body'] === 'string' ? args['body'] : '', []);
      if (!r.issue) { result(mcpErrorResult(r.message ?? 'cannot create issue')); return; }
      result(mcpText(store.issueJson(repo, r.issue))); return;
    }
    if (match('list_issues') || match('issues_list')) {
      const repo = mcpResolveRepo(store, args);
      if (!repo) { result(mcpErrorResult('repository not found')); return; }
      let list = [...repo.issues.values()];
      const state = typeof args['state'] === 'string' ? args['state'] : 'open';
      if (state !== 'all') list = list.filter((i) => i.state === state);
      result(mcpText(list.map((i) => store.issueJson(repo, i)))); return;
    }
    if (match('create_pull_request') || match('create_pr') || match('pr_create')) {
      const repo = mcpResolveRepo(store, args);
      const title = typeof args['title'] === 'string' ? args['title'] : '';
      const head = typeof args['head'] === 'string' ? args['head'] : '';
      const base = typeof args['base'] === 'string' ? args['base'] : '';
      if (!repo || !title || !head || !base) { result(mcpErrorResult('owner, repo, title, head and base are required')); return; }
      const r = createPull(store, repo, head, base, title, typeof args['body'] === 'string' ? args['body'] : '');
      if (!r.pull) { result(mcpErrorResult(r.message ?? 'cannot create pull request')); return; }
      result(mcpText(store.pullJson(repo, r.pull))); return;
    }
    if (match('merge_pull_request') || match('merge_pr') || match('pr_merge')) {
      const repo = mcpResolveRepo(store, args);
      const num = Number(args['pull_number'] ?? args['number'] ?? args['pull_request_number']);
      if (!repo || !Number.isInteger(num)) { result(mcpErrorResult('owner, repo and pull_number are required')); return; }
      const pull = repo.pulls.get(num);
      if (!pull) { result(mcpErrorResult('pull request not found')); return; }
      const r = doMerge(store, repo, pull);
      if (!r.ok) { result(mcpErrorResult(r.reason ?? 'cannot merge')); return; }
      result(mcpText({ merged: true, sha: r.sha, number: pull.number })); return;
    }
    rpcErr(-32602, `unknown tool ${name}`);
    return;
  }
  sendRpc(200, { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

// ---- dispatcher ----
export function createApp(): Server {
  const store = new Store(TOKEN);
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const parts = pathParts(req);
      const method = req.method ?? 'GET';
      try {
        if (method === 'GET' && parts.length === 0) { sendJson(res, 200, { ok: true }); return; }
        // healthz takes no auth
        if (method === 'GET' && parts.length === 1 && parts[0] === 'healthz') { sendJson(res, 200, { ok: true }); return; }
        if (!authed(req, store)) { sendJson(res, 401, { message: 'Bad credentials' }); return; }
        const body = await readBody(req);
        // REST v3
        if (parts[0] === 'api' && parts[1] === 'v3') {
          // Malformed JSON on a REST POST with a body is 400.
          if ((method === 'POST' || method === 'PATCH' || method === 'PUT') && body.length > 0) {
            try { parseJsonBody(body); } catch { sendJson(res, 400, { message: 'malformed JSON body' }); return; }
          }
          const handled = await handleRest(req, res, store, parts, body);
          if (!handled) sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        // GraphQL
        if (parts[0] === 'api' && parts[1] === 'graphql') {
          if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
          let parsed: unknown;
          try { parsed = parseJsonBody(body); } catch { sendJson(res, 400, { message: 'malformed JSON body' }); return; }
          sendJson(res, 200, executeGraphQL(store, parsed));
          return;
        }
        // MCP
        if (parts[0] === 'mcp') {
          if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
          await handleMcp(req, res, store, body);
          return;
        }
        // Git smart HTTP: /{owner}/{repo}.git/...
        if (parts.length >= 2 && parts[1]!.endsWith('.git')) {
          await handleGit(req, res, store, parts, body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        try { sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) }); } catch { /* socket gone */ }
      }
    })();
  });
}
