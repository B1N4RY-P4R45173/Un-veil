// Downloads the pretrained toxicity model (TensorFlow.js graph model, ~29 MB) and the
// Universal Sentence Encoder vocabulary into models/toxicity. Files are checked against
// pinned SHA-256 hashes; existing valid files are kept, so this is safe to re-run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = process.env.TOXICITY_MODEL_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../models/toxicity');
const BASE = 'https://storage.googleapis.com/tfjs-models/savedmodel';

const FILES = {
  'model.json': ['toxicity/model.json', '27a8c98c1062132f88fe2e8a1e11c80c4166709f0d6f04baedc4df8c43739037'],
  'group1-shard1of7': ['toxicity/group1-shard1of7', 'dae447834c7dd07424b0545a56621c11ef383d70a8d8901cd9b07c0a778b404c'],
  'group1-shard2of7': ['toxicity/group1-shard2of7', 'dd8301fc28abeea331739659af669b2ceb34c542cd6497636691e85823890997'],
  'group1-shard3of7': ['toxicity/group1-shard3of7', 'c7ef20d7bd2aab0524a58ec9a63298922cb6443e8f27d9d4aac91f5213b5bedb'],
  'group1-shard4of7': ['toxicity/group1-shard4of7', 'e5333f7340b90299624caba94758dfdc97e116898d057d2bf8359a5a84f49578'],
  'group1-shard5of7': ['toxicity/group1-shard5of7', '28f597298cefe70851491edb65a553c7ca1bb3c4f1aaaa0e12618de8e4706d08'],
  'group1-shard6of7': ['toxicity/group1-shard6of7', 'f74b009e4ccea1be2f82206eb827ccbe3e7cdda4d2fc936718035058e7f11e6f'],
  'group1-shard7of7': ['toxicity/group1-shard7of7', '4f8be744443d1b66430e391088abc4961afe4fcbc8e433d388dbea252cf9534c'],
  'vocab.json': ['universal_sentence_encoder/vocab.json', '1ad860b9720c16cd48e666d664a556b2515c04f5a26a4b53c0372427913b1b8e'],
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

fs.mkdirSync(DIR, { recursive: true });
let fetched = 0;
for (const [name, [remote, hash]] of Object.entries(FILES)) {
  const dest = path.join(DIR, name);
  if (fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === hash) continue;
  const res = await fetch(`${BASE}/${remote}`);
  if (!res.ok) throw new Error(`Download failed for ${remote}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== hash) throw new Error(`Checksum mismatch for ${remote}; refusing to use it.`);
  fs.writeFileSync(dest, buf);
  fetched++;
}
console.log(fetched ? `Toxicity model ready (${fetched} file(s) downloaded).` : 'Toxicity model already present.');
