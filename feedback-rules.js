// Explicit acknowledgements are routine chat. A mixed message still needs review.
export function isRoutineAcknowledgement(text) {
  const value = String(text || '').normalize('NFKC').trim();
  if(value.includes('?'))return false;
  return /^(?:沒問題|没问题|沒有問題|没有问题|沒事|没事|收到(?:了)?|知道了|了解(?:了)?|明白(?:了)?|好的|好哦|好喔|謝謝(?:你|您)?|谢谢(?:你|您)?|感謝(?:你|您)?|OK|好|👍[🏻-🏿]?|🙏[🏻-🏿]?|[\p{P}\s\uFE0F])*$/iu.test(value);
}
