// sla.js
export function computeSLA({ priority = "low", sentiment = "neutral" }) {
  const FAST = Number(process.env.SLA_FAST_MIN ?? 15);   // minutes
  const STD  = Number(process.env.SLA_STD_MIN  ?? 60);
  const SLOW = Number(process.env.SLA_SLOW_MIN ?? 180);

  if (sentiment === "angry") return { level: "express",  targetMinutes: FAST };
  if (priority === "high")   return { level: "express",  targetMinutes: FAST };
  if (sentiment === "cool")  return { level: "batched",  targetMinutes: SLOW };
  return { level: "standard", targetMinutes: STD };
}
