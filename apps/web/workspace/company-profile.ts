// The API's company_profile tool splits a description the same way. A citation keeps the
// sentence's position and fingerprint so the page can find that exact sentence again.
const sentenceEnd = /(?<=[.!?])\s+(?=["“(]?[A-Z0-9])/g;
// Abbreviations that end with a full stop but rarely end an English sentence.
const abbreviation = /(?:(?:^|[\s(])(?:[A-Z]\.)+|\b(?:Inc|Co|Corp|Ltd|Plc|Bros|No|Nos|St|Mt|Mr|Mrs|Ms|Dr|Jr|Sr|vs|approx|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.)$/;

export function profileSentences(description: string): string[] {
  const text = description.split(/\s+/).filter(Boolean).join(" ");
  const sentences: string[] = [];
  let start = 0;
  for (const boundary of text.matchAll(sentenceEnd)) {
    const end = boundary.index ?? 0;
    if (abbreviation.test(text.slice(start, end))) continue;
    sentences.push(text.slice(start, end).trim());
    start = end + boundary[0].length;
  }
  sentences.push(text.slice(start).trim());
  return sentences.filter(Boolean);
}

/** 32-bit FNV-1a of the sentence's UTF-8 bytes, as the API computes it. */
export function sentenceId(sentence: string): string {
  let value = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(sentence)) value = Math.imul(value ^ byte, 0x01000193) >>> 0;
  return value.toString(16).padStart(8, "0");
}
