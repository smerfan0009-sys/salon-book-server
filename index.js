import express from "express";
import cors from "cors";
import "dotenv/config";
import { connectToMongoDB, getDb } from "./db.js";
import uploadRoutes from "./routes/upload.js";
import serviceRoutes from "./routes/services.js";

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

const app = express();
const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  })
);

// --------------------------------------------------
// ROUTES
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Salon Book server is running!",
  });
});

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

  // Mount Better Auth only when the database is available.
  // Mounted before express.json() because Better Auth parses its own body.
  if (getDb()) {
    const { getAuth } = await import("./auth.js");
    const { toNodeHandler } = await import("better-auth/node");
    const auth = getAuth();
    app.all("/api/auth/*splat", toNodeHandler(auth));
    app.use("/api/upload", uploadRoutes);
    console.log("Better Auth mounted at /api/auth/*");
  } else {
    console.warn("Better Auth is NOT mounted (no database connection).");
  }

  app.use(express.json());

  // Public service routes (the route returns 503 if MongoDB is unavailable).
  app.use("/api/services", serviceRoutes);

  app.listen(PORT, () => {
    console.log(`Salon Book server is running at http://localhost:${PORT}`);
  });
}

startServer();

export default app;
