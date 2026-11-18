import { MongoClient } from "mongodb";
import "dotenv/config";

// --------------------------------------------------
// SHARED MONGODB CONNECTION (single connection, reused)
// --------------------------------------------------

// NOTE: This is the existing connection logic, moved into a shared module
// so Better Auth can reuse the same client/db. Behavior is unchanged:
// same URI resolution, same database name ("salon-book").

let client = null;
let db = null;
let connecting = null;

export async function connectToMongoDB() {
  if (db) {
    return { client, db };
  }

  if (connecting) {
    return connecting;
  }

  connecting = (async () => {
    const { MONGODB_URI, DB_USER, DB_PASSWORD } = process.env;

    if (!MONGODB_URI && (!DB_USER || !DB_PASSWORD)) {
      console.warn("MongoDB is not configured. Skipping database connection.");
      return null;
    }

    const uri =
      MONGODB_URI ||
      `mongodb+srv://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@cluster0.cdjo897.mongodb.net/salon-book`;

    client = new MongoClient(uri);
    await client.connect();

    db = client.db("salon-book");
    console.log("Connected to MongoDB (salon-book)");

    return { client, db };
  })();

  return connecting;
}

export function getDb() {
  return db;
}

export function getClient() {
  return client;
}
