import express from "express";
import cors from "cors";
import "dotenv/config";

import { connectToMongoDB, getDb } from "./db.js";

import uploadRoutes from "./routes/upload.js";
import serviceRoutes from "./routes/services.js";
import appointmentRoutes, { ensureAppointmentIndexes } from "./routes/appointments.js";
import adminRoutes from "./routes/admin.js";
import profileRoutes from "./routes/profile.js";

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

const app = express();

const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

// --------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------

app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  }),
);

// --------------------------------------------------
// ROOT ROUTE
// --------------------------------------------------

app.get("/", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Salon Book server is running!",
  });
});

// --------------------------------------------------
// SERVER STARTUP
// --------------------------------------------------

async function startServer() {
  try {
    // Connect to MongoDB
    await connectToMongoDB();
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    console.error("Starting the server without a database connection.");
  }

  // --------------------------------------------------
  // BETTER AUTH
  // --------------------------------------------------
  // Mount Better Auth before express.json()
  // because Better Auth handles its own request body parsing.

  if (getDb()) {
    const { getAuth } = await import("./auth.js");
    const { toNodeHandler } = await import("better-auth/node");

    const auth = getAuth();

    app.all("/api/auth/*splat", toNodeHandler(auth));

    // Upload routes
    app.use("/api/upload", uploadRoutes);

    console.log("Better Auth mounted at /api/auth/*");
  } else {
    console.warn("Better Auth is NOT mounted (no database connection).");
  }

  // --------------------------------------------------
  // JSON MIDDLEWARE
  // --------------------------------------------------

  app.use(express.json());

  // --------------------------------------------------
  // SERVICE + APPOINTMENT ROUTES + admin routes
  // --------------------------------------------------
  // GET /api/services/
  // GET /api/services/categories

  app.use("/api/services", serviceRoutes);
  app.use("/api/appointments", appointmentRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/profile", profileRoutes);

  if (getDb()) {
    try {
      await ensureAppointmentIndexes();
    } catch (error) {
      console.error("Appointment index setup failed:", error.message);
    }
  }

  // --------------------------------------------------
  // START SERVER
  // --------------------------------------------------

  app.listen(PORT, () => {
    console.log(`Salon Book server is running at http://localhost:${PORT}`);
  });
}

startServer();

export default app;
