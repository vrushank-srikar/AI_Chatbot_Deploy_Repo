// formatCaseMemory.js  (ESM)

// Remove role tags, pipes, extra spaces
export function cleanTranscript(text = "") {
  return String(text)
    .replace(/\b(Agent|User|Support Bot)\s*:\s*/gi, "")
    .replace(/\|\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Prefer everything after “Resolution Summary:”, else fallback to first 1–2 sentences
export function pickResolutionSummary(text = "") {
  const m = text.match(/Resolution Summary\s*:\s*([\s\S]+)/i);
  if (m && m[1]) return m[1].trim();
  const parts = text.split(/(?<=[.?!])\s+/).slice(0, 2);
  return parts.join(" ").trim();
}

// Build a short, human reply from a raw case-memory blob
export function buildMemoryReply(
  rawMessage = "",
  { orderId, productName, missingQty } = {}
) {
  const cleaned = cleanTranscript(rawMessage);
  const summary = pickResolutionSummary(cleaned) || cleaned;

  const action = /refund/i.test(summary)
    ? "issue a refund"
    : /replace|replacement/i.test(summary)
    ? "send a replacement"
    : "resolve this for you";

  const qtyPart =
    missingQty && productName
      ? `${missingQty} ${productName}${Number(missingQty) > 1 ? "s" : ""}`
      : productName
      ? `the ${productName}`
      : "the missing item";

  const orderPart = orderId ? ` for order ${orderId}` : "";

  return `I’ve handled a similar case before: ${summary}. For your case${orderPart}, I can ${action} for ${qtyPart} right away or connect you with a specialist. Would you like me to proceed?`;
}
