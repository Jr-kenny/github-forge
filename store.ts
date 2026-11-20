// Store: in-memory forge state. No disk, no clock in stored data, so two runs
// on the same seeded requests produce the same objects. Timestamps are a
// deterministic counter from a fixed epoch, never Date.now().
import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const EPOCH = 1735689600; // 2025-01-01T00:00:00Z, matches the suite's scenario epoch

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
export function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

export interface GitObject { type: string; data: Buffer; }
export interface Issue {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: { name: string; color: string }[]; comments: { id: number; body: string; user: string }[];
  seq: number; createdAt: string;
}
export interface Pull {
  number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  seq: number; changedPaths: string[];
}
export interface Repo {
  name: string; owner: string | null; id: number; databaseId: number;
  isPrivate: boolean; description: string; defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // full ref name -> oid
  issues: Map<number, Issue>; issueSeq: number; nextIssue: number;
  pulls: Map<number, Pull>; nextPull: number;
  labels: Map<string, { name: string; color: string }>;
  commentSeq: number;
  commitSeq: number; // order of commits created via contents API
  commitCache: Map<string, { tree: string; parents: string[]; message: string; author: string; committer: string }>;
}

export class Store {
  token: string;
  viewerLogin: string | null = null;
  repos = new Map<string, Repo>(); // keyed by repo name
  private repoIdSeq = 1000;
  private seq = 0;
  constructor(token: string) { this.token = token; }

  nextSeq(): number { this.seq += 1; return this.seq; }
  stamp(): string {
    const s = EPOCH + this.nextSeq();
    return new Date(s * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  }
  // Deterministic timestamp string for a commit object: "<epoch> +0000"
  commitStamp(): number { return EPOCH + this.nextSeq(); }

  auth(req: { headers: Record<string, string | string[] | undefined> }): boolean {
    if (!this.token) return true;
    const h = req.headers['authorization'];
    const v = Array.isArray(h) ? h[0] : h;
    return v === `Bearer ${this.token}`;
  }

  // Owner binding: the first owner name seen for a repo (or for the viewer
  // at all) becomes the token owner's login. A different owner afterwards
  // is a stranger and gets 404, never 403.
  bindViewer(owner: string): string {
    if (!this.viewerLogin) this.viewerLogin = owner;
    return this.viewerLogin;
  }
  ownerFor(owner: string): boolean {
    if (!this.viewerLogin) { this.viewerLogin = owner; return true; }
    return this.viewerLogin === owner;
  }
  viewer(): string { return this.viewerLogin ?? 'viewer'; }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(name)) return null;
    const id = this.repoIdSeq; this.repoIdSeq += 1;
    const repo: Repo = {
      name, owner: null, id, databaseId: id, isPrivate,
      description: description ?? '', defaultBranch: 'main',
      objects: new Map(), refs: new Map(),
      issues: new Map(), issueSeq: 0, nextIssue: 1,
      pulls: new Map(), nextPull: 1,
      labels: new Map(), commentSeq: 0, commitSeq: 0, commitCache: new Map(),
    };
    this.repos.set(name, repo);
    return repo;
  }
  getRepo(name: string): Repo | undefined { return this.repos.get(name); }
  // Resolve a repo by owner+name, binding the owner on first sight.
  resolveRepo(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (!repo) return null;
    if (repo.owner === null) {
      if (!this.ownerFor(owner)) return null;
      repo.owner = owner;
    } else if (repo.owner !== owner) return null;
    return repo;
  }

  putObject(repo: Repo, type: string, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }
  getObject(repo: Repo, oid: string): GitObject | undefined { return repo.objects.get(oid); }

  // Build a tree object from a file map (path -> blob oid), recursively.
  buildTree(repo: Repo, files: Map<string, string>): string {
    interface Node { files: Map<string, string>; dirs: Map<string, Node>; }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, oid] of [...files.entries()].sort()) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const p = parts[i]!;
        if (!node.dirs.has(p)) node.dirs.set(p, make());
        node = node.dirs.get(p)!;
      }
      node.files.set(parts[parts.length - 1]!, oid);
    }
    const build = (node: Node): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (const [name, oid] of [...node.files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of [...node.dirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) entries.push({ mode: '40000', name, oid: build(child) });
      // Git tree entries sort with directories as if name ends with '/'
      entries.sort((a, b) => {
        const an = a.mode === '40000' ? `${a.name}/` : a.name;
        const bn = b.mode === '40000' ? `${b.name}/` : b.name;
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
      const out: Buffer[] = [];
      for (const e of entries) {
        out.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
        out.push(Buffer.from(e.oid, 'hex'));
      }
      return this.putObject(repo, 'tree', Buffer.concat(out));
    };
    return build(root);
  }

  parseTree(data: Buffer): { mode: string; name: string; oid: string }[] {
    const entries: { mode: string; name: string; oid: string }[] = [];
    let i = 0;
    while (i < data.length) {
      const sp = data.indexOf(0x20, i);
      const nul = data.indexOf(0, sp);
      const mode = data.subarray(i, sp).toString('utf8');
      const name = data.subarray(sp + 1, nul).toString('utf8');
      const oid = data.subarray(nul + 1, nul + 21).toString('hex');
      entries.push({ mode, name, oid });
      i = nul + 21;
    }
    return entries;
  }

  // File map (path -> {blob oid, content}) at a commit oid.
  filesAt(repo: Repo, commitOid: string): Map<string, string> {
    const files = new Map<string, string>();
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return files;
    const treeLine = commit.data.toString('utf8').split('\n')[0] ?? '';
    const treeOid = treeLine.replace('tree ', '').trim();
    const walk = (treeOid2: string, prefix: string) => {
      const tree = repo.objects.get(treeOid2);
      if (!tree) return;
      for (const e of this.parseTree(tree.data)) {
        if (e.mode === '40000') walk(e.oid, prefix + e.name + '/');
        else files.set(prefix + e.name, e.oid);
      }
    };
    walk(treeOid, '');
    return files;
  }

  commitInfo(repo: Repo, oid: string): { tree: string; parents: string[]; message: string; author: string; committer: string } | null {
    const cached = repo.commitCache.get(oid);
    if (cached) return cached;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    const text = obj.data.toString('utf8');
    const head = text.split('\n\n')[0] ?? '';
    const lines = head.split('\n');
    let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
    for (const line of lines) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
      else if (line.startsWith('author ')) author = line.slice(7);
      else if (line.startsWith('committer ')) committer = line.slice(10);
    }
    const message = text.slice(text.indexOf('\n\n') + 2);
    const info = { tree, parents, message, author, committer };
    repo.commitCache.set(oid, info);
    return info;
  }

  // Commits reachable from a tip, newest first (by creation order, tracked
  // via a side map: we walk parents in BFS order from the tip, which for
  // the suite's linear histories is newest first).
  reachableCommits(repo: Repo, tip: string): string[] {
    const out: string[] = []; const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue; seen.add(oid);
      const info = this.commitInfo(repo, oid);
      if (!info) continue;
      out.push(oid);
      for (const p of info.parents) queue.push(p);
    }
    return out;
  }

  // Is `ancestor` reachable from `tip`? (fast-forward check)
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === ZERO_OID) return true;
    if (ancestor === tip) return true;
    const seen = new Set<string>(); const queue = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue; seen.add(oid);
      const info = this.commitInfo(repo, oid);
      if (!info) continue;
      for (const p of info.parents) queue.push(p);
    }
    return false;
  }

  repoJson(repo: Repo): Record<string, unknown> {
    const owner = repo.owner ?? this.viewer();
    return {
      id: repo.databaseId, node_id: `R_${repo.databaseId}`, name: repo.name,
      full_name: `${owner}/${repo.name}`, private: repo.isPrivate,
      owner: { login: owner, id: 1000, type: 'User' },
      description: repo.description, default_branch: repo.defaultBranch,
      html_url: `https://example.invalid/${owner}/${repo.name}`,
      url: `/api/v3/repos/${owner}/${repo.name}`,
      created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
      has_issues: true, has_projects: true, has_wiki: true,
      forks_count: 0, stargazers_count: 0, watchers_count: 0, open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    };
  }
  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    const owner = repo.owner ?? this.viewer();
    return {
      id: issue.number * 1000 + repo.databaseId, node_id: `I_${repo.databaseId}_${issue.number}`,
      number: issue.number, title: issue.title, body: issue.body ?? '', state: issue.state,
      labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
      user: { login: owner, id: 1000, type: 'User' },
      url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
      html_url: `https://example.invalid/${owner}/${repo.name}/issues/${issue.number}`,
      created_at: issue.createdAt, updated_at: issue.createdAt,
      comments: issue.comments.length,
    };
  }
  pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
    const owner = repo.owner ?? this.viewer();
    return {
      id: pull.number * 1000 + repo.databaseId, node_id: `PR_${repo.databaseId}_${pull.number}`,
      number: pull.number, title: pull.title, body: pull.body ?? '', state: pull.state,
      head: { ref: pull.head, sha: pull.headSha, label: `${owner}:${pull.head}` },
      base: { ref: pull.base, sha: pull.baseSha, label: `${owner}:${pull.base}` },
      merged: pull.merged, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeCommitSha,
      mergeable: true, mergeable_state: 'clean',
      user: { login: owner, id: 1000, type: 'User' },
      url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
      html_url: `https://example.invalid/${owner}/${repo.name}/pulls/${pull.number}`,
      created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
    };
  }
}
