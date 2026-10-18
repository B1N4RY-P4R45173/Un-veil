import crypto from 'node:crypto';

const ADJECTIVES = ['Curious', 'Quiet', 'Bright', 'Wandering', 'Clever', 'Gentle', 'Bold', 'Sleepy', 'Cosmic', 'Witty', 'Mellow', 'Swift', 'Hidden', 'Lucky', 'Velvet', 'Misty'];
const ANIMALS = ['Otter', 'Fox', 'Owl', 'Panda', 'Falcon', 'Koala', 'Lynx', 'Dolphin', 'Raven', 'Tiger', 'Hedgehog', 'Penguin', 'Wolf', 'Sparrow', 'Moth', 'Heron'];

const pick = (list) => list[crypto.randomInt(0, list.length)];

export function aliasPair() {
  const a = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
  let b = a;
  while (b === a) b = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
  return [a, b];
}
