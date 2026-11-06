/**
 * 文本分包：把一次请求的多段文本按「条数上限 + 字符上限」切分成若干批。
 * 顺序必须保持不变，否则译文会错位。
 */

export function packTexts(texts, maxTexts = 8, maxChars = 2000) {
  const batches = [];
  let current = [];
  let currentChars = 0;

  for (const raw of texts) {
    const text = String(raw ?? '');
    const size = text.length;
    const exceedTexts = current.length >= maxTexts;
    const exceedChars = currentChars + size > maxChars && current.length > 0;
    if (exceedTexts || exceedChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(text);
    currentChars += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** 把二维批次结果按原顺序拍平 */
export function flattenBatches(batchResults) {
  const out = [];
  for (const batch of batchResults) for (const item of batch) out.push(item);
  return out;
}