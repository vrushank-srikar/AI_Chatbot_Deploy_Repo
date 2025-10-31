// faqService.js
import axios from "axios";
import mongoose from "mongoose";

const faqSchema = new mongoose.Schema(
  {
    question: String,
    answer: String,
    domain: {
      type: String,
      enum: ["E-commerce", "Travel", "Telecommunications", "Banking Services"],
      required: true,
    },
    embedding: [Number],
  },
  { collection: "faqs" }
);

export const Faq = mongoose.models.Faq || mongoose.model("Faq", faqSchema);

export async function getEmbedding(text) {
  try {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${process.env.GEMINI_API_KEY}`,
      { content: { parts: [{ text }] } },
      { headers: { "Content-Type": "application/json" } }
    );
    return r.data.embedding.values;
  } catch (err) {
    console.error("Embedding error:", err?.message || err);
    throw new Error("Failed to get embedding");
  }
}

export function cosineSimilarity(a = [], b = []) {
  let dot = 0,
    na = 0,
    nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i] || 0,
      bi = b[i] || 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function initFaqs(faqCollections) {
  for (const { faqs } of faqCollections) {
    for (const faq of faqs) {
      const existing = await Faq.findOne({
        question: faq.question,
        domain: faq.domain,
      });
      if (!existing) {
        const embedding = await getEmbedding(faq.question);
        await new Faq({ ...faq, embedding }).save();
        console.log(`Added FAQ: ${faq.question} [${faq.domain}]`);
      }
    }
  }
}

export async function checkFaq(message, domain) {
  try {
    const THRESH = Number(process.env.FAQ_SIM_THRESHOLD ?? 0.76);
    const TOPK = Number(process.env.FAQ_TOP_K ?? 3);

    const queryEmbedding = await getEmbedding(message.slice(0, 512));
    const filter = domain ? { domain } : {};
    const faqs = await Faq.find(filter).lean();

    const ranked = faqs
      .map((f) => ({
        ans: f.answer,
        score: cosineSimilarity(queryEmbedding, f.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOPK);

    const best = ranked[0];
    return best && best.score >= THRESH
      ? { answer: best.ans, score: best.score }
      : null;
  } catch (err) {
    console.error("checkFaq error:", err?.message || err);
    return null;
  }
}
