export const optionalPreviewSections = Object.freeze(['summary', 'history']);

// An approximation of room prompt text only; provider instructions, tools, and
// output from earlier ordered steps are not part of the estimate.
export const estimatePreviewTokens = text => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);

export function previewSection(id, label, text) {
  return Object.freeze({ id, label, text, optional: optionalPreviewSections.includes(id), tokens: estimatePreviewTokens(text) });
}

export function stalePreview() {
  return Object.assign(new Error('This preview is stale. Open a new /preview before sending.'), { code: 'STALE_PREVIEW' });
}
