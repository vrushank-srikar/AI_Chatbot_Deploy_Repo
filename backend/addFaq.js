import axios from "axios";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

// Validate environment variables
const requiredEnv = ["MONGO_URI", "GEMINI_API_KEY"];
requiredEnv.forEach((key) => {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
});

// --- FAQ Model ---
const faqSchema = new mongoose.Schema({
  question: String,
  answer: String,
  domain: String,
  embedding: [Number],
});

// Use existing model if already compiled
const Faq = mongoose.models.Faq || mongoose.model("Faq", faqSchema);

// --- Get embedding from Gemini ---
async function getEmbedding(text) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${process.env.GEMINI_API_KEY}`,
      { content: { parts: [{ text }] } },
      { headers: { "Content-Type": "application/json" } }
    );
    return response.data.embedding.values;
  } catch (err) {
    console.error("Embedding error:", err.message);
    throw new Error("Failed to get embedding");
  }
}

// --- FAQ Collections ---
const ecommerceFaqs = [
  { 
    question: "When will my order be delivered?", 
    answer: "Your order is typically delivered within 3-5 business days, depending on your location and the availability of the product. You can track your order status in the 'Your Ordered Products' section.", 
    domain: "E-commerce"
  },
  { 
    question: "How do I return an item?", 
    answer: "You can initiate a return within 30 days of receiving your item by submitting a request through our support system. Ensure the item is unused and in its original packaging.", 
    domain: "E-commerce"
  },
  { 
    question: "Can I cancel my order?", 
    answer: "Orders can be canceled before they are shipped. Contact support through the dashboard to verify if your order is eligible for cancellation.", 
    domain: "E-commerce"
  },
  { 
    question: "How do I track my order status?", 
    answer: "Check the status of your order in the 'Your Ordered Products' section of your dashboard or reach out to support for real-time updates.", 
    domain: "E-commerce"
  }
];

const travelFaqs = [
  { 
    question: "How can I change my travel booking?", 
    answer: "You can modify your booking by contacting support through the dashboard. Changes are subject to availability and may incur additional fees.", 
    domain: "Travel"
  },
  { 
    question: "What is the refund policy for cancellations?", 
    answer: "Refunds for canceled bookings depend on the terms of your ticket or package. Initiate a cancellation request via the support system to check eligibility.", 
    domain: "Travel"
  },
  { 
    question: "How do I check my flight or hotel booking status?", 
    answer: "View your booking details in the 'Travel Products' section of your dashboard or contact support for the latest updates.", 
    domain: "Travel"
  },
  { 
    question: "What should I do if my flight is delayed or canceled?", 
    answer: "If your flight is delayed or canceled, reach out to support immediately to explore rebooking options or compensation, if applicable.", 
    domain: "Travel"
  }
];

const telecommunicationsFaqs = [
  { 
    question: "How do I check my mobile plan details?", 
    answer: "You can view your plan details, including data usage and billing, in the 'Telecommunications Products' section of your dashboard.", 
    domain: "Telecommunications"
  },
  { 
    question: "How can I report a service issue?", 
    answer: "Report service issues like connectivity problems by creating a support case through the dashboard. Provide detailed information for faster resolution.", 
    domain: "Telecommunications"
  },
  { 
    question: "Can I change or cancel my subscription plan?", 
    answer: "You can request to change or cancel your plan by contacting support. Some plans may have specific terms for modifications or cancellations.", 
    domain: "Telecommunications"
  },
  { 
    question: "How do I resolve billing disputes?", 
    answer: "If you notice an error in your bill, initiate a support case in the dashboard with details of the issue, and our team will investigate promptly.", 
    domain: "Telecommunications"
  }
];

const bankingServicesFaqs = [
  { 
    question: "How do I check my account balance or transactions?", 
    answer: "Access your account balance and transaction history in the 'Banking Services Products' section of your dashboard.", 
    domain: "Banking Services"
  },
  { 
    question: "What should I do if I suspect unauthorized activity on my account?", 
    answer: "Immediately report unauthorized activity by creating a high-priority support case through the dashboard for quick resolution.", 
    domain: "Banking Services"
  },
  { 
    question: "How can I update my account details?", 
    answer: "To update details like your address or contact information, submit a request via the support system in the dashboard.", 
    domain: "Banking Services"
  },
  { 
    question: "How do I request a refund for a disputed transaction?", 
    answer: "Initiate a support case with details of the disputed transaction, and our team will review it and process any applicable refunds.", 
    domain: "Banking Services"
  }
];

// --- Initialize FAQs ---
async function initFaqs() {
  const faqCollections = [
    { name: "E-commerce", faqs: ecommerceFaqs },
    { name: "Travel", faqs: travelFaqs },
    { name: "Telecommunications", faqs: telecommunicationsFaqs },
    { name: "Banking Services", faqs: bankingServicesFaqs }
  ];

  for (const collection of faqCollections) {
    for (const faq of collection.faqs) {
      const existing = await Faq.findOne({ question: faq.question, domain: faq.domain });
      if (!existing) {
        const embedding = await getEmbedding(faq.question);
        await new Faq({ ...faq, embedding }).save();
        console.log(`Added FAQ: ${faq.question} for domain: ${faq.domain}`);
      }
    }
  }
}

// --- Main execution ---
async function main() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10,
      minPoolSize: 2,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log("✅ Connected to MongoDB");

    // Initialize FAQs
    await initFaqs();
    console.log("✅ FAQs initialized successfully");

    // Close MongoDB connection
    await mongoose.connection.close();
    console.log("✅ MongoDB connection closed");
    process.exit(0);
  } catch (err) {
    console.error("Error during FAQ initialization:", {
      message: err.message,
      name: err.name,
      code: err.code,
      stack: err.stack,
    });
    process.exit(1);
  }
}

// Run the script
main();