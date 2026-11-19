import { Text } from "@codemirror/state";

export interface SentenceRange {
  from: number;
  to: number;
  text: string;
}

// Longest passage the plugin sends for rewriting. A "sentence" longer than
// this is usually a run-on paragraph or a missing full stop, and sending it
// would mean sending most of the note.
export const MaxSentenceLength = 1500;

// Block markers that start a Markdown line but are not part of the sentence
const blockPrefixRegex = /^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[.\]\s+)?|\d+[.)]\s+(?:\[.\]\s+)?)/;
const listOrHeadingRegex = /^\s*(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/;

interface SegmenterLike {
  segment(text: string): Iterable<{ segment: string; index: number }>;
}

function getSentenceSegmenter(): SegmenterLike | null {
  // Intl.Segmenter is missing from the TypeScript lib this project targets,
  // and from some older mobile WebViews
  const intl = Intl as unknown as {
    Segmenter?: new (
      locale?: string,
      options?: { granularity: "sentence" }
    ) => SegmenterLike;
  };
  if (!intl.Segmenter) {
    return null;
  }
  return new intl.Segmenter(undefined, { granularity: "sentence" });
}

// Fallback for runtimes without Intl.Segmenter: split after ., ! or ?
// followed by whitespace
function splitSentencesFallback(
  text: string
): { segment: string; index: number }[] {
  const result: { segment: string; index: number }[] = [];
  const regex = /[^.!?]*(?:[.!?]+["')\]]*\s*|$)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex++;
      if (regex.lastIndex > text.length) break;
      continue;
    }
    result.push({ segment: match[0], index: match.index });
  }
  return result;
}

/**
 * The paragraph around a position: consecutive non-blank lines, except that
 * a list item, heading or quote line stands alone.
 */
function getBlock(doc: Text, pos: number): { from: number; to: number } {
  const line = doc.lineAt(pos);
  if (listOrHeadingRegex.test(line.text)) {
    return { from: line.from, to: line.to };
  }
  let first = line.number;
  let last = line.number;
  while (first > 1) {
    const prev = doc.line(first - 1).text;
    if (prev.trim() === "" || listOrHeadingRegex.test(prev)) break;
    first--;
  }
  while (last < doc.lines) {
    const next = doc.line(last + 1).text;
    if (next.trim() === "" || listOrHeadingRegex.test(next)) break;
    last++;
  }
  return { from: doc.line(first).from, to: doc.line(last).to };
}

/**
 * Find the sentence (or sentences) covering the range from..to. Only this
 * text is sent to the AI provider, never the rest of the note.
 */
export function findSentence(
  doc: Text,
  from: number,
  to: number
): SentenceRange | null {
  const block = getBlock(doc, from);
  const blockText = doc.sliceString(block.from, block.to);

  // Skip a leading list, heading or quote marker so it is neither sent nor
  // replaced
  const prefix = blockPrefixRegex.exec(blockText);
  const contentStart = block.from + (prefix ? prefix[0].length : 0);
  const content = doc.sliceString(contentStart, block.to);

  const segmenter = getSentenceSegmenter();
  const segments = segmenter
    ? Array.from(segmenter.segment(content))
    : splitSentencesFallback(content);

  const relFrom = Math.max(0, from - contentStart);
  const relTo = Math.max(relFrom, Math.min(content.length, to - contentStart));

  let start = -1;
  let end = -1;
  for (const { segment, index } of segments) {
    const segEnd = index + segment.length;
    const overlaps =
      relFrom === relTo
        ? relFrom >= index && relFrom <= segEnd
        : index < relTo && segEnd > relFrom;
    if (overlaps) {
      if (start === -1) start = index;
      end = segEnd;
    }
  }
  if (start === -1) {
    return null;
  }

  // Trailing whitespace belongs to the gap between sentences, not to the
  // sentence that is replaced
  const raw = content.slice(start, end);
  const trimmedEnd = raw.replace(/\s+$/, "");
  const leading = trimmedEnd.length - trimmedEnd.replace(/^\s+/, "").length;
  const text = trimmedEnd.slice(leading);
  if (!text) {
    return null;
  }

  return {
    from: contentStart + start + leading,
    to: contentStart + start + trimmedEnd.length,
    text
  };
}
