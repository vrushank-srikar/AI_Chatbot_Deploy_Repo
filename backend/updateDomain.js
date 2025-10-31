import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

// --- User Schema (copied from server.js) ---
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

// --- Case Schema (copied from server.js) ---
const caseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  orderId: { type: String, required: true },
  productIndex: { type: Number, required: true },
  description: { type: String, required: true },
  domain: { 
    type: String, 
    enum: ["E-commerce", "Travel", "Telecommunications", "Banking Services"],
    required: true 
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

async function updateExistingDomains() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const casesWithoutDomain = await Case.find({ domain: { $exists: false } });
  console.log(`Found ${casesWithoutDomain.length} cases without domain`);

  for (const c of casesWithoutDomain) {
    // Fetch user and product domain
    const user = await User.findById(c.userId).select("orders");
    if (user) {
      const order = user.orders.find(o => o.orderId === c.orderId);
      if (order && order.products[c.productIndex]) {
        c.domain = order.products[c.productIndex].domain || "E-commerce";
        await c.save();
        console.log(`Updated case ${c._id}: domain = ${c.domain}`);
      } else {
        console.warn(`No matching order/product for case ${c._id}; defaulting to E-commerce`);
        c.domain = "E-commerce";
        await c.save();
      }
    } else {
      console.warn(`No user found for case ${c._id}; defaulting to E-commerce`);
      c.domain = "E-commerce";
      await c.save();
    }
  }

  console.log("Update complete");
  await mongoose.connection.close();
}

updateExistingDomains().catch(console.error);