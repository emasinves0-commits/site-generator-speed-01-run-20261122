// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01): run(input) returns exactly
// makefun-site's answer for every input, faster. Same pipeline, same output, no shared state
// between cases: every per-run cache is reset at the top of run(). Single self-contained module,
// no imports, so loading it is cheap.
//
// Where the speed comes from:
//  - Markdown inline rendering is slice-based (no per-character escape/replace; plain runs are
//    bulk-escaped only when they hold an escapable character) and block lexing+rendering is one
//    pass with prefix checks instead of seven regexes per line.
//  - Templates are compiled once per case to JS functions (array push + join, plain for loops,
//    static loop-var objects) instead of walked as a node tree on every render.
//  - slugify is memoized per run and takes a regex fast path for ASCII text; the \r\n
//    normalisation is skipped when the text holds no \r; front matter is found by indexOf
//    instead of splitting and re-joining the whole body.

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const NEEDS_ESC = /[&<>"']/;

/** `text` with & < > " and ' escaped (fast path when none is present). */
function escapeHtml(text) {
  return NEEDS_ESC.test(text) ? text.replace(ESC_RE, (c) => ESCAPES[c]) : text;
}

const MARK_RE = /\p{M}/gu;
const NON_ALNUM_RUN = /[^a-z0-9]+/g;
const EDGE_DASH = /^-+|-+$/g;
const TRAIL_DASH = /-+$/;
const NON_ASCII = /[^\x00-\x7f]/;

/** The slug rule, exactly as makefun-site's (reference path for non-ASCII text). */
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  return out;
}

/** Per-run slug cache (reset in run(); tags and titles repeat within a case). */
let slugCache = null;

/** The slug of `text`: NFKD, marks dropped, A-Z lowered, each run of other chars one "-". */
function slugify(text) {
  let s = slugCache.get(text);
  if (s !== undefined) return s;
  if (NON_ASCII.test(text)) s = slugifySlow(text);
  else s = text.toLowerCase().replace(NON_ALNUM_RUN, '-').replace(EDGE_DASH, '');
  if (s.length > 64) s = s.slice(0, 64).replace(TRAIL_DASH, '');
  if (s === '') s = 'untitled';
  slugCache.set(text, s);
  return s;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Per-run long-date cache (reset in run()). */
let dateCache = null;

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  let s = dateCache.get(date);
  if (s === undefined) {
    const y = date.slice(0, 4);
    const m = Number(date.slice(5, 7));
    const d = Number(date.slice(8, 10));
    s = `${d} ${MONTHS[m - 1]} ${y}`;
    dateCache.set(date, s);
  }
  return s;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The words of a body: its runs of characters other than whitespace (native scan, no match array). */
const WORD_RE = /\S+/g;
function wordsOf(text) {
  WORD_RE.lastIndex = 0;
  let n = 0;
  while (WORD_RE.exec(text) !== null) n++;
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;
const BLANK_LINE = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }. `text` has "\n" line ends.
 * Found by indexOf (no split+join of the body): the first line must be exactly "---", the close
 * the next line exactly "---".
 */
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  // The close line: "\n---\n" (more follows) or "\n---" at the very end.
  let p = text.indexOf('\n---\n', 3);
  let bodyStart;
  if (p !== -1) bodyStart = p + 5;
  else if (text.endsWith('\n---') && text.length > 4) {
    p = text.length - 4;
    bodyStart = text.length;
  } else return { error: 'the front matter is not closed' };
  const fm = text.slice(4, p);
  const data = {};
  if (fm !== '') {
    const lines = fm.split('\n');
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k];
      if (BLANK_LINE.test(line) || line.startsWith('#')) continue;
      const m = LINE.exec(line);
      if (!m) return { error: `line ${k + 2} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** A heading line's level and text, or null. */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** A line with spaces and tabs at either end dropped (fast path when there are none). */
function trimLine(line) {
  const n = line.length;
  if (n === 0) return line;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(n - 1);
  if (a !== 32 && a !== 9 && b !== 32 && b !== 9) return line;
  let s = 0;
  while (s < n && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = n;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return line.slice(s, e);
}

/** Whether `line` is blank (empty or only spaces/tabs). */
function isBlank(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  return (c === 32 || c === 9) && BLANK_LINE.test(line);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return BLANK_LINE.test(line);
  if (c === 96) return line.startsWith('```') && FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR.test(line);
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, to) {
  const end = to - what.length;
  for (let j = from; j <= end; j++) {
    if (s[j] === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The next inline-special character (\\ ` * [) at or after `from`, or `to`. */
const SPECIAL = /[\\`*[]/g;

/** Push `s`'s slice [from, to) escaped onto `out` (fast path when nothing needs escaping). */
function pushEscaped(s, from, to, out) {
  if (from >= to) return;
  const seg = s.slice(from, to);
  out.push(NEEDS_ESC.test(seg) ? seg.replace(ESC_RE, (c) => ESCAPES[c]) : seg);
}

/**
 * `s[from:to]` rendered inline into `out`; `env.link(target)` is a link's href.
 * Range-based (no substring copies for nested spans) and slice-based (plain runs are
 * bulk-escaped, never walked character by character).
 */
function inlineRange(s, from, to, env, out) {
  let i = from;
  while (i < to) {
    SPECIAL.lastIndex = i;
    const m = SPECIAL.exec(s);
    const j = m === null || m.index >= to ? to : m.index;
    if (j > i) {
      pushEscaped(s, i, j, out);
      i = j;
    }
    if (i >= to) break;
    const c = s[i];
    if (c === '\\' && i + 1 < to && ESCAPABLE.has(s[i + 1])) {
      const n = s[i + 1];
      out.push(n === '&' ? '&amp;' : n === '<' ? '&lt;' : n === '>' ? '&gt;' : n === '"' ? '&quot;' : n === "'" ? '&#39;' : n);
      i += 2;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < to && k > i + 1) {
        out.push('<code>');
        pushEscaped(s, i + 1, k, out);
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2, to);
        if (k > i + 2) {
          out.push('<strong>');
          inlineRange(s, i + 2, k, env, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1, to);
      if (k > i + 1) {
        out.push('<em>');
        inlineRange(s, i + 1, k, env, out);
        out.push('</em>');
        i = k + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, to);
      const m2 = k !== -1 && k + 1 < to && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 || m2 >= to ? '' : s.slice(k + 2, m2);
      if (target !== '' && !/\s/.test(target)) {
        const href = env.link(target);
        out.push('<a href="');
        pushEscaped(href, 0, href.length, out);
        out.push('">');
        inlineRange(s, i + 1, k, env, out);
        out.push('</a>');
        i = m2 + 1;
        continue;
      }
      out.push('[');
      i++;
      continue;
    }
    // A lone backslash (not escaping) or a char the scan should not have returned.
    out.push(c);
    i++;
  }
}

/** `s` rendered inline as one string. */
function inline(s, env) {
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading) and its excerpt (the first paragraph's
 * inline HTML, or ""). Block detection uses prefix checks; only a matching prefix runs a regex.
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    // Blank (spaces/tabs only).
    if (c0 === 32 || c0 === 9) {
      if (BLANK_LINE.test(line)) {
        i++;
        continue;
      }
      // Indented text is a paragraph: fall through.
    } else if (c0 === 96 && line.startsWith('```')) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        out.push(lang === '' ? '<pre><code>' : `<pre><code class="language-${lang}">`);
        i++;
        while (i < n && !FENCE_CLOSE.test(lines[i])) {
          out.push(escapeHtml(lines[i]), '\n');
          i++;
        }
        i++;
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const html = inline(h.text, env);
        out.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      const b = BULLET.exec(line);
      if (b !== null) {
        const items = [];
        while (i < n) {
          const m = BULLET.exec(lines[i]);
          if (m !== null) {
            items.push([trimLine(m[1])]);
            i++;
          } else if (CONTINUED.test(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        out.push('<ul>\n');
        for (const parts2 of items) {
          out.push('<li>');
          const text = parts2.join('\n');
          inlineRange(text, 0, text.length, env, out);
          out.push('</li>\n');
        }
        out.push('</ul>\n');
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        const text = kept.join('\n');
        inlineRange(text, 0, text.length, env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const o = ORDERED.exec(line);
      if (o !== null) {
        const start = Number(o[1]);
        const items = [];
        while (i < n) {
          const m = ORDERED.exec(lines[i]);
          if (m !== null) {
            items.push([trimLine(m[2])]);
            i++;
          } else if (CONTINUED.test(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        out.push(start !== 1 ? `<ol start="${start}">\n` : '<ol>\n');
        for (const parts2 of items) {
          out.push('<li>');
          const text = parts2.join('\n');
          inlineRange(text, 0, text.length, env, out);
          out.push('</li>\n');
        }
        out.push('</ol>\n');
        continue;
      }
    }
    // Paragraph: this line and the lines after it up to a blank line, fence, heading or break.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    if (excerpt === null) {
      const html = inline(text, env);
      excerpt = html;
      out.push(`<p>${html}</p>\n`);
    } else {
      out.push('<p>');
      inlineRange(text, 0, text.length, env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * The value at `path` in the scope chain: its first name from the nearest scope holding it.
 * No scope var is ever explicitly undefined (every vars object is built here with defined
 * values, and every iterated array holds defined elements), so a missing name reads as
 * undefined exactly like hasOwn would report it — a plain read is the faster check.
 */
function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  let v;
  while (s !== null) {
    v = s.vars[first];
    if (v !== undefined) break;
    s = s.parent;
  }
  if (s === null) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object') return undefined;
    v = v[path[k]];
    if (v === undefined) return undefined;
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * Compile parsed `nodes` to a render function fn(S, T, D): S the scope, T the compiled-template
 * map, D the include depth. Helpers (escape, textOf, lookup, truthy) are closed over via the
 * generated code's parameters, so the hot loop is one function with array push + join.
 */
function compileTemplate(nodes) {
  let uid = 0;
  const parts = ['let O=[];'];
  const gen = (ns, scopeVar) => {
    for (const n of ns) {
      if (n.kind === 'text') parts.push(`O.push(${JSON.stringify(n.text)});`);
      else if (n.kind === 'var') parts.push(`O.push(E(X(L(${scopeVar},${JSON.stringify(n.path)}))));`);
      else if (n.kind === 'raw') parts.push(`O.push(X(L(${scopeVar},${JSON.stringify(n.path)})));`);
      else if (n.kind === 'if') {
        const cond = n.not ? `!Y(L(${scopeVar},${JSON.stringify(n.path)}))` : `Y(L(${scopeVar},${JSON.stringify(n.path)}))`;
        parts.push(`if(${cond}){`);
        gen(n.then, scopeVar);
        parts.push('}');
        if (n.else !== null) {
          parts.push('else{');
          gen(n.else, scopeVar);
          parts.push('}');
        }
      } else if (n.kind === 'for') {
        const id = uid++;
        const xs = `a${id}`;
        const k = `k${id}`;
        const sc = `s${id}`;
        parts.push(`{const ${xs}=L(${scopeVar},${JSON.stringify(n.path)});if(Array.isArray(${xs})){for(let ${k}=0;${k}<${xs}.length;${k}++){const ${sc}={vars:{${JSON.stringify(n.name)}:${xs}[${k}],loop:{index:${k}+1,first:${k}===0,last:${k}===${xs}.length-1,length:${xs}.length}},parent:${scopeVar}};`);
        gen(n.body, sc);
        parts.push('}}}');
      } else if (n.kind === 'include') {
        const id = uid++;
        const fn = `f${id}`;
        parts.push(`if(D<${INCLUDE_DEPTH}){const ${fn}=T.get(${JSON.stringify(n.name)});if(${fn}!==undefined)O.push(${fn}(${scopeVar},T,D+1,E,X,L,Y));}`);
      }
    }
  };
  gen(nodes, 'S');
  parts.push('return O.join("");');
  return new Function('S', 'T', 'D', 'E', 'X', 'L', 'Y', parts.join('\n'));
}

// ---------------------------------------------------------------- the build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` from the directory `dir`, or null when it climbs out of the root (memoized per run). */
let pathCache = null;
function resolvePath(dir, rel) {
  const key = `${dir}\n${rel}`;
  let out = pathCache.get(key);
  if (out !== undefined) return out;
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) {
        pathCache.set(key, null);
        return null;
      }
      parts.pop();
    } else parts.push(seg);
  }
  out = parts.join('/');
  pathCache.set(key, out);
  return out;
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
  dateCache = new Map();
  pathCache = new Map();

  // Templates first (a source's layout must be one that parses).
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; .md is a source, the rest static.
  // (The input is this run's own parsed copy: sorting it in place is safe.)
  const files = input.files.sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: refused sources and drafts are reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, each source's links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, then by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push({ name, slug });
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const cards = new Map();
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const p of posts) cards.set(p, cardOf(p));
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const pageOf = (s) => {
    const card = s.post ? cards.get(s) : cardOf(s);
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    return fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0, escapeHtml, textOf, lookup, truthy);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const nPages = kept.filter((s) => !s.post).length;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
