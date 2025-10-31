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
const requiredEnv = ["MONGO_URI", "JWT_SECRET", "GEMINI_API_KEY"];
requiredEnv.forEach((key) => {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
});

/* --------------------------------- App ----------------------------------- */
const app = express();
app.use(express.json());
app.use(
  cors({
    origin:
      process.env.CORS_ORIGIN?.split(",") || [
        "http://localhost:5173",
        "http://localhost:3000",
      ],
    credentials: true,
  })
);

/* ------------------------------- Redis ----------------------------------- */
const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 50, 1000),
    tls: process.env.REDIS_USE_TLS === "true" ? {} : false,
  },
  password: process.env.REDIS_PASSWORD,
});
redisClient.on("error", (err) => console.error("Redis Error:", err));
await redisClient.connect();

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
      const text =
        response.data.candidates?.[0]?.content?.parts
          ?.map((p) => p.text)
          .join("\n")
          .trim() || "";
      if (text) return text;
    } catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === 429) {
        console.warn(`Model ${model} quota exhausted, trying next model...`);
        continue;
      } else if (code === 400) {
        console.error(
          `Bad request for ${model}: ${err.response?.data?.error?.message}`
        );
        throw new Error(
          `Invalid request to Gemini API: ${err.response?.data?.error?.message}`
        );
      } else if (code === 401) {
        console.error(
          `Authentication error for ${model}: ${err.response?.data?.error?.message}`
        );
        throw new Error("Gemini API authentication failed");
      } else {
        console.error(`Error with ${model}: ${err.message}`);
        throw err;
      }
    }
  }
  throw new Error("All Gemini models exhausted or failed.");
}

/* --------------------------- Priority helpers ---------------------------- */
function determinePriority(description) {
  const paymentKeywords = [
    "payment",
    "refund",
    "billing",
    "charge",
    "transaction",
  ];
  const orderKeywords = [
    "order",
    "delivery",
    "product",
    "item",
    "cancel",
    "undo",
  ];
  const lowerDesc = description.toLowerCase();

  if (paymentKeywords.some((keyword) => lowerDesc.includes(keyword))) {
    return "high";
  } else if (orderKeywords.some((keyword) => lowerDesc.includes(keyword))) {
    return "low";
  }
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
      delivery: {
        address: String,
        pincode: String,
        expectedDeliveryDate: Date,
      },
      products: [
        {
          name: String,
          quantity: Number,
          price: Number,
          domain: {
            type: String,
            enum: [
              "E-commerce",
              "Travel",
              "Telecommunications",
              "Banking Services",
            ],
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
  productChanges: {
    name: String,
    price: Number,
    quantity: Number,
  },
  responses: [
    {
      adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
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
  if (!token) return res.status(401).json({ error: "Unauthorized, token missing" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/* --------------------------- Product Selection --------------------------- */
app.post("/api/select-product", authMiddleware, async (req, res) => {
  try {
    const { orderId, productIndex } = req.body;
    const userId = req.userId;

    const user = await User.findById(userId).select("orders");
    if (!user) return res.status(404).json({ error: "User not found" });

    const order = user.orders.find((o) => o.orderId === orderId);
    if (!order || productIndex < 0 || productIndex >= order.products.length) {
      return res.status(400).json({ error: "Invalid order or product index" });
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

    await redisClient.del(`selected-product:${userId}`);
    await redisClient.set(
      `selected-product:${userId}`,
      JSON.stringify(selectedProduct),
      { EX: 3600 }
    );
    res.json({ message: "Product selected successfully" });
  } catch (err) {
    console.error("Select product error:", err);
    res.status(500).json({ error: "Failed to select product" });
  }
});

app.post("/api/clear-selected-product", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    await redisClient.del(`selected-product:${userId}`);
    res.json({ message: "Selected product cleared successfully" });
  } catch (err) {
    console.error("Clear selected product error:", err);
    res.status(500).json({ error: "Failed to clear selected product" });
  }
});

/* ------------------------------- Cases ----------------------------------- */
app.post("/api/case", authMiddleware, async (req, res) => {
  try {
    const { orderId, productIndex, description, domain = "E-commerce" } = req.body;
    const userId = req.userId;
    if (!orderId || productIndex === undefined || !description) {
      return res
        .status(400)
        .json({ error: "Order ID, product index, and description are required" });
    }

    const user = await User.findById(userId).select("orders");
    if (!user) return res.status(404).json({ error: "User not found" });

    const order = user.orders.find((o) => o.orderId === orderId);
    if (!order || productIndex < 0 || productIndex >= order.products.length) {
      return res.status(400).json({ error: "Invalid order or product index" });
    }

    const productDomain = order.products[productIndex].domain;
    const finalDomain = domain || productDomain || "E-commerce";
    const priority = determinePriority(description);

    let newCase;
    const existingCase = await Case.findOne({ userId, orderId, productIndex });
    if (existingCase) {
      existingCase.description = description;
      existingCase.priority = priority;
      existingCase.domain = finalDomain;
      existingCase.updatedAt = new Date();
      await existingCase.save();
      newCase = existingCase;
      await indexCase(newCase);
    } else {
      newCase = new Case({
        userId,
        orderId,
        productIndex,
        description,
        priority,
        domain: finalDomain,
      });
      await newCase.save();
      await indexCase(newCase);
    }

    const populatedCase = await Case.findById(newCase._id)
      .populate("userId", "name email")
      .populate("responses.adminId", "name")
      .lean();

    res.json({ message: "Case processed successfully", case: populatedCase });
  } catch (err) {
    console.error("Create case error:", err);
    res.status(500).json({ error: "Failed to process case" });
  }
});

app.get("/api/user/:id", authMiddleware, async (req, res) => {
  try {
    const start = Date.now();
    const user = await User.findById(req.params.id).lean();
    console.log(`User.findById took ${Date.now() - start}ms for ID: ${req.params.id}`);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (req.userId !== req.params.id && req.userRole !== "admin")
      return res.status(403).json({ error: "Unauthorized access" });
    delete user.password;
    res.json(user);
  } catch (err) {
    console.error("User fetch error:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

app.get("/api/user/:id/cases", authMiddleware, async (req, res) => {
  if (req.userRole !== "user") {
    return res.status(403).json({ error: "User access required" });
  }
  try {
    const { domain } = req.query;
    const query = { userId: req.params.id };
    if (domain) query.domain = domain;

    const cases = await Case.find(query)
      .populate("userId", "name email")
      .populate("responses.adminId", "name")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ cases });
  } catch (err) {
    console.error("User cases error:", err);
    res.status(500).json({ error: "Failed to fetch cases" });
  }
});

app.get("/api/admin/cases", authMiddleware, async (req, res) => {
  if (req.userRole !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  try {
    const cases = await Case.find()
      .populate("userId", "name email")
      .populate("responses.adminId", "name")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ cases });
  } catch (err) {
    console.error("Admin cases error:", err);
    res.status(500).json({ error: "Failed to fetch cases" });
  }
});

app.get("/api/admin/orders", authMiddleware, async (req, res) => {
  if (req.userRole !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  try {
    const users = await User.find({}, "name email orders").lean();
    const orders = users.flatMap((user) =>
      user.orders.map((order) => ({
        ...order,
        userId: user._id,
        userName: user.name,
        userEmail: user.email,
      }))
    );
    res.json({ orders });
  } catch (err) {
    console.error("Admin orders error:", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/* ----------------------- Admin adds a response --------------------------- */
app.post("/api/case/:id/response", authMiddleware, async (req, res) => {
  if (req.userRole !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: "Message required" });
    }
    const updatedCase = await Case.findByIdAndUpdate(
      req.params.id,
      {
        $push: { responses: { adminId: req.userId, message } },
        updatedAt: new Date(),
        status: "in-progress",
      },
      { new: true }
    )
      .populate("userId", "name email")
      .populate("responses.adminId", "name")
      .lean();

    if (!updatedCase) {
      return res.status(404).json({ error: "Case not found" });
    }

    // realtime to case room and user
    const io = req.app.get("io");
    io.to(`case:${updatedCase._id}`).emit("case:message", {
      caseId: updatedCase._id,
      sender: "agent",
      message,
      timestamp: Date.now(),
    });
    io
      .to(`user:${updatedCase.userId._id || updatedCase.userId}`)
      .emit("case:message", {
        caseId: updatedCase._id,
        sender: "agent",
        message,
        timestamp: Date.now(),
      });
    io.to(`case:${updatedCase._id}`).emit("case:status", {
      caseId: updatedCase._id,
      status: "in-progress",
    });
    io
      .to(`user:${updatedCase.userId._id || updatedCase.userId}`)
      .emit("case:status", { caseId: updatedCase._id, status: "in-progress" });

    // chat:reply (user)
    io
      .to(`user:${updatedCase.userId._id || updatedCase.userId}`)
      .emit("chat:reply", {
        userId: updatedCase.userId._id || updatedCase.userId,
        orderId: updatedCase.orderId,
        productIndex: updatedCase.productIndex,
        caseId: updatedCase._id,
        source: "agent",
        message,
        timestamp: Date.now(),
      });

    // mirror to all agents dashboards
    io.to("agents").emit("chat:reply", {
      userId: updatedCase.userId._id || updatedCase.userId,
      orderId: updatedCase.orderId,
      productIndex: updatedCase.productIndex,
      caseId: updatedCase._id,
      source: "agent",
      message,
      timestamp: Date.now(),
    });

    // Enable / renew agent-only mode for this case
    await setAgentOnly(updatedCase._id);

    res.json({ message: "Response added successfully", case: updatedCase });
  } catch (err) {
    console.error("Add response error:", err);
    res.status(500).json({ error: "Failed to add response" });
  }
});

/* ---------------- Admin update case (status/priority etc.) --------------- */
app.put("/api/case/:id", authMiddleware, async (req, res) => {
  if (req.userRole !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  try {
    const caseId = req.params.id;
    const updates = req.body;
    const io = req.app.get("io");

    if (updates.priority && !["high", "low"].includes(updates.priority)) {
      return res.status(400).json({ error: "Invalid priority value" });
    }

    const updatedCase = await Case.findByIdAndUpdate(
      caseId,
      { ...updates, updatedAt: new Date() },
      { new: true }
    )
      .populate("userId", "name email orders")
      .populate("responses.adminId", "name");

    if (!updatedCase) {
      return res.status(404).json({ error: "Case not found" });
    }

    if (updates.productChanges) {
      const user = await User.findById(updatedCase.userId._id);
      const order = user.orders.find((o) => o.orderId === updatedCase.orderId);
      if (order && order.products[updatedCase.productIndex]) {
        const product = order.products[updatedCase.productIndex];
        if (updates.productChanges.name !== undefined)
          product.name = updates.productChanges.name;
        if (updates.productChanges.price !== undefined)
          product.price = updates.productChanges.price;
        if (updates.productChanges.quantity !== undefined)
          product.quantity = updates.productChanges.quantity;

        if (updates.productChanges.price !== undefined) {
          order.totalAmount = order.products.reduce(
            (sum, p) => sum + p.price * p.quantity,
            0
          );
        }
        await user.save();
      }
    }

    // If case resolved: append resolution note, emit, and index summary
    if (updatedCase.status === "resolved") {
      updatedCase.responses = updatedCase.responses || [];
      updatedCase.responses.push({
        adminId: req.userId,
        message:
          "Marked as resolved. If you need more help, tap 'Need more help'.",
        timestamp: new Date(),
      });
      await updatedCase.save();

      io.to(`case:${updatedCase._id}`).emit("case:message", {
        caseId: updatedCase._id,
        sender: "agent",
        message:
          "Marked as resolved. If you need more help, tap 'Need more help'.",
        timestamp: Date.now(),
      });
      io.to(`case:${updatedCase._id}`).emit("case:status", {
        caseId: updatedCase._id,
        status: "resolved",
      });
      io.to(`user:${updatedCase.userId._id}`).emit("case:status", {
        caseId: updatedCase._id,
        status: "resolved",
      });

      // Mirror as chat:reply to user
      io.to(`user:${updatedCase.userId._id}`).emit("chat:reply", {
        userId: updatedCase.userId._id,
        orderId: updatedCase.orderId,
        productIndex: updatedCase.productIndex,
        caseId: updatedCase._id,
        source: "agent",
        message:
          "Marked as resolved. If you need more help, tap 'Need more help'.",
        timestamp: Date.now(),
      });

      // Mirror to agents dashboards as well
      io.to("agents").emit("chat:reply", {
        userId: updatedCase.userId._id,
        orderId: updatedCase.orderId,
        productIndex: updatedCase.productIndex,
        caseId: updatedCase._id,
        source: "agent",
        message:
          "Marked as resolved. If you need more help, tap 'Need more help'.",
        timestamp: Date.now(),
      });

      // Clear agent-only lock after resolution
      await clearAgentOnly(updatedCase._id);

      const lastMsgs = Array.isArray(updatedCase.responses)
        ? updatedCase.responses.slice(-6)
        : [];
      const summaryText =
        "Resolution Summary: " +
        lastMsgs
          .map((r) =>
            r.adminId ? `Agent: ${r.message}` : `User/Bot: ${r.message}`
          )
          .join(" | ")
          .slice(0, 480);
      try {
        await indexResolutionSummary(updatedCase, summaryText);
      } catch (e) {
        console.warn("Failed to index resolution summary:", e?.message || e);
      }
    } else {
      io.to(`case:${updatedCase._id}`).emit("case:status", {
        caseId: updatedCase._id,
        status: updatedCase.status,
      });
      io.to(`user:${updatedCase.userId._id}`).emit("case:status", {
        caseId: updatedCase._id,
        status: updatedCase.status,
      });
    }

    res.json({
      message: "Case updated successfully",
      case: updatedCase.toObject(),
    });
  } catch (err) {
    console.error("Update case error:", err);
    res.status(500).json({ error: "Failed to update case" });
  }
});

/* ------------- Optional: Admin manual toggle agent-only mode ------------- */
app.put("/api/case/:id/agent-only", authMiddleware, async (req, res) => {
  if (req.userRole !== "admin") return res.status(403).json({ error: "Admin access required" });
  const { id } = req.params;
  const { enabled } = req.body;
  const exists = await Case.exists({ _id: id });
  if (!exists) return res.status(404).json({ error: "Case not found" });

  if (enabled) await setAgentOnly(id);
  else await clearAgentOnly(id);

  res.json({ message: `agent-only ${enabled ? "enabled" : "disabled"}`, caseId: id });
});

/* -------------------------------- Signup --------------------------------- */
app.post("/api/signup", async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const user = new User({ name, email, password: hashed, role });
    await user.save();
    res.json({ message: "Signup successful" });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(400).json({ error: "Signup failed" });
  }
});

/* --------------------------------- Login --------------------------------- */
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const start = Date.now();
    const user = await User.findOne(
      { email },
      "name email password role orders"
    ).lean();
    console.log(`User.findOne took ${Date.now() - start}ms`);
    if (!user) return res.status(400).json({ error: "Invalid email" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: "Invalid password" });

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const userData = { ...user };
    delete userData.password;

    await redisClient.set(`user:${user._id}`, JSON.stringify(userData), {
      EX: 3600,
    });
    await redisClient.del(`chat:${user._id}`); // backward-compat cleanup
    await redisClient.del(`selected-product:${user._id}`);

    res.json({ token, role: user.role });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

/* -------------------------------- Logout --------------------------------- */
app.post("/api/logout", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    await redisClient.del(`user:${userId}`);
    await redisClient.del(`chat:${userId}`); // backward-compat cleanup
    await redisClient.del(`selected-product:${userId}`);
    console.log(
      `User ${userId} session, chat history (legacy key), and selected product cleared`
    );
    res.json({ message: "Logout successful" });
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).json({ error: "Logout failed" });
  }
});

/* --------------------------------- Chat ---------------------------------- */
app.post("/api/chat", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { message } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    // user cache
    let userData = await redisClient.get(`user:${userId}`);
    if (!userData) {
      const user = await User.findById(userId, "name email role orders").lean();
      if (!user) return res.status(404).json({ error: "User not found" });
      const scrub = { ...user };
      delete scrub.password;
      userData = JSON.stringify(scrub);
      await redisClient.set(`user:${userId}`, userData, { EX: 3600 });
    }
    const userObj = JSON.parse(userData);

    // product context
    const selected = await redisClient.get(`selected-product:${userId}`);
    if (!selected) {
      return res.status(400).json({ error: "Select an order/product first" });
    }
    const selectedProduct = JSON.parse(selected);
    const { orderId, productIndex, domain } = selectedProduct;
    const chatKey = `chat:${userId}:${orderId}:${Number(productIndex)}`;
    const io = req.app.get("io");

    /* --------- Ensure case exists and apply AGENT-ONLY short-circuit --------- */
    let existingCase = await Case.findOne({ userId, orderId, productIndex }).lean();
    if (!existingCase) {
      // create minimal open case (first time user talks)
      existingCase = await new Case({
        userId, orderId, productIndex, description: message, priority: "low", domain, status: "open",
      }).save();
      existingCase = existingCase.toObject();
    }

    // If agent-only lock is ON, don't run FAQ/CaseMemory/Gemini
    if (await isAgentOnly(existingCase._id)) {
      await redisClient.rPush(
        chatKey,
        JSON.stringify({
          prompt: message,
          reply: null, // no automated reply
          orderId,
          productIndex,
          caseId: existingCase._id,
          timestamp: Date.now(),
          source: "user",
        })
      );
      await redisClient.expire(chatKey, 86400);

      // notify agents so they can reply from dashboard
      io.to("agents").emit("chat:user", {
        userId,
        orderId,
        productIndex,
        caseId: existingCase._id,
        message,
        timestamp: Date.now(),
      });

      return res.json({
        queued: true,
        routed: "human_agent",
        caseId: existingCase._id,
      });
    }
    /* ------------------------------------------------------------------------ */

    // refund path
    const REFUND_WORDS = [
      "refund",
      "money back",
      "chargeback",
      "return my money",
    ];
    const isRefund = REFUND_WORDS.some((w) =>
      message.toLowerCase().includes(w)
    );
    if (isRefund) {
      const { label } = analyzeSentiment(message);
      const sla = computeSLA({ priority: "high", sentiment: label });

      let csCase = await Case.findOne({ userId, orderId, productIndex });
      const description = `[Refund Request] ${message}`;
      const priority = "high";
      if (!csCase) {
        csCase = await new Case({
          userId,
          orderId,
          productIndex,
          description,
          priority,
          domain,
          status: "open",
        }).save();
      } else {
        csCase.description = description;
        csCase.priority = "high";
        csCase.domain = domain;
        csCase.status = "open";
        await csCase.save();
      }
      await indexCase(csCase);

      const reply =
        "Got it. This looks like a refund request — we’ve escalated it to our support team. We’ll take care of it.";
      await redisClient.rPush(
        chatKey,
        JSON.stringify({
          prompt: message,
          reply,
          orderId,
          productIndex,
          caseId: csCase._id,
          timestamp: Date.now(),
        })
      );
      await redisClient.expire(chatKey, 86400);

      // realtime to user
      io.to(`user:${userId}`).emit("chat:reply", {
        userId,
        orderId,
        productIndex,
        caseId: csCase._id,
        source: "refund",
        message: reply,
        timestamp: Date.now(),
      });

      // status broadcast
      io.to(`user:${userId}`).emit("case:status", {
        caseId: csCase._id,
        status: csCase.status, // open
      });

      // mirror to agents dashboards
      io.to("agents").emit("chat:reply", {
        userId,
        orderId,
        productIndex,
        caseId: csCase._id,
        source: "refund",
        message: reply,
        timestamp: Date.now(),
      });

      return res.json({
        reply,
        routed: "cs_agent",
        sla,
        caseId: csCase._id,
      });
    }

    // FAQ
    const faqHit = await checkFaq(message, domain);
    if (faqHit) {
      const reply = faqHit.answer;
      await redisClient.rPush(
        chatKey,
        JSON.stringify({
          prompt: message,
          reply,
          orderId,
          productIndex,
          caseId: null,
          timestamp: Date.now(),
          source: "faq",
          score: faqHit.score,
        })
      );
      await redisClient.expire(chatKey, 86400);

      io.to(`user:${userId}`).emit("chat:reply", {
        userId,
        orderId,
        productIndex,
        caseId: null,
        source: "faq",
        message: reply,
        timestamp: Date.now(),
      });

      // mirror to agents dashboards
      io.to("agents").emit("chat:reply", {
        userId,
        orderId,
        productIndex,
        caseId: null,
        source: "faq",
        message: reply,
        timestamp: Date.now(),
      });

      return res.json({ reply, source: "faq", score: faqHit.score });
    }

    // // CaseMemory
const K = Number(process.env.SIM_TOP_K ?? 3);
const CM_TH = Number(process.env.SIM_CASE_THRESHOLD ?? 0.72);
const similar = await searchSimilarCases(message, domain, K);
if (similar?.length && similar[0].score >= CM_TH) {
  const top = similar[0];

  // ✨ Clean + format the memory into a nice sentence
  const pretty = buildMemoryReply(top.summary, {
    orderId,
    productName: selectedProduct?.name,
    // missingQty: set if you track this (optional)
  });

  await redisClient.rPush(
    chatKey,
    JSON.stringify({
      prompt: message,
      reply: pretty,
      orderId,
      productIndex,
      caseId: top.caseId,
      timestamp: Date.now(),
      source: "case-memory",
      score: top.score,
    })
  );
  await redisClient.expire(chatKey, 86400);

  io.to(`user:${userId}`).emit("chat:reply", {
    userId,
    orderId,
    productIndex,
    caseId: top.caseId,
    source: "case-memory",
    message: pretty,
    timestamp: Date.now(),
  });

  // mirror to agents dashboards
  io.to("agents").emit("chat:reply", {
    userId,
    orderId,
    productIndex,
    caseId: top.caseId,
    source: "case-memory",
    message: pretty,
    timestamp: Date.now(),
  });

  return res.json({
    reply: pretty,
    source: "case-memory",
    score: top.score,
    similarCases: similar.map((s) => ({ caseId: s.caseId, score: s.score })),
  });
}


    // LLM
    const prompt = [
      `You are a customer-support assistant for ${domain}.`,
      `User: ${userObj.name} (${userObj.email})`,
      `Product: ${selectedProduct.name} x${selectedProduct.quantity} ₹${selectedProduct.price} ${selectedProduct.status}`,
      `Order: ${orderId}`,
      `Instruction:`,
      `- Give a concise helpful answer.`,
      `- If not resolvable without human help, politely say we’ll assign a specialist.`,
      `- Never ask for card or OTP.`,
      `User message: "${message}"`,
      `Return only plain text (no JSON).`,
    ].join("\n");

    let llmReply =
      "Thanks for the details. We’re routing this to a specialist.";
    try {
      llmReply = await callGemini(prompt);
    } catch (e) {
      console.warn("Gemini call failed, using default escalate text:", e?.message || e);
    }

    const { label } = analyzeSentiment(message + " " + llmReply);
    const priority = /payment|billing|charged|failed/i.test(message)
      ? "high"
      : "low";
    const sla = computeSLA({ priority, sentiment: label });

    let csCase = await Case.findOne({ userId, orderId, productIndex });
    if (!csCase) {
      csCase = await new Case({
        userId,
        orderId,
        productIndex,
        description: message,
        priority,
        domain,
        status: "open",
      }).save();
    } else {
      csCase.description = message;
      csCase.priority = priority;
      csCase.domain = domain;
      if (csCase.status === "resolved") csCase.status = "open";
      await csCase.save();
    }
    await indexCase(csCase);

    await redisClient.rPush(
      chatKey,
      JSON.stringify({
        prompt: message,
        reply: llmReply,
        orderId,
        productIndex,
        caseId: csCase._id,
        timestamp: Date.now(),
        source: "llm",
      })
    );
    await redisClient.expire(chatKey, 86400);

    io.to(`user:${userId}`).emit("chat:reply", {
      userId,
      orderId,
      productIndex,
      caseId: csCase._id,
      source: "llm",
      message: llmReply,
      timestamp: Date.now(),
    });

    // mirror to agents dashboards
    io.to("agents").emit("chat:reply", {
      userId,
      orderId,
      productIndex,
      caseId: csCase._id,
      source: "llm",
      message: llmReply,
      timestamp: Date.now(),
    });

    // status broadcast on creation
    io.to(`user:${userId}`).emit("case:status", {
      caseId: csCase._id,
      status: csCase.status, // open
    });

    return res.json({
      reply: llmReply,
      routed: "cs_agent",
      sla,
      caseId: csCase._id,
    });
  } catch (err) {
    console.error("Chat error:", err);
    return res.status(500).json({ error: "Failed to process chat" });
  }
});

/* ----------------------- Chat history (per-product) ---------------------- */
app.get("/api/chat/history", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { orderId, productIndex } = req.query;

    async function readList(key) {
      const raw = await redisClient.lRange(key, 0, -1);
      return raw
        .map((r) => {
          try {
            return JSON.parse(r);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }

    if (orderId && productIndex !== undefined) {
      const key = `chat:${userId}:${orderId}:${Number(productIndex)}`;
      const chats = await readList(key);
      return res.json({ chats });
    }

    let cursor = 0;
    const chats = [];
    do {
      const resScan = await redisClient.scan(cursor, {
        MATCH: `chat:${userId}:*`,
        COUNT: 100,
      });
      cursor = Number(resScan.cursor ?? resScan[0]);
      const keys = resScan.keys ?? resScan[1] ?? [];
      for (const k of keys) {
        const items = await readList(k);
        chats.push(...items);
      }
    } while (cursor !== 0);

    chats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    res.json({ chats });
  } catch (err) {
    console.error("Chat history error:", err?.message || err);
    res.status(500).json({ error: "Failed to fetch chat history" });
  }
});

/* ---------------------- Show thread & user actions ----------------------- */
// Full thread for a case (Mongo-only)
app.get("/api/case/:id/thread", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const doc = await Case.findById(id).lean();
  if (!doc) return res.status(404).json({ error: "Case not found" });
  if (String(doc.userId) !== String(req.userId) && req.userRole !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  const thread = (doc.responses || []).map((r) => ({
    sender: r.adminId ? "agent" : "user/bot",
    message: r.message,
    timestamp: r.timestamp || doc.updatedAt || doc.createdAt,
  }));
  res.json({
    case: {
      _id: doc._id,
      orderId: doc.orderId,
      productIndex: doc.productIndex,
      domain: doc.domain,
      status: doc.status,
      priority: doc.priority,
    },
    thread,
  });
});

// Unified thread: merges Redis chat + agent messages for a product (user view)
app.get("/api/chat/thread", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { orderId, productIndex } = req.query;
    if (!orderId || productIndex === undefined) {
      return res.status(400).json({ error: "orderId and productIndex are required" });
    }

    const chatKey = `chat:${userId}:${orderId}:${Number(productIndex)}`;
    const raw = await redisClient.lRange(chatKey, 0, -1);
    const redisTurns = raw
      .map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean)
      .map((t) => ({
        source: t.source || "bot",
        sender: t.source === "agent" ? "agent" : "bot",
        message: t.reply,
        prompt: t.prompt,
        timestamp: t.timestamp || Date.now(),
        caseId: t.caseId || null,
      }));

    const caseDoc = await Case.findOne({ userId, orderId, productIndex }).lean();
    const agentMsgs = (caseDoc?.responses || []).map((r) => ({
      source: "agent",
      sender: "agent",
      message: r.message,
      timestamp: r.timestamp || caseDoc?.updatedAt || caseDoc?.createdAt || Date.now(),
      caseId: caseDoc?._id || null,
    }));

    const combined = [...redisTurns, ...agentMsgs].sort(
      (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
    );

    return res.json({
      case: caseDoc
        ? {
            _id: caseDoc._id,
            status: caseDoc.status,
            priority: caseDoc.priority,
            domain: caseDoc.domain,
          }
        : null,
      thread: combined,
    });
  } catch (err) {
    console.error("Unified thread error:", err);
    res.status(500).json({ error: "Failed to fetch thread" });
  }
});

/* ------------------- Admin unified thread by caseId ------------------ */
app.get("/api/admin/case/:id/unified-thread", authMiddleware, async (req, res) => {
  if (req.userRole !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  try {
    const { id } = req.params;
    const doc = await Case.findById(id).lean();
    if (!doc) return res.status(404).json({ error: "Case not found" });

    const userId = String(doc.userId);
    const { orderId, productIndex } = doc;
    const chatKey = `chat:${userId}:${orderId}:${Number(productIndex)}`;

    const raw = await redisClient.lRange(chatKey, 0, -1);
    const redisTurns = raw
      .map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean)
      .map((t) => ({
        source: t.source || "bot",
        sender: t.source === "agent" ? "agent" : "bot",
        message: t.reply,
        prompt: t.prompt,
        timestamp: t.timestamp || Date.now(),
        caseId: t.caseId || null,
      }));

    const agentMsgs = (doc.responses || []).map((r) => ({
      source: "agent",
      sender: "agent",
      message: r.message,
      timestamp: r.timestamp || doc.updatedAt || doc.createdAt || Date.now(),
      caseId: doc._id || null,
    }));

    const combined = [...redisTurns, ...agentMsgs].sort(
      (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
    );

    return res.json({
      case: {
        _id: doc._id,
        userId,
        orderId,
        productIndex,
        status: doc.status,
        priority: doc.priority,
        domain: doc.domain,
      },
      thread: combined,
    });
  } catch (err) {
    console.error("Admin unified thread error:", err);
    return res.status(500).json({ error: "Failed to fetch unified thread" });
  }
});

/* ------------------------------ MongoDB ---------------------------------- */
const start = Date.now();
mongoose.set("debug", true);
mongoose
  .connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 10,
    minPoolSize: 2,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 45000,
  })
  .then(async () => {
    console.log(`✅ MongoDB Connected in ${Date.now() - start}ms`);
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

/* -------------------------- Start with Socket.IO ------------------------- */
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin:
      process.env.CORS_ORIGIN?.split(",") || [
        "http://localhost:5173",
        "http://localhost:3000",
      ],
    credentials: true,
  },
});

// Socket auth (client connects with auth: { token })
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error("socket auth: no token"));
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.data.userId = payload.id;
    socket.data.role = payload.role;
    return next();
  } catch (e) {
    return next(new Error("socket auth failed"));
  }
});

io.on("connection", (socket) => {
  const { userId, role } = socket.data;
  socket.join(`user:${userId}`);
  if (role === "admin") socket.join("agents");
  socket.on("join_case", ({ caseId }) => caseId && socket.join(`case:${caseId}`));
  socket.on("leave_case", ({ caseId }) => caseId && socket.leave(`case:${caseId}`));
});

// Make io available inside routes
app.set("io", io);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
