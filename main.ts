// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format (unified diff,
// SEARCH/REPLACE blocks, V4A patches, JSON edits). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  br: '\n' | '\r\n';
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const parts = text.split(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Moves recorded by move edits, for the `R` output lines (section 2). */
const moves: { old: string; nw: string }[] = [];

/** Line normalisation at a matching tier (section 5). */
function norm(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leading(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Every 0-based position where O occurs in lines at tier. */
function occurrences(lines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const nO = O.map((l) => norm(l, tier));
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (norm(lines[i + j]!, tier) !== nO[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once at or after `from`, with its occurrences. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, O, t).filter((p) => p >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of a replacement block: `ctx` lines are written as the file's own matched line. */
interface NLine {
  text: string;
  ctx: boolean;
  oIndex: number;
}

/** Build the replacement lines for an occurrence of O at pos (section 5). */
function buildNew(fileLines: string[], O: string[], N: NLine[], pos: number, tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && O.length > 0) {
    f = leading(fileLines[pos]!);
    p = leading(O[0]!);
  }
  return N.map((nl) => {
    if (nl.ctx) return fileLines[pos + nl.oIndex]!;
    if (tier === 2) {
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    }
    return nl.text;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Unified diffs (SPEC.md section 6). */

interface HunkBodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}
interface Hunk {
  a: number;
  body: HunkBodyLine[];
  O: string[];
  N: NLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  noEol: boolean;
}
interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  gitOld: string | null;
  gitNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_HEAD = /^diff --git a\/(.+?) b\/(.+)$/;

/** The path of a `--- ` / `+++ ` line: text after the four characters, up to the first tab, trimmed. */
function parseDiffPath(line: string): string | null {
  const t = line.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return t.replace(/^a\//, '').replace(/^b\//, '');
}

function buildHunk(a: number, raw: string[]): Hunk {
  const body: HunkBodyLine[] = raw.map((l) => {
    if (l === '') return { kind: 'ctx', text: '' };
    if (l[0] === ' ') return { kind: 'ctx', text: l.slice(1) };
    if (l[0] === '-') return { kind: 'old', text: l.slice(1) };
    if (l[0] === '+') return { kind: 'new', text: l.slice(1) };
    return { kind: 'bs', text: l };
  });
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      O.push(b.text);
      N.push({ text: b.text, ctx: true, oIndex: O.length - 1 });
    } else if (b.kind === 'old') O.push(b.text);
    else if (b.kind === 'new') N.push({ text: b.text, ctx: false, oIndex: -1 });
  }
  let noEol = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b.kind === 'ctx' || b.kind === 'new') {
      noEol = k + 1 < body.length && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  return { a, body, O, N, noEol };
}

/** Apply one hunk to a file's lines (section 6). */
function applyHunk(f: FileState, h: Hunk, d: number, strict: boolean, path: string): FileState {
  if (h.O.length > 0) {
    const found = findTier(f.lines, h.O, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const nl = buildNew(f.lines, h.O, h.N, best, found.tier);
    const lines = [...f.lines.slice(0, best), ...nl, ...f.lines.slice(best + h.O.length)];
    const atEnd = best + h.O.length === f.lines.length;
    return { br: f.br, lines, finalBreak: atEnd ? !h.noEol : f.finalBreak };
  }
  const idx = Math.max(0, Math.min(h.a + d, f.lines.length));
  const nl = h.N.map((x) => x.text);
  const lines = [...f.lines.slice(0, idx), ...nl, ...f.lines.slice(idx)];
  const atEnd = idx === f.lines.length;
  return { br: f.br, lines, finalBreak: atEnd ? !h.noEol : f.finalBreak };
}

/** Whether a `\` line follows the last `+` line of a section's hunks (created files). */
function creationNoEol(hunks: Hunk[]): boolean {
  let noEol = false;
  for (const h of hunks) {
    for (let k = h.body.length - 1; k >= 0; k--) {
      if (h.body[k]!.kind === 'new') {
        noEol = k + 1 < h.body.length && h.body[k + 1]!.kind === 'bs';
        break;
      }
    }
  }
  return noEol;
}

function resolveSection(sec: Section): { oldP: string | null; newP: string | null } {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.gitOld;
  const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : sec.gitNew;
  return { oldP, newP };
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const { oldP, newP } = resolveSection(sec);
    const isCreate = sec.isCreate || oldP === null;
    const isDelete = !isCreate && (sec.isDelete || newP === null);
    if (isCreate) {
      const np = newP;
      if (np === null) return;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const lines: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') lines.push(b.text);
      const noEol = creationNoEol(sec.hunks);
      tree.now.set(np, lines.length === 0 ? '' : lines.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = oldP;
      if (op === null) return;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP;
    const np = newP;
    if (op === null || np === null) return;
    if (op !== np) {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      let f = splitFile(cur);
      let d = 0;
      for (const h of sec.hunks) {
        f = applyHunk(f, h, d, strict, op);
        d += h.N.length - h.O.length;
      }
      tree.now.set(op, null);
      tree.now.set(np, joinFile(f));
      moves.push({ old: op, nw: np });
      return;
    }
    if (!safe(op)) throw new Fail('unsafe', op);
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    let f = splitFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      f = applyHunk(f, h, d, strict, op);
      d += h.N.length - h.O.length;
    }
    tree.now.set(op, joinFile(f));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let inHeader = false;
  let sawPair = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = GIT_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = {
        pairOld: undefined,
        pairNew: undefined,
        renameOld: undefined,
        renameNew: undefined,
        gitOld: m[1]!.trim(),
        gitNew: m[2]!.trim(),
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      sections.push(sec);
      inHeader = true;
      sawPair = false;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      const raw: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          raw.push(b);
          i++;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1]!.trim() === '') raw.pop();
      sec.hunks.push(buildHunk(a, raw));
      inHeader = false;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const po = parseDiffPath(l);
      const pn = parseDiffPath(lines[i + 1]!);
      if (sec !== null && inHeader && !sawPair) {
        sec.pairOld = po;
        sec.pairNew = pn;
        sawPair = true;
      } else {
        sec = {
          pairOld: po,
          pairNew: pn,
          renameOld: undefined,
          renameNew: undefined,
          gitOld: null,
          gitNew: null,
          isCreate: false,
          isDelete: false,
          hunks: [],
        };
        sections.push(sec);
        inHeader = true;
        sawPair = true;
      }
      i += 2;
      continue;
    }
    if (sec !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        sec.renameOld = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renameNew = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.isCreate = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const nl = buildNew(
      f.lines,
      oldLines,
      newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 })),
      pos,
      found.tier,
    );
    const lines = [...f.lines.slice(0, pos), ...nl, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ br: f.br, lines, finalBreak: f.finalBreak }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let lastReplaceEnd = -1;
  let prevPath: string | null = null;
  for (;;) {
    let sIdx = -1;
    for (let k = i; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        sIdx = k;
        break;
      }
    }
    if (sIdx < 0) break;
    let path: string | null = null;
    for (let k = sIdx - 1; k > lastReplaceEnd; k--) {
      const t = lines[k]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    let eqIdx = -1;
    for (let k = sIdx + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[k]!.trimEnd() === '=======') {
        eqIdx = k;
        break;
      }
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let repIdx = -1;
    for (let k = eqIdx + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = k;
        break;
      }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    edits.push(makeSREdit(path, oldLines, newLines, strict));
    prevPath = path;
    lastReplaceEnd = repIdx;
    i = repIdx + 1;
  }
  return edits;
}

/** V4A patches (SPEC.md section 8). */

interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

/** Split a chunk's body lines into old lines O and replacement lines N. */
function chunkON(body: string[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const l of body) {
    if (l === '' || l[0] === ' ') {
      const text = l === '' ? '' : l.slice(1);
      O.push(text);
      N.push({ text, ctx: true, oIndex: O.length - 1 });
    } else if (l[0] === '-') O.push(l.slice(1));
    else if (l[0] === '+') N.push({ text: l.slice(1), ctx: false, oIndex: -1 });
  }
  return { O, N };
}

function makeVUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt: number | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (norm(f.lines[k]!, t) === norm(ch.anchor, t)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const { O, N } = chunkON(ch.body);
      if (O.length === 0) {
        const idx = ch.eof ? f.lines.length : cursor;
        const nl = N.map((x) => x.text);
        f.lines.splice(idx, 0, ...nl);
        cursor = idx + nl.length;
      } else {
        const found = findTier(f.lines, O, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let pos: number | null = null;
        if (ch.eof) {
          for (const p of found.occ) {
            if (p + O.length === f.lines.length) {
              pos = p;
              break;
            }
          }
        } else {
          pos = found.occ[0]!;
        }
        if (pos === null) throw new Fail('no-match', path);
        const nl = buildNew(f.lines, O, N, pos, found.tier);
        f.lines.splice(pos, O.length, ...nl);
        cursor = pos + nl.length;
      }
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (s: string): boolean =>
    s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ');
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const fileLines: string[] = [];
      while (i < last) {
        const s = lines[i]!;
        if (isSectionStart(s)) break;
        if (s.startsWith('+')) {
          fileLines.push(s.slice(1));
          i++;
        } else if (s === '') {
          fileLines.push('');
          i++;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(((p: string, fl: string[]): Edit => (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
      })(path, fileLines));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const s = lines[i]!;
        if (blank(s)) {
          i++;
          continue;
        }
        if (isSectionStart(s)) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(((p: string): Edit => (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      })(path));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      while (i < last && blank(lines[i]!)) i++;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const flush = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const s = lines[i]!;
        if (isSectionStart(s)) break;
        if (s.startsWith('@@')) {
          flush();
          const anchor = s.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          i++;
          continue;
        }
        if (s.trim() === '*** End of File') {
          if (cur === null) cur = { anchor: null, body: [], eof: true };
          else cur.eof = true;
          flush();
          i++;
          continue;
        }
        if (s.startsWith('***')) throw new Exit2(`error: parse ${i + 1}`);
        if (s === '' || s.startsWith(' ') || s.startsWith('-') || s.startsWith('+')) {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push(s);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      flush();
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1]!.trim() === '') lastChunk.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(makeVUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  moves.length = 0;
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Changed paths, with move edits reported as one `R` line sorted by the new path (section 2).
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const m of moves) {
    const o = changed.get(m.old);
    const n = changed.get(m.nw);
    if (o !== undefined && o.was !== null && o.now === null && n !== undefined && n.was === null && n.now !== null) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      consumed.add(m.old);
      consumed.add(m.nw);
    }
  }
  for (const [p, c] of changed) {
    if (consumed.has(p)) continue;
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, c] of changed) {
      if (c.now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
