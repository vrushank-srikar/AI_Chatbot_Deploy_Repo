// sentiment.js
const ANGER_WORDS = [
  "angry", "furious", "frustrated", "worst", "nonsense", "cheated",
  "wtf", "hate", "mad", "ridiculous", "disgusting", "scam", "fraud",
  "terrible", "immediately"
];
const CALM_WORDS = [
  "please", "thank", "thanks", "could you", "may i", "no hurry",
  "whenever", "take your time", "ok", "cool", "fine"
];

export function analyzeSentiment(text = "") {
  const t = text.toLowerCase();
  let score = 0;

  for (const w of ANGER_WORDS) if (t.includes(w)) score -= 1;
  for (const w of CALM_WORDS)  if (t.includes(w)) score += 0.6;

  if (t.includes("!!!") || t.includes("?!?!")) score -= 0.6;
  if (t.includes(":)")) score += 0.3;
  if (t.includes(":(")) score -= 0.3;

  let label = "neutral";
  if (score <= -0.8) label = "angry";
  else if (score >= 0.6) label = "cool";

  return { label, score: Math.max(-1, Math.min(1, score)) };
}
