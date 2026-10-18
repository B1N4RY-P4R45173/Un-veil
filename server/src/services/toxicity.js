// Neural toxicity classifier. Runs Google's Jigsaw-trained toxicity model (a Universal
// Sentence Encoder transformer with seven sigmoid heads) locally with TensorFlow.js,
// so no message ever leaves the server for moderation.
//
// Model files are downloaded once by `npm run fetch-model` (also run on install).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
process.env.TF_CPP_MIN_LOG_LEVEL ??= '2'; // keep TensorFlow's C++ start-up chatter out of the logs
const MODEL_DIR = process.env.TOXICITY_MODEL_DIR
  || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../models/toxicity');

export const LABELS = ['identity_attack', 'insult', 'obscene', 'severe_toxicity', 'sexual_explicit', 'threat', 'toxicity'];

// SentencePiece-style tokenizer used by the Universal Sentence Encoder: the input is
// split into the vocabulary pieces with the highest total log-probability (Viterbi).
export class Tokenizer {
  constructor(vocab) {
    this.pieces = new Map();
    this.maxLen = 0;
    vocab.forEach(([piece, score], id) => {
      if (id < 6) return; // reserved symbols
      this.pieces.set(piece, { id, score });
      this.maxLen = Math.max(this.maxLen, piece.length);
    });
  }

  encode(text) {
    const normalized = text.normalize('NFKC');
    if (!normalized) return [];
    const s = `▁${normalized.replace(/ /g, '▁')}`;
    const chars = Array.from(s);
    const n = chars.length;
    const best = new Array(n + 1).fill(null);
    best[0] = { score: 0, from: -1, id: null };
    for (let i = 0; i < n; i++) {
      if (!best[i]) continue;
      let matched = false;
      let piece = '';
      for (let j = i; j < Math.min(n, i + this.maxLen); j++) {
        piece += chars[j];
        const hit = this.pieces.get(piece);
        if (!hit) continue;
        matched = true;
        const score = best[i].score + hit.score;
        if (!best[j + 1] || score > best[j + 1].score) best[j + 1] = { score, from: i, id: hit.id };
      }
      // Characters outside the vocabulary become the unknown token (id 0).
      if (!matched || !best[i + 1]) {
        const score = best[i].score - 20;
        if (!best[i + 1] || score > best[i + 1].score) best[i + 1] = { score, from: i, id: 0 };
      }
    }
    const ids = [];
    for (let k = n; k > 0; k = best[k].from) ids.push(best[k].id);
    ids.reverse();
    // Collapse runs of unknowns into one, as the reference tokenizer does.
    return ids.filter((id, i) => !(id === 0 && ids[i - 1] === 0));
  }
}

let state = null; // { tf, model, tokenizer, outputs }
let loading = null;

export function modelAvailable() {
  return fs.existsSync(path.join(MODEL_DIR, 'model.json')) && fs.existsSync(path.join(MODEL_DIR, 'vocab.json'));
}

export async function loadModel() {
  if (state) return state;
  loading ??= (async () => {
    if (!modelAvailable()) throw new Error(`toxicity model not found in ${MODEL_DIR}; run "npm run fetch-model"`);
    const tf = require('@tensorflow/tfjs-node');
    const model = await tf.loadGraphModel(tf.io.fileSystem(path.join(MODEL_DIR, 'model.json')));
    const tokenizer = new Tokenizer(JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'vocab.json'), 'utf8')));
    // Each output node is named "<label>/...": map them back to label names.
    const outputs = model.outputs.map((o) => o.name.split('/')[0]);
    state = { tf, model, tokenizer, outputs };
    return state;
  })();
  try {
    return await loading;
  } catch (err) {
    loading = null;
    throw err;
  }
}

// Returns, for each text, the probability (0..1) of every label.
export async function score(texts) {
  const { tf, model, tokenizer, outputs } = await loadModel();
  const encodings = texts.map((t) => {
    const ids = tokenizer.encode(t);
    return ids.length ? ids : [0];
  });
  const indices = [];
  const values = [];
  encodings.forEach((ids, row) => ids.forEach((id, col) => {
    indices.push([row, col]);
    values.push(id);
  }));
  const inputs = {
    Placeholder_1: tf.tensor2d(indices, [indices.length, 2], 'int32'),
    Placeholder: tf.tensor1d(values, 'int32'),
  };
  let results;
  try {
    results = await model.executeAsync(inputs);
    const perLabel = await Promise.all(results.map((r) => r.array()));
    return texts.map((_, row) => {
      const probs = {};
      outputs.forEach((label, k) => {
        probs[label] = perLabel[k][row][1]; // [p(not label), p(label)]
      });
      return probs;
    });
  } finally {
    Object.values(inputs).forEach((t) => t.dispose());
    results?.forEach((t) => t.dispose());
  }
}
