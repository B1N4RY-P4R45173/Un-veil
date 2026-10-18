// AIModerationSystem. Every message is scored by a neural toxicity model (see
// toxicity.js) before it is delivered; the scores decide whether it is delivered,
// blocked with a warning, or blocked and the chat ended.
import { score, LABELS } from './toxicity.js';

const SEVERITY_ORDER = ['none', 'low', 'medium', 'high'];
const max = (a, b) => (SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b);

// Probability thresholds per model label. A message takes the highest severity any
// label reaches. Tuned so banter and casual swearing get through while targeted
// abuse, threats and hate do not.
export const THRESHOLDS = {
  threat:          { high: 0.6, medium: 0.4 },
  severe_toxicity: { high: 0.5, medium: 0.3 },
  identity_attack: { high: 0.6, medium: 0.4 },
  sexual_explicit: { medium: 0.6, low: 0.25 },
  insult:          { medium: 0.9, low: 0.6 },
  toxicity:        { low: 0.7 },
  obscene:         { low: 0.6 },
};

const CATEGORY = {
  threat: 'threat',
  severe_toxicity: 'severe abuse',
  identity_attack: 'hate',
  sexual_explicit: 'sexual',
  insult: 'harassment',
  toxicity: 'toxic',
  obscene: 'profanity',
};

// Before the reveal, contact details would break anonymity, so they are masked.
const PII_PATTERNS = [
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'url', re: /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|in|net|org|io|me|gg|ly)\b(?:\/\S*)?/gi },
  { kind: 'phone', re: /(?:\+?\d[\s-]?){10,13}/g },
  { kind: 'handle', re: /(?:^|\s)@[A-Za-z0-9_.]{3,}/g },
  { kind: 'social', re: /\b(?:insta(?:gram)?|snap(?:chat)?|whats ?app|telegram|discord)\s*(?:id|handle|is|:)?\s*[:\-]?\s*[A-Za-z0-9_.]{3,}/gi },
];

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

// Undoes common obfuscation (leetspeak, stretched letters, spaced-out words) so the
// model sees "k1ll yooouuu" the way a person reads it.
export function deobfuscate(text) {
  return text
    .replace(/(?<=[a-z])[013457@$]|[013457@$](?=[a-z])/gi, (c) => LEET[c] ?? c)
    .replace(/(.)\1{2,}/g, '$1$1')
    .replace(/\b(?:[a-z] ){2,}[a-z]\b/gi, (m) => m.replace(/ /g, ''));
}

const sameText = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function maskPii(text) {
  let masked = text;
  const found = new Set();
  for (const { kind, re } of PII_PATTERNS) {
    masked = masked.replace(re, (m) => {
      found.add(kind);
      const lead = m.match(/^\s*/)[0];
      return `${lead}[hidden until reveal]`;
    });
  }
  return { text: masked, found: [...found] };
}

// Turns label probabilities into a severity and the categories that triggered it.
export function judge(scores) {
  let severity = 'none';
  const categories = [];
  for (const [label, levels] of Object.entries(THRESHOLDS)) {
    const p = scores[label] ?? 0;
    const hit = ['high', 'medium', 'low'].find((lvl) => levels[lvl] !== undefined && p >= levels[lvl]);
    if (hit) {
      severity = max(severity, hit);
      categories.push(CATEGORY[label]);
    }
  }
  return { severity, categories };
}

// Returns { severity, categories, scores, text } where text is what may be delivered.
export async function classify(text, { revealed = false, recent = [], priorBorderline = 0 } = {}) {
  const variants = [text];
  const clean = deobfuscate(text);
  if (clean !== text) variants.push(clean);
  const results = await score(variants);
  // Take the worst reading of the raw and de-obfuscated text.
  const scores = Object.fromEntries(LABELS.map((l) => [l, Math.max(...results.map((r) => r[l] ?? 0))]));
  let { severity, categories } = judge(scores);

  // A third borderline message (rude, suggestive) in one chat is treated as harassment.
  const borderline = severity === 'low' && categories.some((c) => ['harassment', 'sexual', 'toxic'].includes(c));
  if (borderline && priorBorderline >= 2) {
    categories.push('repeated');
    severity = 'medium';
  }

  // Spam is about behaviour, not wording: the same message again and again.
  const repeats = recent.filter((r) => sameText(r, text)).length;
  if (text.trim() && repeats >= 2) {
    categories.push('spam');
    severity = max(severity, repeats >= 4 ? 'medium' : 'low');
  }

  let out = text;
  if (!revealed) {
    const pii = maskPii(text);
    if (pii.found.length) {
      categories.push('personal-info');
      out = pii.text;
    }
  }
  const rounded = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
  return { severity, categories: [...new Set(categories)], scores: rounded, text: out };
}

// What happens to a message at each severity.
export function actionFor(severity) {
  switch (severity) {
    case 'high': return { deliver: false, warn: true, endChat: true, report: true };
    case 'medium': return { deliver: false, warn: true, endChat: false, report: true };
    default: return { deliver: true, warn: false, endChat: false, report: false };
  }
}
