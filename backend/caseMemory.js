

// caseMemory.js
import mongoose from "mongoose";
import { getEmbedding } from "./faqService.js";

const caseMemorySchema = new mongoose.Schema({
  caseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Case",
    required: true,
    unique: true,
  },
  orderId: String,
  productIndex: Number,
  summary: String, // description or final resolution summary
  domain: {
    type: String,
    enum: ["E-commerce", "Travel", "Telecommunications", "Banking Services"],
  },
  embedding: [Number],
  createdAt: { type: Date, default: Date.now },
});
const CaseMemory =
  mongoose.models.CaseMemory || mongoose.model("CaseMemory", caseMemorySchema);

function cosine(a = [], b = []) {
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

export async function indexCase(caseDoc) {
  if (!caseDoc || !caseDoc._id) return;
  try {
    const text =
      (caseDoc.description || "").slice(0, 512) || `Case ${caseDoc._id}`;
    const embedding = await getEmbedding(text);
    await CaseMemory.findOneAndUpdate(
      { caseId: caseDoc._id },
      {
        caseId: caseDoc._id,
        orderId: caseDoc.orderId,
        productIndex: caseDoc.productIndex,
        summary: text,
        domain: caseDoc.domain || "E-commerce",
        embedding,
        createdAt: new Date(),
      },
      { upsert: true, new: true }
    );
    console.log(`Indexed case description memory for case ${caseDoc._id}`);
  } catch (err) {
    console.error("Case memory indexing error:", err?.message || err);
  }
}

export async function indexResolutionSummary(caseDoc, summaryText) {
  if (!caseDoc || !caseDoc._id || !summaryText) return;
  try {
    const text = summaryText.slice(0, 512);
    const embedding = await getEmbedding(text);
    await CaseMemory.findOneAndUpdate(
      { caseId: caseDoc._id },
      {
        caseId: caseDoc._id,
        orderId: caseDoc.orderId,
        productIndex: caseDoc.productIndex,
        summary: text,
        domain: caseDoc.domain || "E-commerce",
        embedding,
        createdAt: new Date(),
      },
      { upsert: true, new: true }
    );
    console.log(`Indexed case *resolution* summary for case ${caseDoc._id}`);
  } catch (err) {
    console.error("Resolution memory indexing error:", err?.message || err);
  }
}

export async function searchSimilarCases(text, domain = null, topK = 3) {
  try {
    const queryEmbedding = await getEmbedding((text || "").slice(0, 512));
    const filter = domain ? { domain } : {};
    const candidates = await CaseMemory.find(filter).lean().limit(200);
    const scored = candidates
      .map((c) => ({
        ...c,
        score: cosine(queryEmbedding, c.embedding || []),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return scored;
  } catch (err) {
    console.error("Case memory search error:", err?.message || err);
    return [];
  }
}

export default CaseMemory;
