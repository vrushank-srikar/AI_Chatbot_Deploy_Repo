import { createClient } from "redis";

const redisClient = createClient({
  url: "redis://localhost:6379",
});

redisClient.on("error", (err) => console.error("Redis Error:", err));

await redisClient.connect();

// List all keys
const keys = await redisClient.keys("*");
console.log("All keys in Redis:", keys);

for (let key of keys) {
  const type = await redisClient.type(key);
  if (type === "string") {
    const value = await redisClient.get(key);
    console.log(key, "=>", value);
  } else if (type === "list") {
    const values = await redisClient.lRange(key, 0, -1);
    console.log(key, "=>", values);
  } else {
    console.log(key, "=> (type)", type);
  }
}

await redisClient.quit();
