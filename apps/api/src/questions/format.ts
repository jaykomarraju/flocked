// Question format (spec "Core game rules" › Question format), checked by the server after the
// request schema (`QuestionInputSchema`: lengths, two options that differ, the category list).
// This adds what the schema can't say: prompt and labels are stored NFC-normalized and trimmed, and
// must still be non-empty and plain text (no control characters) after that, and an option's emoji
// is a single emoji. A failure is 400 `bad_request`, before the quota, Turnstile or moderation.
import { optionsDiffer, type Category, type QuestionOptionInput } from '@flocked/shared';
import { HttpError } from '../lib/errors.js';
import type { ModerationInput } from '../moderation/index.js';

const CONTROL = /\p{Cc}/u;
/** Pictographs, flags (regional indicators) and keycaps. */
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** True when `s` is one grapheme that is an emoji. */
export function isSingleEmoji(s: string): boolean {
  const it = graphemes.segment(s)[Symbol.iterator]();
  return !it.next().done && it.next().done === true && EMOJI.test(s);
}

function cleanText(raw: string, what: string): string {
  const s = raw.normalize('NFC').trim();
  if (s.length === 0) throw new HttpError('bad_request', `The ${what} is empty`);
  if (CONTROL.test(s)) {
    throw new HttpError('bad_request', `The ${what} must be plain text on one line`);
  }
  return s;
}

function cleanOption(o: QuestionOptionInput, n: number): { label: string; emoji?: string } {
  const label = cleanText(o.label, `option ${n} label`);
  if (o.emoji === undefined) return { label };
  const emoji = o.emoji.trim();
  if (!isSingleEmoji(emoji)) {
    throw new HttpError('bad_request', `Option ${n} takes a single emoji`);
  }
  return { label, emoji };
}

/** A schema-valid question, cleaned for storage and moderation (or 400 `bad_request`). */
export function cleanQuestionInput(input: {
  prompt: string;
  options: readonly [QuestionOptionInput, QuestionOptionInput];
  category: Category;
}): ModerationInput {
  const q: ModerationInput = {
    prompt: cleanText(input.prompt, 'prompt'),
    options: [cleanOption(input.options[0], 1), cleanOption(input.options[1], 2)],
    category: input.category,
  };
  if (!optionsDiffer(q)) throw new HttpError('bad_request', 'The two options must differ');
  return q;
}

/** `options_json` as stored: `[{label, emoji}, …]`, `emoji` "" when there is none. */
export function storedOptionsJson(options: ModerationInput['options']): string {
  return JSON.stringify(options.map((o) => ({ label: o.label, emoji: o.emoji ?? '' })));
}
