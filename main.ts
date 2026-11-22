// mend: one patch tool for every AI edit format. Node 22, standard library only.
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// with the working directory as the root of a tree of text files.
// makefun anchor 5b56d0936186f459d3d3abbcb5d5cbddf31c400c round 34184722

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to end the run with exit code 2 and one output line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed; the run reports it and keeps going with the next edit. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** State shared by the edits of one run: the moves they performed. */
interface Fx {
  moves: Array<{ old: string; next: string }>;
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

const stripTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0];

/** A file as lines: its line break, its lines, and whether it ends with a break. */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
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

type Edit = (tree: Tree, fx: Fx) => void;

/** One line of an old block (O) or a new block (N). Context lines carry their O index. */
interface Line {
  text: string;
  ctx: boolean;
  o: number;
}

const ctxLine = (text: string, o: number): Line => ({ text, ctx: true, o });
const plainLine = (text: string): Line => ({ text, ctx: false, o: -1 });

function matchLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions where O occurs in lines at one tier (occurrences may overlap). */
function findOccurrences(lines: string[], o: Line[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!matchLine(lines[i + j]!, o[j]!.text, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs in lines (from `from`), with its positions. */
function firstTier(
  lines: string[],
  o: Line[],
  tiers: number[],
  from = 0,
): { tier: number; positions: number[] } | null {
  for (const tier of tiers) {
    const positions = findOccurrences(lines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/**
 * Replace O at position `pos` by N. Context lines of N are written as the file's own
 * matched lines; at tier 2 every other line of N is re-indented from O's first line
 * onto the file's first matched line.
 */
function replaceLines(lines: string[], pos: number, o: Line[], n: Line[], tier: number): string[] {
  const out: string[] = [];
  const f = tier === 2 && o.length > 0 ? leadingWs(lines[pos]!) : '';
  const p = tier === 2 && o.length > 0 ? leadingWs(o[0]!.text) : '';
  for (const e of n) {
    if (e.ctx) {
      out.push(lines[pos + e.o]!);
      continue;
    }
    let t = e.text;
    if (tier === 2 && t !== '' && /\S/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + o.length)];
}

function tiersFor(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/** One hunk of a unified section: old lines O, new lines N, and its `@@` start. */
interface Hunk {
  a: number;
  old: Line[];
  nw: Line[];
  /** a `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** a `\` line follows the hunk's last `+` line. */
  plusNoEol: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path after `--- ` or `+++ `: text after four chars, up to a tab, trimmed, one a|b prefix off. */
function headerPath(line: string): string {
  const rest = line.slice(4).split('\t')[0]!;
  let p = rest.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2).trim();
  return p;
}

/** Read one hunk at lines[i] (a line starting with `@@`) into section; return the next index. */
function parseHunk(lines: string[], i: number, section: Section): number {
  const head = HUNK_HEAD.exec(lines[i]!);
  if (head === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(head[1]);
  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const old: Line[] = [];
  const nw: Line[] = [];
  for (const b of body) {
    if (b === '' || b[0] === ' ') {
      const text = b === '' ? '' : b.slice(1);
      const o = old.length;
      old.push(ctxLine(text, o));
      nw.push(ctxLine(text, o));
    } else if (b[0] === '-') {
      old.push(plainLine(b.slice(1)));
    } else if (b[0] === '+') {
      nw.push(plainLine(b.slice(1)));
    }
  }
  let noEol = false;
  let plusNoEol = false;
  if (body.length > 0 && body[body.length - 1]![0] === '\\') {
    const prev = body[body.length - 2];
    if (prev !== undefined && (prev === '' || prev[0] === ' ' || prev[0] === '+')) noEol = true;
  }
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k]![0] === '+') {
      plusNoEol = body[k + 1] !== undefined && body[k + 1]![0] === '\\';
      break;
    }
  }
  section.hunks.push({ a, old, nw, noEol, plusNoEol });
  return j;
}

/**
 * Read a section header at lines[i] (after its `diff --git` line, or at its `--- ` line).
 * Returns the index of the first line after the header.
 */
function parseHeader(lines: string[], i: number, section: Section): number {
  let oldFromPair = false;
  let newFromPair = false;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('@@')) break;
    if (l.startsWith('--- ')) {
      if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      section.oldPath = headerPath(l);
      section.newPath = headerPath(lines[i + 1]!);
      oldFromPair = true;
      newFromPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('rename from ')) {
      if (!oldFromPair) section.oldPath = l.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (!newFromPair) section.newPath = l.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) section.create = true;
    else if (l.startsWith('deleted file mode')) section.del = true;
    i += 1;
  }
  return i;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, create: false, del: false, hunks: [] };
      sections.push(cur);
      i = parseHeader(lines, i + 1, cur);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = { oldPath: null, newPath: null, create: false, del: false, hunks: [] };
      sections.push(cur);
      i = parseHeader(lines, i, cur);
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      i = parseHunk(lines, i, cur);
      continue;
    }
    i += 1;
  }
  return sections;
}

/** Apply one hunk to a file state; d is the line drift of this section's earlier hunks. */
function applyHunk(state: FileState, h: Hunk, d: number, strict: boolean, path: string): FileState {
  const o = h.old;
  const n = h.nw;
  if (o.length > 0) {
    const hit = firstTier(state.lines, o, tiersFor(strict));
    if (hit === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = hit.positions[0]!;
    for (const p of hit.positions) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const out = replaceLines(state.lines, best, o, n, hit.tier);
    const final =
      best + o.length === state.lines.length ? !h.noEol : state.final;
    return { br: state.br, lines: out, final };
  }
  const at = Math.min(Math.max(h.a + d, 0), state.lines.length);
  const out = [
    ...state.lines.slice(0, at),
    ...n.map((e) => e.text),
    ...state.lines.slice(at),
  ];
  const final = at === state.lines.length ? !h.noEol : state.final;
  return { br: state.br, lines: out, final };
}

/** Apply a section's hunks in order to a file's text. Throws Fail('no-match', path). */
function applyHunks(text: string, section: Section, strict: boolean, path: string): string {
  let state = parseFile(text);
  let d = 0;
  for (const h of section.hunks) {
    state = applyHunk(state, h, d, strict, path);
    d += h.nw.length - h.old.length;
  }
  return renderFile(state);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((section) => {
    return (tree: Tree, fx: Fx) => {
      const oldP = section.oldPath;
      const newP = section.newPath;
      const create = section.create || oldP === '/dev/null';
      const del = !create && (section.del || newP === '/dev/null');
      if (oldP !== null && oldP !== '/dev/null' && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && newP !== '/dev/null' && !safe(newP)) throw new Fail('unsafe', newP);
      if (create) {
        const np = newP ?? oldP;
        if (np === null || np === '/dev/null') return;
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        for (const h of section.hunks) {
          for (const e of h.nw) if (!e.ctx) plus.push(e.text);
        }
        if (plus.length === 0) {
          tree.now.set(np, '');
          return;
        }
        let noEol = false;
        for (let k = section.hunks.length - 1; k >= 0; k -= 1) {
          const h = section.hunks[k]!;
          if (h.nw.some((e) => !e.ctx)) {
            noEol = h.plusNoEol;
            break;
          }
        }
        tree.now.set(np, plus.join('\n') + (noEol ? '' : '\n'));
        return;
      }
      if (del) {
        const op = oldP ?? newP;
        if (op === null || op === '/dev/null') return;
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      if (oldP !== null && newP !== null && oldP !== newP) {
        const before = tree.get(oldP);
        if (before === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const out = applyHunks(before, section, strict, oldP);
        tree.now.set(newP, out);
        tree.now.set(oldP, null);
        fx.moves.push({ old: oldP, next: newP });
        return;
      }
      const p = oldP ?? newP;
      if (p === null || p === '/dev/null') return;
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(before, section, strict, p));
    };
  });
}


function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    let path: string | null = null;
    for (let p = i - 1; p > prevEnd; p -= 1) {
      const t = lines[p]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevEnd = k;
    const old = oldLines.map((t) => plainLine(t));
    const nw = newLines.map((t) => plainLine(t));
    edits.push((tree: Tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (old.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, nw.length === 0 ? '' : nw.map((e) => e.text).join('\n') + '\n');
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const state = parseFile(before);
      const hit = firstTier(state.lines, old, tiersFor(strict));
      if (hit === null) throw new Fail('no-match', path);
      if (hit.positions.length > 1) throw new Fail('ambiguous', path);
      const out = replaceLines(state.lines, hit.positions[0]!, old, nw, hit.tier);
      tree.now.set(path, renderFile({ br: state.br, lines: out, final: state.final }));
    });
    i = k + 1;
  }
  return edits;
}

/** One V4A chunk: an optional anchor, body lines, and whether it is end-of-file. */
interface Chunk {
  anchor: string;
  hasAnchor: boolean;
  body: Array<{ text: string; kind: 'ctx' | 'old' | 'new' }>;
  eof: boolean;
}

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function isSectionStart(l: string): boolean {
  return l.startsWith(V4A_ADD) || l.startsWith(V4A_DEL) || l.startsWith(V4A_UPD);
}

function chunkON(body: Chunk['body']): { old: Line[]; nw: Line[] } {
  const old: Line[] = [];
  const nw: Line[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      const o = old.length;
      old.push(ctxLine(b.text, o));
      nw.push(ctxLine(b.text, o));
    } else if (b.kind === 'old') {
      old.push(plainLine(b.text));
    } else {
      nw.push(plainLine(b.text));
    }
  }
  return { old, nw };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = n - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    if (line.startsWith(V4A_ADD)) {
      const path = line.slice(V4A_ADD.length).trim();
      i += 1;
      const fileLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
          i += 1;
          continue;
        }
        if (l === '') {
          fileLines.push('');
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith(V4A_DEL)) {
      const path = line.slice(V4A_DEL.length).trim();
      i += 1;
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (line.startsWith(V4A_UPD)) {
      const updLine = i;
      const path = line.slice(V4A_UPD.length).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith(V4A_MOVE)) {
        moveTo = lines[i]!.slice(V4A_MOVE.length).trim();
        i += 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      const closeChunk = (strip: boolean): void => {
        if (cur === null) return;
        if (strip) {
          while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.text === '' && cur.body[cur.body.length - 1]!.kind === 'ctx') {
            cur.body.pop();
          }
        }
        chunks.push(cur);
        cur = null;
      };
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('@@')) {
          closeChunk(false);
          const anchor = l.slice(2).trim();
          cur = { anchor, hasAnchor: anchor !== '', body: [], eof: false };
          i += 1;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) cur = { anchor: '', hasAnchor: false, body: [], eof: true };
          else cur.eof = true;
          closeChunk(false);
          i += 1;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) cur = { anchor: '', hasAnchor: false, body: [], eof: false };
          if (l === '') cur.body.push({ text: '', kind: 'ctx' });
          else if (l[0] === ' ') cur.body.push({ text: l.slice(1), kind: 'ctx' });
          else if (l[0] === '-') cur.body.push({ text: l.slice(1), kind: 'old' });
          else cur.body.push({ text: l.slice(1), kind: 'new' });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk(true);
      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${updLine + 1}`);
      }
      edits.push((tree: Tree, fx: Fx) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const state = parseFile(before);
        let fileLines = state.lines;
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.hasAnchor) {
            let found: number | null = null;
            for (const tier of tiersFor(strict)) {
              for (let idx = cursor; idx < fileLines.length; idx += 1) {
                if (matchLine(fileLines[idx]!, chunk.anchor, tier)) {
                  found = idx;
                  break;
                }
              }
              if (found !== null) break;
            }
            if (found === null) throw new Fail('no-match', path);
            cursor = found + 1;
          }
          const { old: o, nw: nwLines } = chunkON(chunk.body);
          if (o.length === 0) {
            const at = chunk.eof ? fileLines.length : cursor;
            const ins = nwLines.map((e) => e.text);
            fileLines = [...fileLines.slice(0, at), ...ins, ...fileLines.slice(at)];
            cursor = at + ins.length;
            continue;
          }
          let hit: { tier: number; pos: number } | null = null;
          for (const tier of tiersFor(strict)) {
            const positions = findOccurrences(fileLines, o, tier, cursor);
            if (chunk.eof) {
              const end = positions.find((p) => p + o.length === fileLines.length);
              if (end !== undefined) {
                hit = { tier, pos: end };
                break;
              }
              continue;
            }
            if (positions.length > 0) {
              hit = { tier, pos: positions[0]! };
              break;
            }
          }
          if (hit === null) throw new Fail('no-match', path);
          fileLines = replaceLines(fileLines, hit.pos, o, nwLines, hit.tier);
          cursor = hit.pos + nwLines.length;
        }
        const out = renderFile({ br: state.br, lines: fileLines, final: state.final });
        if (moveTo !== null) {
          tree.now.set(moveTo, out);
          tree.now.set(path, null);
          fx.moves.push({ old: path, next: moveTo });
        } else {
          tree.now.set(path, out);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
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
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
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
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const state = parseFile(before);
      if (line < 0 || line > state.lines.length) throw new Fail('no-match', p);
      const lines = [...state.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, renderFile({ br: state.br, lines, final: state.final }));
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

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) check = true;
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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fx: Fx = { moves: [] };
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = fx.moves.length;
    try {
      edit(tree, fx);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fx.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  const rows: Array<{ key: string; text: string }> = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const m of fx.moves) {
    if (
      tree.original(m.old) !== null &&
      tree.get(m.old) === null &&
      tree.original(m.next) === null &&
      tree.get(m.next) !== null
    ) {
      rows.push({ key: m.next, text: `R ${m.old} -> ${m.next}` });
      movedOld.add(m.old);
      movedNew.add(m.next);
    }
  }
  for (const p of tree.now.keys()) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const m of fx.moves) {
    if (!movedOld.has(m.old) || !movedNew.has(m.next)) continue;
    if (check) continue;
    rmSync(m.old, { force: true });
    mkdirSync(dirname(m.next), { recursive: true });
    writeFileSync(m.next, tree.now.get(m.next)!);
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
