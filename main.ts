// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON edits), finds the lines each edit names at the first of
// three matching tiers, and writes every change or none. Node 22, standard
// library only, fully deterministic. See SPEC.md for the whole contract.
//
// When MAKEFUN_ENV_URL is set, the trial is handed over to the kit's
// runner.ts; otherwise this file runs as the CLI.

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isBlankLine(s: string): boolean {
  return s.trim() === '';
}

// A patch's lines: its text split at \n, each with one trailing \r removed,
// and without the empty piece after a final \n.
function splitLines(text: string): string[] {
  const parts = text.split('\n');
  const lines = parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

// The same splitting, used for a JSON new_str's lines.
function splitTextLines(s: string): string[] {
  if (s === '') return [];
  return splitLines(s);
}

function trimEndWs(s: string): string {
  return s.replace(/[\s]+$/, '');
}

// ---------------------------------------------------------------------------
// Files: lines + line break + final-break flag
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  brk: '\n' | '\r\n';
  ends: boolean;
}

// A file's line break is CRLF when its first line feed follows a carriage
// return, and LF otherwise. Its lines are its text split at that break. It
// ends with a line break when its text ends with that break; that last,
// empty piece is not a line. An empty file has no lines.
function parseFile(text: string): FileState {
  if (text === '') return { lines: [], brk: '\n', ends: false };
  const nl = text.indexOf('\n');
  const brk: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(brk);
  const body = ends ? text.slice(0, text.length - brk.length) : text;
  return { lines: body.split(brk), brk, ends };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.ends ? f.brk : '');
}

// A path is safe when it is not empty, does not start with /, holds no \,
// and none of its /-separated segments is empty, . or ...
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

// ---------------------------------------------------------------------------
// The working tree: disk is read lazily and never written until the end,
// so the original bytes stay available while edits apply in memory.
// ---------------------------------------------------------------------------

class Tree {
  private origCache = new Map<string, string | null>();
  private work = new Map<string, FileState | null>();

  private readOrig(path: string): string | null {
    if (!this.origCache.has(path)) {
      let t: string | null = null;
      try {
        if (statSync(path).isFile()) t = readFileSync(path, 'utf8');
      } catch {
        t = null;
      }
      this.origCache.set(path, t);
    }
    return this.origCache.get(path) as string | null;
  }

  // Current state of a path: its FileState, or null when it is absent.
  get(path: string): FileState | null {
    if (this.work.has(path)) return this.work.get(path) as FileState | null;
    const t = this.readOrig(path);
    if (t === null) {
      this.work.set(path, null);
      return null;
    }
    const fs = parseFile(t);
    this.work.set(path, fs);
    return fs;
  }

  exists(path: string): boolean {
    return this.get(path) !== null;
  }

  // True when the path is taken by a file or by any other filesystem entry
  // (a directory sitting where a file should be created is still taken).
  taken(path: string): boolean {
    if (this.work.has(path)) return this.work.get(path) !== null;
    if (this.readOrig(path) !== null) return true;
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  }

  set(path: string, fs: FileState): void {
    this.work.set(path, fs);
  }

  del(path: string): void {
    this.work.set(path, null);
  }

  // Every path whose final bytes may differ from its original bytes.
  finalEntries(): { path: string; orig: string | null; cur: string | null }[] {
    const paths = new Set<string>();
    for (const [p, t] of this.origCache) if (t !== null) paths.add(p);
    for (const p of this.work.keys()) paths.add(p);
    const out: { path: string; orig: string | null; cur: string | null }[] = [];
    for (const p of paths) {
      const orig = this.readOrig(p);
      const st = this.work.get(p);
      const cur = st === undefined ? orig : st === null ? null : serializeFile(st);
      out.push({ path: p, orig, cur });
    }
    return out;
  }

  // Write every change to disk: deletions first, then creations and writes,
  // so a deleted file never blocks a directory its replacement needs.
  writeAll(): void {
    const changed = this.finalEntries().filter((e) => e.orig !== e.cur);
    for (const e of changed) {
      if (e.cur === null) {
        try {
          rmSync(e.path, { force: true });
        } catch {
          // A path that was never a file needs no removal.
        }
      }
    }
    for (const e of changed) {
      if (e.cur !== null) {
        const dir = dirname(e.path);
        if (dir !== '.') mkdirSync(dir, { recursive: true });
        writeFileSync(e.path, e.cur, 'utf8');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Line matching (section 5)
// ---------------------------------------------------------------------------

// The key a line is compared by at a tier: tier 0 every line equal, tier 1
// every line equal once trailing spaces and tabs are removed from both,
// tier 2 every line equal once leading and trailing spaces and tabs are
// removed from both.
function lineKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// Positions where pattern occurs in lines at a tier, from `from` on.
// Occurrences may overlap. With eofOnly, only occurrences that end at the
// file's last line count.
function occurrences(
  lines: string[],
  pat: string[],
  tier: number,
  from = 0,
  eofOnly = false,
): number[] {
  const res: number[] = [];
  if (pat.length === 0) return res;
  const pk = pat.map((l) => lineKey(l, tier));
  for (let i = from; i + pat.length <= lines.length; i++) {
    if (eofOnly && i + pat.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (lineKey(lines[i + j], tier) !== pk[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

// First tier (of the given tiers, in order) at which the pattern occurs,
// with its occurrences; null when it occurs at no tier.
function firstTierOccurrences(
  lines: string[],
  pat: string[],
  tiers: number[],
  from = 0,
  eofOnly = false,
): { tier: number; occs: number[] } | null {
  for (const t of tiers) {
    const occs = occurrences(lines, pat, t, from, eofOnly);
    if (occs.length > 0) return { tier: t, occs };
  }
  return null;
}

// First line at or after `from` equal to a single-line anchor at the first
// tier where one is; -1 when there is none.
function findAnchor(lines: string[], anchor: string, from: number, tiers: number[]): number {
  for (const t of tiers) {
    const ak = lineKey(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (lineKey(lines[i], t) === ak) return i;
    }
  }
  return -1;
}

// The lines that replace a matched run. A context line is written as the
// file's own matched line, never the patch's. At tier 2 every other line of
// N is re-indented: F is the leading spaces and tabs of the file's first
// matched line and P those of O's first line; a line of N that is not empty
// and not only whitespace, and starts with P, has that P replaced by F.
function buildReplacement(
  n: { text: string; ctxO: number | null }[],
  fileLines: string[],
  i0: number,
  tier: number,
  oFirst: string,
): string[] {
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadingWs(fileLines[i0] ?? '');
    p = leadingWs(oFirst);
  }
  return n.map((e) => {
    if (e.ctxO !== null) return fileLines[i0 + e.ctxO];
    let t = e.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) {
      t = f + t.slice(p.length);
    }
    return t;
  });
}

// ---------------------------------------------------------------------------
// Edits, as parsed from a patch
// ---------------------------------------------------------------------------

type NLine = { text: string; ctxO: number | null };

interface ParsedHunk {
  a: number;
  body: string[];
  o: string[];
  n: NLine[];
  noBreak: boolean;
}

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}

type Edit =
  | { kind: 'unified'; oldPath: string | null; newPath: string | null; isCreate: boolean; isDelete: boolean; hunks: ParsedHunk[] }
  | { kind: 'sr'; path: string; oldLines: string[]; newLines: string[] }
  | { kind: 'v4a-add'; path: string; fileLines: string[] }
  | { kind: 'v4a-del'; path: string }
  | { kind: 'v4a-update'; path: string; moveTo: string | null; chunks: V4AChunk[] }
  | { kind: 'json-create'; path: string; fileText: string }
  | { kind: 'json-str'; path: string; oldStr: string; newStr: string }
  | { kind: 'json-insert'; path: string; insertLine: number; newStr: string };

class ParseFailure extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

function parseFail(line: number): never {
  throw new ParseFailure(line);
}

// Build O (context and - lines) and N (context and + lines) from a hunk or
// chunk body, in body order. A \ line refers to the body line before it and
// carries no line of its own.
function parseBodyLines(body: string[]): { o: string[]; n: NLine[]; noBreak: boolean } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of body) {
    if (l === '' || l.startsWith(' ')) {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push({ text: t, ctxO: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctxO: null });
    }
    // A \ line contributes nothing to O or N.
  }
  let lastCtxPlus = -1;
  for (let j = 0; j < body.length; j++) {
    if (body[j] === '' || body[j].startsWith(' ') || body[j].startsWith('+')) lastCtxPlus = j;
  }
  const noBreak =
    lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1].startsWith('\\');
  return { o, n, noBreak };
}

// ---------------------------------------------------------------------------
// Format detection (section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  let firstNonBlank: string | null = null;
  for (const l of lines) {
    if (!isBlankLine(l)) {
      firstNonBlank = l;
      break;
    }
  }
  if (firstNonBlank !== null && firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
  if (firstNonBlank !== null) {
    const c = firstNonBlank.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  for (const l of lines) {
    if (trimEndWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

// The path of a --- / +++ line: the text after the four characters, up to
// the first tab, with surrounding spaces removed. /dev/null means no file.
// A leading a/ or b/ is removed from either.
function diffPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0].trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface UnifiedSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: ParsedHunk[];
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  const newSection = (): UnifiedSection => ({
    diffOld: null,
    diffNew: null,
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) parseFail(i + 1);
      cur = newSection();
      cur.diffOld = m[1];
      cur.diffNew = m[2];
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        const oldP = diffPath(line);
        const newP = diffPath(lines[i + 1]);
        if (cur !== null && cur.hunks.length === 0 && cur.pairOld === undefined) {
          cur.pairOld = oldP;
          cur.pairNew = newP;
        } else {
          cur = newSection();
          cur.pairOld = oldP;
          cur.pairNew = newP;
          sections.push(cur);
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) parseFail(i + 2);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) parseFail(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) parseFail(i + 1);
      const a = parseInt(m[1], 10);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j];
        if (bl.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          j++;
        } else {
          break;
        }
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const parsed = parseBodyLines(body);
      cur.hunks.push({ a, body, o: parsed.o, n: parsed.n, noBreak: parsed.noBreak });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).split('\t')[0].trim();
      } else if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).split('\t')[0].trim();
      } else if (line.startsWith('new file mode')) {
        cur.isCreate = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
      }
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) parseFail(1);
  return sections.map((s) => {
    const oldPath = s.pairOld !== undefined ? s.pairOld : s.renameFrom !== undefined ? s.renameFrom : s.diffOld;
    const newPath = s.pairNew !== undefined ? s.pairNew : s.renameTo !== undefined ? s.renameTo : s.diffNew;
    const isCreate = s.isCreate || oldPath === null;
    const isDelete = !isCreate && (s.isDelete || newPath === null);
    return { kind: 'unified', oldPath, newPath, isCreate, isDelete, hunks: s.hunks } as Edit;
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (trimEndWs(lines[i]) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sIdx = i;
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (trimEndWs(lines[j]) === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) parseFail(sIdx + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (trimEndWs(lines[j]) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) parseFail(sIdx + 1);
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) parseFail(sIdx + 1);
      path = prevPath;
    }
    edits.push({
      kind: 'sr',
      path,
      oldLines: lines.slice(sIdx + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) parseFail(1);
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

function isSectionStart(line: string): boolean {
  return (
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Delete File: ') ||
    line.startsWith('*** Update File: ')
  );
}

function parseV4A(lines: string[]): Edit[] {
  let beginIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlankLine(lines[i])) {
      beginIdx = i;
      break;
    }
  }
  if (beginIdx === -1) parseFail(1);
  if (lines[beginIdx].trim() !== '*** Begin Patch') parseFail(beginIdx + 1);
  let endIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlankLine(lines[i])) {
      endIdx = i;
      break;
    }
  }
  if (lines[endIdx].trim() !== '*** End Patch') parseFail(lines.length + 1);

  const edits: Edit[] = [];
  let i = beginIdx + 1;
  while (i < endIdx) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    if (!isSectionStart(line)) parseFail(i + 1);
    // Collect this section's lines: blank lines at the end of a section
    // (before the next section or *** End Patch) are not part of it, and
    // blank lines at its start are separators, not content.
    const start = i;
    i++;
    const raw: string[] = [];
    while (i < endIdx && !isSectionStart(lines[i])) {
      raw.push(lines[i]);
      i++;
    }
    while (raw.length > 0 && isBlankLine(raw[raw.length - 1])) raw.pop();
    let lead = 0;
    while (raw.length > 0 && isBlankLine(raw[0])) {
      raw.shift();
      lead++;
    }
    // raw[k] is patch line start + 2 + lead + k (1-based).
    const lineNo = (k: number): number => start + 2 + lead + k;

    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k];
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (isBlankLine(l)) fileLines.push('');
        else parseFail(lineNo(k));
      }
      edits.push({ kind: 'v4a-add', path, fileLines });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      if (raw.length > 0) parseFail(lineNo(0));
      edits.push({ kind: 'v4a-del', path });
    } else {
      const path = line.slice('*** Update File: '.length).trim();
      let moveTo: string | null = null;
      let at = 0;
      if (raw.length > 0 && raw[0].startsWith('*** Move to: ')) {
        moveTo = raw[0].slice('*** Move to: '.length).trim();
        at = 1;
      }
      const chunks: V4AChunk[] = [];
      let curChunk: V4AChunk | null = null;
      const closeChunk = () => {
        curChunk = null;
      };
      for (let k = at; k < raw.length; k++) {
        const l = raw[k];
        const n = lineNo(k);
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [] };
          chunks.push(curChunk);
          continue;
        }
        if (l === '*** End of File') {
          if (curChunk !== null) {
            curChunk.eof = true;
            closeChunk();
          }
          continue;
        }
        if (l.startsWith('*** Move to: ')) parseFail(n);
        if (isBlankLine(l)) {
          // A blank line starts no chunk; inside one it is an empty
          // context line.
          if (curChunk !== null) {
            curChunk.o.push('');
            curChunk.n.push({ text: '', ctxO: curChunk.o.length - 1 });
          }
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curChunk === null) {
            curChunk = { anchor: null, eof: false, o: [], n: [] };
            chunks.push(curChunk);
          }
          if (l.startsWith(' ')) {
            const t = l.slice(1);
            curChunk.o.push(t);
            curChunk.n.push({ text: t, ctxO: curChunk.o.length - 1 });
          } else if (l.startsWith('-')) {
            curChunk.o.push(l.slice(1));
          } else {
            curChunk.n.push({ text: l.slice(1), ctxO: null });
          }
          continue;
        }
        parseFail(n);
      }
      if (chunks.length === 0 && moveTo === null) parseFail(start + 1);
      edits.push({ kind: 'v4a-update', path, moveTo, chunks });
    }
  }
  if (edits.length === 0) parseFail(1);
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (section 9)
// ---------------------------------------------------------------------------

function validateEditObject(o: unknown): Edit | null {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
  const obj = o as Record<string, unknown>;
  if (typeof obj.path !== 'string') return null;
  if (typeof obj.command !== 'string') return null;
  if (obj.command === 'create') {
    if (typeof obj.file_text !== 'string') return null;
    return { kind: 'json-create', path: obj.path, fileText: obj.file_text };
  }
  if (obj.command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') return null;
    if (obj.new_str !== undefined && typeof obj.new_str !== 'string') return null;
    return {
      kind: 'json-str',
      path: obj.path,
      oldStr: obj.old_str,
      newStr: obj.new_str === undefined ? '' : (obj.new_str as string),
    };
  }
  if (obj.command === 'insert') {
    if (typeof obj.insert_line !== 'number' || !Number.isInteger(obj.insert_line)) return null;
    if (typeof obj.new_str !== 'string') return null;
    return { kind: 'json-insert', path: obj.path, insertLine: obj.insert_line, newStr: obj.new_str };
  }
  return null;
}

function parseJSON(lines: string[], patchText: string): Edit[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlankLine(lines[i])) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) parseFail(1);
  if (lines[firstIdx].trimStart().startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      parseFail(firstIdx + 1);
    }
    if (!Array.isArray(arr)) parseFail(firstIdx + 1);
    const edits: Edit[] = [];
    for (const el of arr as unknown[]) {
      const e = validateEditObject(el);
      if (e === null) parseFail(firstIdx + 1);
      edits.push(e);
    }
    if (edits.length === 0) parseFail(1);
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlankLine(lines[i])) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      parseFail(i + 1);
    }
    const e = validateEditObject(obj);
    if (e === null) parseFail(i + 1);
    edits.push(e);
  }
  if (edits.length === 0) parseFail(1);
  return edits;
}

function parsePatch(fmt: string, lines: string[], patchText: string): Edit[] {
  if (fmt === 'unified') return parseUnified(lines);
  if (fmt === 'search-replace') return parseSearchReplace(lines);
  if (fmt === 'v4a') return parseV4A(lines);
  return parseJSON(lines, patchText);
}

// ---------------------------------------------------------------------------
// Applying edits (section 10: in the patch's order, to the tree as earlier
// edits left it; a failed edit changes nothing, and the edits after it
// still run)
// ---------------------------------------------------------------------------

type ApplyResult = { ok: true } | { ok: false; code: string; path: string };

function fail(code: string, path: string): ApplyResult {
  return { ok: false, code, path };
}

// Apply one unified hunk to a file's lines. d is the sum over this
// section's hunks applied so far of (N's length minus O's length).
function applyHunk(
  file: FileState,
  h: ParsedHunk,
  tiers: number[],
  d: number,
): { ok: boolean; d: number } {
  if (h.o.length === 0) {
    const ins = Math.max(0, Math.min(h.a + d, file.lines.length));
    const atEnd = ins === file.lines.length;
    const newLines = h.n.map((e) => e.text);
    file.lines.splice(ins, 0, ...newLines);
    if (atEnd) file.ends = !h.noBreak;
    return { ok: true, d: d + h.n.length };
  }
  const found = firstTierOccurrences(file.lines, h.o, tiers);
  if (found === null) return { ok: false, d };
  const target = h.a - 1 + d;
  let best = found.occs[0];
  let bestDist = Math.abs(found.occs[0] - target);
  for (const o of found.occs) {
    const dist = Math.abs(o - target);
    if (dist < bestDist) {
      best = o;
      bestDist = dist;
    }
  }
  const i0 = best;
  const newLines = buildReplacement(h.n, file.lines, i0, found.tier, h.o[0]);
  const touchesEnd = i0 + h.o.length === file.lines.length;
  file.lines.splice(i0, h.o.length, ...newLines);
  if (touchesEnd) file.ends = !h.noBreak;
  return { ok: true, d: d + h.n.length - h.o.length };
}

function applyUnified(
  tree: Tree,
  e: Extract<Edit, { kind: 'unified' }>,
  tiers: number[],
  moves: [string, string][],
): ApplyResult {
  const oldP = e.oldPath;
  const newP = e.newPath;
  if (oldP !== null && !isSafePath(oldP)) return fail('unsafe', oldP);
  if (newP !== null && !isSafePath(newP)) return fail('unsafe', newP);
  if (e.isCreate) {
    if (newP === null) return { ok: true };
    if (tree.taken(newP)) return fail('exists', newP);
    const lines: string[] = [];
    let noBreak = false;
    let lastPlus: { hunk: ParsedHunk; idx: number } | null = null;
    for (const h of e.hunks) {
      for (let k = 0; k < h.body.length; k++) {
        if (h.body[k].startsWith('+')) {
          lines.push(h.body[k].slice(1));
          lastPlus = { hunk: h, idx: k };
        }
      }
    }
    if (
      lastPlus !== null &&
      lastPlus.idx + 1 < lastPlus.hunk.body.length &&
      lastPlus.hunk.body[lastPlus.idx + 1].startsWith('\\')
    ) {
      noBreak = true;
    }
    tree.set(newP, { lines, brk: '\n', ends: !noBreak });
    return { ok: true };
  }
  if (e.isDelete) {
    if (oldP === null) return { ok: true };
    if (!tree.exists(oldP)) return fail('missing', oldP);
    tree.del(oldP);
    return { ok: true };
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    if (!tree.exists(oldP)) return fail('missing', oldP);
    if (tree.taken(newP)) return fail('exists', newP);
    const orig = tree.get(oldP) as FileState;
    // Work on a copy: a failed edit changes nothing, so a hunk that fails
    // halfway through a section must not leave its earlier hunks behind.
    const f: FileState = { lines: [...orig.lines], brk: orig.brk, ends: orig.ends };
    let d = 0;
    for (const h of e.hunks) {
      const r = applyHunk(f, h, tiers, d);
      if (!r.ok) return fail('no-match', oldP);
      d = r.d;
    }
    tree.del(oldP);
    tree.set(newP, f);
    moves.push([oldP, newP]);
    return { ok: true };
  }
  if (oldP === null) return { ok: true };
  if (!tree.exists(oldP)) return fail('missing', oldP);
  const orig = tree.get(oldP) as FileState;
  const f: FileState = { lines: [...orig.lines], brk: orig.brk, ends: orig.ends };
  let d = 0;
  for (const h of e.hunks) {
    const r = applyHunk(f, h, tiers, d);
    if (!r.ok) return fail('no-match', oldP);
    d = r.d;
  }
  tree.set(oldP, f);
  return { ok: true };
}

function applySearchReplace(
  tree: Tree,
  e: Extract<Edit, { kind: 'sr' }>,
  tiers: number[],
): ApplyResult {
  if (!isSafePath(e.path)) return fail('unsafe', e.path);
  if (e.oldLines.length === 0) {
    if (tree.taken(e.path)) return fail('exists', e.path);
    tree.set(e.path, { lines: [...e.newLines], brk: '\n', ends: true });
    return { ok: true };
  }
  const f = tree.get(e.path);
  if (f === null) return fail('missing', e.path);
  for (const t of tiers) {
    const occs = occurrences(f.lines, e.oldLines, t);
    if (occs.length === 1) {
      const pos = occs[0];
      const newLines = buildReplacement(
        e.newLines.map((text) => ({ text, ctxO: null })),
        f.lines,
        pos,
        t,
        e.oldLines[0],
      );
      f.lines.splice(pos, e.oldLines.length, ...newLines);
      return { ok: true };
    }
    if (occs.length > 1) return fail('ambiguous', e.path);
  }
  return fail('no-match', e.path);
}

function applyV4AUpdate(
  tree: Tree,
  e: Extract<Edit, { kind: 'v4a-update' }>,
  tiers: number[],
  moves: [string, string][],
): ApplyResult {
  if (!isSafePath(e.path)) return fail('unsafe', e.path);
  if (e.moveTo !== null && !isSafePath(e.moveTo)) return fail('unsafe', e.moveTo);
  const orig = tree.get(e.path);
  if (orig === null) return fail('missing', e.path);
  if (e.moveTo !== null && tree.taken(e.moveTo)) return fail('exists', e.moveTo);
  // Work on a copy: a failed edit changes nothing, so a chunk that fails
  // after earlier chunks applied must not leave those behind.
  const f: FileState = { lines: [...orig.lines], brk: orig.brk, ends: orig.ends };
  let cursor = 0;
  for (const ch of e.chunks) {
    if (ch.anchor !== null) {
      const idx = findAnchor(f.lines, ch.anchor, cursor, tiers);
      if (idx === -1) return fail('no-match', e.path);
      cursor = idx + 1;
    }
    if (ch.o.length === 0) {
      const ins = ch.eof ? f.lines.length : cursor;
      const newLines = ch.n.map((x) => x.text);
      f.lines.splice(ins, 0, ...newLines);
      cursor = ins + newLines.length;
      continue;
    }
    const found = firstTierOccurrences(f.lines, ch.o, tiers, cursor, ch.eof);
    if (found === null) return fail('no-match', e.path);
    const pos = found.occs[0];
    const newLines = buildReplacement(ch.n, f.lines, pos, found.tier, ch.o[0]);
    f.lines.splice(pos, ch.o.length, ...newLines);
    cursor = pos + newLines.length;
  }
  if (e.moveTo !== null) {
    tree.del(e.path);
    tree.set(e.moveTo, f);
    moves.push([e.path, e.moveTo]);
  } else {
    tree.set(e.path, f);
  }
  return { ok: true };
}

function applyEdit(tree: Tree, e: Edit, tiers: number[], moves: [string, string][]): ApplyResult {
  switch (e.kind) {
    case 'unified':
      return applyUnified(tree, e, tiers, moves);
    case 'sr':
      return applySearchReplace(tree, e, tiers);
    case 'v4a-add': {
      if (!isSafePath(e.path)) return fail('unsafe', e.path);
      if (tree.taken(e.path)) return fail('exists', e.path);
      tree.set(e.path, { lines: [...e.fileLines], brk: '\n', ends: true });
      return { ok: true };
    }
    case 'v4a-del': {
      if (!isSafePath(e.path)) return fail('unsafe', e.path);
      if (!tree.exists(e.path)) return fail('missing', e.path);
      tree.del(e.path);
      return { ok: true };
    }
    case 'v4a-update':
      return applyV4AUpdate(tree, e, tiers, moves);
    case 'json-create': {
      if (!isSafePath(e.path)) return fail('unsafe', e.path);
      if (tree.taken(e.path)) return fail('exists', e.path);
      tree.set(e.path, parseFile(e.fileText));
      return { ok: true };
    }
    case 'json-str': {
      if (!isSafePath(e.path)) return fail('unsafe', e.path);
      const f = tree.get(e.path);
      if (f === null) return fail('missing', e.path);
      let text = serializeFile(f);
      let oldS = e.oldStr;
      let newS = e.newStr;
      if (f.brk === '\r\n') {
        text = text.replace(/\r\n/g, '\n');
        oldS = oldS.replace(/\r\n/g, '\n');
        newS = newS.replace(/\r\n/g, '\n');
      }
      let count = 0;
      let idx = 0;
      for (;;) {
        const k = text.indexOf(oldS, idx);
        if (k === -1) break;
        count++;
        idx = k + 1;
      }
      if (count === 0) return fail('no-match', e.path);
      if (count > 1) return fail('ambiguous', e.path);
      const result = text.replace(oldS, () => newS);
      const finalText = f.brk === '\r\n' ? result.replace(/\n/g, '\r\n') : result;
      tree.set(e.path, parseFile(finalText));
      return { ok: true };
    }
    case 'json-insert': {
      if (!isSafePath(e.path)) return fail('unsafe', e.path);
      const f = tree.get(e.path);
      if (f === null) return fail('missing', e.path);
      if (e.insertLine < 0 || e.insertLine > f.lines.length) return fail('no-match', e.path);
      const ins = splitTextLines(e.newStr);
      f.lines.splice(e.insertLine, 0, ...ins);
      return { ok: true };
    }
  }
}

// ---------------------------------------------------------------------------
// Output (section 2)
// ---------------------------------------------------------------------------

// One line for each path whose state changed, in byte order of the paths
// (UTF-8); a move's R line sorts by its new path and replaces that pair's
// D and A lines.
function outputLines(tree: Tree, moves: [string, string][]): string[] {
  const dSet = new Set<string>();
  const aSet = new Set<string>();
  const mSet = new Set<string>();
  for (const e of tree.finalEntries()) {
    if (e.orig === e.cur) continue;
    if (e.orig === null) aSet.add(e.path);
    else if (e.cur === null) dSet.add(e.path);
    else mSet.add(e.path);
  }
  const out: { key: string; line: string }[] = [];
  for (const [oldP, newP] of moves) {
    if (dSet.has(oldP) && aSet.has(newP)) {
      dSet.delete(oldP);
      aSet.delete(newP);
      out.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of dSet) out.push({ key: p, line: `D ${p}` });
  for (const p of aSet) out.push({ key: p, line: `A ${p}` });
  for (const p of mSet) out.push({ key: p, line: `M ${p}` });
  out.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  return out.map((o) => o.line);
}

// ---------------------------------------------------------------------------
// Invocation (section 1) and the run
// ---------------------------------------------------------------------------

function exit2(msg: string): number {
  process.stdout.write(msg + '\n');
  return 2;
}

function runCli(): number {
  const args = process.argv.slice(2);
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  for (const a of args) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return exit2('error: usage');
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return exit2('error: usage');
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return exit2('error: usage');
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') {
          return exit2('error: usage');
        }
        format = v;
      } else {
        return exit2('error: usage');
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return exit2('error: usage');
  const patchArg = positional.length === 1 ? positional[0] : null;

  let patchText: string;
  if (patchArg === null || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      return exit2('error: no-patch');
    }
  }

  const lines = splitLines(patchText);
  const fmt = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (fmt === null) return exit2('error: format');

  let edits: Edit[];
  try {
    edits = parsePatch(fmt, lines, patchText);
  } catch (err) {
    if (err instanceof ParseFailure) return exit2(`error: parse ${err.line}`);
    throw err;
  }

  const tree = new Tree();
  const tiers = strict ? [0] : [0, 1, 2];
  const moves: [string, string][] = [];
  const failures: { code: string; path: string }[] = [];
  for (const e of edits) {
    const r = applyEdit(tree, e, tiers, moves);
    if (!r.ok) failures.push({ code: r.code, path: r.path });
  }
  if (failures.length > 0) {
    let s = '';
    for (const f of failures) s += `error: ${f.code} ${f.path}\n`;
    s += `failed: ${failures.length} of ${edits.length} edits\n`;
    process.stdout.write(s);
    return 1;
  }

  const changed = outputLines(tree, moves);
  if (!check) tree.writeAll();
  let s = '';
  for (const l of changed) s += l + '\n';
  s += `ok: ${changed.length} ${changed.length === 1 ? 'file' : 'files'}\n`;
  process.stdout.write(s);
  return 0;
}

// When the trial environment hands this program its checks, the trial is
// handed over to the kit's runner; otherwise this file runs as the CLI.
if (process.env.MAKEFUN_ENV_URL) {
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  process.exitCode = runCli();
}
