import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import axios from "axios";
import { createClient } from "redis";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { checkFaq } from "./faqService.js";
import { buildMemoryReply } from "./formatCaseMemory.js";
import {
  searchSimilarCases,
  indexCase,
  indexResolutionSummary,
} from "./caseMemory.js";
import { analyzeSentiment } from "./sentiment.js";
import { computeSLA } from "./sla.js";

dotenv.config();

/* ----------------------------- Env Validation ----------------------------- */
const requiredEnv = ["MONGO_URI", "JWT_SECRET", "GEMINI_API_KEY", "CORS_ORIGIN"];
requiredEnv.forEach((key) => {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
});

/* --------------------------------- App ----------------------------------- */
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS: Production frontend URL
const allowedOrigins = process.env.CORS_ORIGIN.split(",").map(o => o.trim());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

/* ------------------------------- Health Check ------------------------------- */
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/* ------------------------------- Redis ----------------------------------- */
let redisClient;
async function initRedis() {
  redisClient = createClient({
    url: process.env.REDIS_URL,
    socket: {
      reconnectStrategy: (retries) => Math.min(retries * 50, 1000),
      tls: process.env.REDIS_USE_TLS === "true",
    },
    password: process.env.REDIS_PASSWORD,
  });

  redisClient.on("error", (err) => console.error("Redis Error:", err));
  await redisClient.connect();
  console.log("Redis connected");
}

/* -------- Agent-only lock helpers (per case) -------- */
const AGENT_ONLY_TTL = 30 * 60; // 30 minutes
async function setAgentOnly(caseId) {
  if (!caseId) return;
  await redisClient.set(`agent-only:${caseId}`, "1", { EX: AGENT_ONLY_TTL });
}
async function isAgentOnly(caseId) {
  if (!caseId) return false;
  return Boolean(await redisClient.get(`agent-only:${caseId}`));
}
async function clearAgentOnly(caseId) {
  if (!caseId) return;
  await redisClient.del(`agent-only:${caseId}`);
}

/* ----------------------------- Gemini Models ----------------------------- */
const GEMINI_MODELS = [
  "gemini-2.0-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
];

async function callGemini(prompt) {
  for (let model of GEMINI_MODELS) {
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: prompt }] }] },
        { headers: { "Content-Type": "application/json" } }
      );
      const text = response.data.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n").trim() || "";
      if (text) return text;
    } catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === 429) {
        console.warn(`Model ${model} quota exhausted, trying next...`);
        continue;
      } else if (code === 400 || code === 401) {
        console.error(`Gemini error ${code}:`, err.response?.data?.error?.message);
        throw new Error(`Gemini API error: ${err.response?.data?.error?.message}`);
      } else {
        console.error(`Error with ${model}:`, err.message);
        throw err;
      }
    }
  }
  throw new Error("All Gemini models failed.");
}

/* --------------------------- Priority helpers ---------------------------- */
function determinePriority(description) {
  const paymentKeywords = ["payment", "refund", "billing", "charge", "transaction"];
  const orderKeywords = ["order", "delivery", "product", "item", "cancel", "undo"];
  const lowerDesc = description.toLowerCase();

  if (paymentKeywords.some(k => lowerDesc.includes(k))) return "high";
  if (orderKeywords.some(k => lowerDesc.includes(k))) return "low";
  return "low";
}

/* -------------------------------- Models --------------------------------- */
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, enum: ["user", "admin"], default: "user" },
  orders: [
    {
      orderId: String,
      status: String,
      totalAmount: Number,
      paymentMethod: String,
      orderDate: Date,
      delivery: { address: String, pincode: String, expectedDeliveryDate: Date },
      products: [
        {
          name: String,
          quantity: Number,
          price: Number,
          domain: {
            type: String,
            enum: ["E-commerce", "Travel", "Telecommunications", "Banking Services"],
            required: true,
          },
        },
      ],
    },
  ],
});
userSchema.index({ email: 1 }, { unique: true });
const User = mongoose.model("User", userSchema);

const caseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  orderId: { type: String, required: true },
  productIndex: { type: Number, required: true },
  description: { type: String, required: true },
  domain: {
    type: String,
    enum: ["E-commerce", "Travel", "Telecommunications", "Banking Services"],
    required: true,
  },
  priority: { type: String, default: "low", enum: ["high", "low"] },
  status: { type: String, default: "open", enum: ["open", "in-progress", "resolved"] },
  productChanges: { name: String, price: Number, quantity: Number },
  responses: [
    {
      adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      message: String,
      timestamp: { type: Date, default: Date.now },
    },
  ],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
caseSchema.index({ userId: 1, orderId: 1, productIndex: 1 }, { unique: true });
const Case = mongoose.model("Case", caseSchema);

/* ---------------------------- Auth Middleware ---------------------------- */
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* --------------------------- Product Selection --------------------------- */
app.post("/api/select-product", authMiddleware, async (req, res) => {
  try {
    const { orderId, productIndex } = req.body;
    const userId = req.userId;

    const user = await User.findById(userId).select("orders");
    if (!user) return res.status(404).json({ error: "User not found" });

    const order = user.orders.find(o => o.orderId === orderId);
    if (!order || productIndex < 0 || productIndex >= order.products.length) {
      return res.status(400).json({ error: "Invalid product" });
    }

    const product = order.products[productIndex];
    const selectedProduct = {
      orderId,
      productIndex,
      name: product.name,
      quantity: product.quantity,
      price: product.price,
      domain: product.domain,
      orderDate: order.orderDate,
      status: order.status,
    };

    await redisClient.set(`selected-product:${userId}`, JSON.stringify(selectedProduct), { EX: 3600 });
    res.json({ message: "Product selected" });
  } catch (err) {
    console.error("Select product error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/clear-selected-product", authMiddleware, async (req, res) => {
  await redisClient.del(`selected-product:${req.userId}`);
  res.json({ message: "Cleared" });
});

/* ------------------------------- Cases ----------------------------------- */
app.post("/api/case", authMiddleware, async (req, res) => {
  try {
    const { orderId, productIndex, description, domain } = req.body;
    const userId = req.userId;
    if (!orderId || productIndex === undefined || !description) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const user = await User.findById(userId).select("orders");
    if (!user) return res.status(404).json({ error: "User not found" });

    const order = user.orders.find(o => o.orderId === orderId);
    if (!order || productIndex >= order.products.length) {
      return res.status(400).json({ error: "Invalid product" });
    }

    const productDomain = order.products[productIndex].domain;
    const finalDomain = domain || productDomain || "E-commerce";
    const priority = determinePriority(description);

    let csCase = await Case.findOne({ userId, orderId, productIndex });
    if (csCase) {
      csCase.description = description;
      csCase.priority = priority;
      csCase.domain = finalDomain;
      csCase.updatedAt = new Date();
    } else {
      csCase = new Case({ userId, orderId, productIndex, description, priority, domain: finalDomain });
    }
    await csCase.save();
    await indexCase(csCase);

    const populated = await Case.findById(csCase._id)
      .populate("userId", "name email")
      .populate("responses.adminId", "name")
      .lean();

    res.json({ message: "Case created", case: populated });
  } catch (err) {
    console.error("Case error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ------------------------------- Chat ------------------------------------ */
app.post("/api/chat", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "Message required" });

    // Load user & product
    let userData = await redisClient.get(`user:${userId}`);
    if (!userData) {
      const user = await User.findById(userId).lean();
      if (!user) return res.status(404).json({ error: "User not found" });
      userData = JSON.stringify({ name: user.name, email: user.email, role: user.role });
      await redisClient.set(`user:${userId}`, userData, { EX: 3600 });
    }
    const userObj = JSON.parse(userData);

    const selected = await redisClient.get(`selected-product:${userId}`);
    if (!selected) return res.status(400).json({ error: "Select product first" });
    const { orderId, productIndex, domain, name: productName } = JSON.parse(selected);

    const chatKey = `chat:${userId}:${orderId}:${productIndex}`;
    const io = req.app.get("io");

    // Ensure case exists
    let csCase = await Case.findOne({ userId, orderId, productIndex });
    if (!csCase) {
      csCase = await new Case({
        userId, orderId, productIndex, description: message, priority: "low", domain, status: "open"
      }).save();
    }

    // Agent-only lock?
    if (await isAgentOnly(csCase._id)) {
      await redisClient.rPush(chatKey, JSON.stringify({
        prompt: message, reply: null, orderId, productIndex, caseId: csCase._id,
        timestamp: Date.now(), source: "user"
      }));
      await redisClient.expire(chatKey, 86400);
      io.to("agents").emit("chat:user", { userId, orderId, productIndex, caseId: csCase._id, message });
      return res.json({ queued: true, routed: "human_agent", caseId: csCase._id });
    }

    // FAQ
    const faqHit = await checkFaq(message, domain);
    if (faqHit) {
      const reply = faqHit.answer;
      await redisClient.rPush(chatKey, JSON.stringify({ prompt: message, reply, source: "faq", timestamp: Date.now() }));
      io.to(`user:${userId}`).emit("chat:reply", { message: reply, source: "faq" });
      io.to("agents").emit("chat:reply", { message: reply, source: "faq" });
      return res.json({ reply, source: "faq" });
    }

    // CaseMemory
    const K = Number(process.env.SIM_TOP_K) || 3;
    const CM_TH = Number(process.env.SIM_CASE_THRESHOLD) || 0.72;
    const similar = await searchSimilarCases(message, domain, K);
    if (similar?.[0]?.score >= CM_TH) {
      const pretty = buildMemoryReply(similar[0].summary, { orderId, productName });
      await redisClient.rPush(chatKey, JSON.stringify({ prompt: message, reply: pretty, source: "case-memory", timestamp: Date.now() }));
      io.to(`user:${userId}`).emit("chat:reply", { message: pretty, source: "case-memory" });
      io.to("agents").emit("chat:reply", { message: pretty, source: "case-memory" });
      return res.json({ reply: pretty, source: "case-memory" });
    }

    // LLM
    const prompt = `You are a helpful assistant for ${domain}. User: ${userObj.name}. Product: ${productName}. Order: ${orderId}. Message: "${message}". Reply concisely.`;
    let llmReply = "We'll escalate this to a specialist.";
    try { llmReply = await callGemini(prompt); } catch (e) { console.warn("Gemini failed:", e); }

    await redisClient.rPush(chatKey, JSON.stringify({ prompt: message, reply: llmReply, source: "llm", timestamp: Date.now() }));
    io.to(`user:${userId}`).emit("chat:reply", { message: llmReply, source: "llm" });
    io.to("agents").emit("chat:reply", { message: llmReply, source: "llm" });
    return res.json({ reply: llmReply, source: "llm", caseId: csCase._id });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* --------------------------- Socket.IO Setup --------------------------- */
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: allowedOrigins, credentials: true },
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("No token"));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.data.userId = payload.id;
    socket.data.role = payload.role;
    next();
  } catch (e) {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  const { userId, role } = socket.data;
  socket.join(`user:${userId}`);
  if (role === "admin") socket.join("agents");
  socket.on("join_case", ({ caseId }) => socket.join(`case:${caseId}`));
});

/* -------------------------- Make io available -------------------------- */
app.set("io", io);

/* ------------------------------ MongoDB --------------------------------- */
async function initMongo() {
  const start = Date.now();
  mongoose.set("debug", process.env.NODE_ENV !== "production");
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 10,
  });
  console.log(`MongoDB Connected in ${Date.now() - start}ms`);
}

/* ------------------------------ Start Server --------------------------- */
async function startServer() {
  await initRedis();
  await initMongo();

  const PORT = process.env.PORT || 5000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});