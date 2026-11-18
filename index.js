import express from "express";
import "dotenv/config";

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

const app = express();
const PORT = process.env.PORT || 5000;

// --------------------------------------------------
// MONGODB CONNECTION
// --------------------------------------------------

let db = null;

async function connectToMongoDB() {
  const { MONGODB_URI, DB_USER, DB_PASSWORD } = process.env;

  if (!MONGODB_URI && (!DB_USER || !DB_PASSWORD)) {
    console.warn("MongoDB is not configured. Skipping database connection.");
    return null;
  }

  const uri =
    MONGODB_URI ||
    `mongodb+srv://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@cluster0.cdjo897.mongodb.net/salon-book`;

  const client = new MongoClient(uri);
  await client.connect();

  db = client.db("salon-book");
  console.log("Connected to MongoDB (salon-book)");

  return db;
}

// --------------------------------------------------
// SERVER STARTUP
// --------------------------------------------------

async function startServer() {
  try {
    await connectToMongoDB();
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    console.error("Starting the server without a database connection.");
  }

  app.listen(PORT, () => {
    console.log(`Salon Book server is running at http://localhost:${PORT}`);
  });
}

startServer();

export default app;
