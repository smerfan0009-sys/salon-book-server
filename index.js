import express from "express";
import cors from "cors";
import "dotenv/config";

import { connectToMongoDB, getDb } from "./db.js";

import uploadRoutes from "./routes/upload.js";
import serviceRoutes from "./routes/services.js";
import appointmentRoutes, {
  ensureAppointmentIndexes,
} from "./routes/appointments.js";
import adminRoutes from "./routes/admin.js";
import profileRoutes from "./routes/profile.js";
import paymentRoutes, {
  handleStripeWebhook,
  ensurePaymentIndexes,
} from "./routes/payments.js";

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

const app = express();

const PORT = process.env.PORT || 5000;
const CLIENT_URL = (process.env.CLIENT_URL || "http://localhost:3000")
  .trim()
  .replace(/\/+$/, "");
const CORS_ORIGINS = [CLIENT_URL, "http://localhost:3000"];

// Vercel and the Next.js rewrite proxy forward the original request details.
app.set("trust proxy", 1);

// --------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------

app.use(
  cors({
    origin: CORS_ORIGINS,
    credentials: true,
  }),
);

// --------------------------------------------------
// WAIT FOR STARTUP (needed on Vercel)
// --------------------------------------------------
// Routes are mounted inside the async startServer() below. On Vercel a
// request can arrive before that finishes (cold start), so every request
// waits here until startup is done. `ready` is assigned at the bottom.

app.use(async (req, res, next) => {
  try {
    await ready;
    next();
  } catch (error) {
    next(error);
  }
});

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
  // STRIPE WEBHOOK (raw body for signature verification)
  // Must be mounted BEFORE express.json().
  // --------------------------------------------------

  app.post(
    "/api/payments/webhook",
    express.raw({ type: "application/json" }),
    handleStripeWebhook,
  );

  // --------------------------------------------------
  // JSON MIDDLEWARE
  // --------------------------------------------------

  app.use(express.json());

  // --------------------------------------------------
  // SERVICE + APPOINTMENT ROUTES + admin routes
  // --------------------------------------------------

  app.use("/api/services", serviceRoutes);
  app.use("/api/appointments", appointmentRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/profile", profileRoutes);

  if (getDb()) {
    try {
      await ensureAppointmentIndexes();
      await ensurePaymentIndexes();
    } catch (error) {
      console.error("Index setup failed:", error.message);
    }
  }

  // --------------------------------------------------
  // START SERVER (local only; Vercel runs the exported app itself)
  // --------------------------------------------------

  if (!process.env.VERCEL) {
    app.listen(PORT, () => {
      console.log(`Salon Book server is running at http://localhost:${PORT}`);
    });
  }
}

const ready = startServer();

// Log startup failures without crashing; requests still get an error via the
// middleware above.
ready.catch((error) => {
  console.error("Server startup failed:", error);
});

export default app;
