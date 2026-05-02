import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface KnowledgeChunk {
  /** Filename without extension (e.g. "pricing"). */
  source: string;
  /** Heading text of the section, or filename if before any heading. */
  title: string;
  /** Body of the section. */
  content: string;
}

export interface SearchResult {
  source: string;
  title: string;
  content: string;
}

let cachedChunks: KnowledgeChunk[] | null = null;

/** Exposed for tests — clears the cached parse so files can be re-read. */
export function _resetKnowledgeCacheForTests(): void {
  cachedChunks = null;
}

/**
 * Resolve the knowledge directory based on cwd. Mastra dev/build runs from
 * the project root; the Docker image (Día 5) copies src/knowledge under the
 * same relative path.
 */
function knowledgeDir(): string {
  return path.resolve(process.cwd(), 'src', 'knowledge');
}

function loadChunks(): KnowledgeChunk[] {
  if (cachedChunks) return cachedChunks;

  const dir = knowledgeDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    cachedChunks = [];
    return cachedChunks;
  }

  const chunks: KnowledgeChunk[] = [];
  for (const file of files) {
    const source = path.basename(file, '.md');
    const text = readFileSync(path.join(dir, file), 'utf8');
    chunks.push(...parseMarkdownIntoSections(text, source));
  }

  cachedChunks = chunks;
  return chunks;
}

/** Split a markdown document into sections by `## ` headings. */
function parseMarkdownIntoSections(text: string, source: string): KnowledgeChunk[] {
  const lines = text.split(/\r?\n/);
  const sections: KnowledgeChunk[] = [];
  let currentTitle = source;
  let buffer: string[] = [];

  function flush(): void {
    const content = buffer.join('\n').trim();
    if (content.length > 0) {
      sections.push({ source, title: currentTitle, content });
    }
    buffer = [];
  }

  for (const line of lines) {
    const h2 = /^## +(.+)$/.exec(line);
    if (h2) {
      flush();
      currentTitle = h2[1]!.trim();
      continue;
    }
    // Skip the H1 (e.g. "# FOMO — Identidad") — its title is captured in source/title.
    if (/^# /.test(line)) continue;
    buffer.push(line);
  }
  flush();

  return sections;
}

/**
 * Spanish stopwords. Skipped during tokenization so highly common terms don't
 * dominate scoring (e.g. "qué", "el", "la", "que", "con") — the user's intent
 * lives in the content words.
 */
const STOPWORDS = new Set([
  'que', 'cual', 'como', 'cuando', 'donde', 'cuanto', 'cuanta',
  'los', 'las', 'una', 'unos', 'unas',
  'del', 'con', 'por', 'para', 'sin', 'sobre',
  'son', 'fue', 'sea', 'ser', 'esta', 'este', 'esto', 'esa', 'ese', 'eso',
  'estos', 'estas', 'esos', 'esas',
  'pero', 'sino', 'aunque', 'porque', 'pues',
  'tiene', 'tener', 'hace', 'hacer',
  'hay', 'todo', 'toda', 'todos', 'todas', 'mas', 'muy',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents (NFD remnants)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const TITLE_BONUS = 5;

/**
 * Substring-based search over the knowledge sections. Title matches get a
 * 5× weight bump so a section literally named the query term outranks any
 * incidental mention.
 */
export function searchKnowledge(query: string, limit = 5): SearchResult[] {
  if (limit <= 0) return [];

  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const chunks = loadChunks();

  const scored = chunks
    .map((chunk) => {
      const contentNormalized = normalize(chunk.content);
      const titleNormalized = normalize(chunk.title);

      let score = 0;
      for (const token of tokens) {
        score += countOccurrences(contentNormalized, token);
        score += TITLE_BONUS * countOccurrences(titleNormalized, token);
      }
      return { chunk, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ chunk }) => ({
    source: chunk.source,
    title: chunk.title,
    content: truncate(chunk.content, 800),
  }));
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    count++;
    from = i + needle.length;
  }
  return count;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}
