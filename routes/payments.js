import { Router } from "express";
import { ObjectId } from "mongodb";
import Stripe from "stripe";
import { getDb } from "../db.js";
import {
  requireAuth,
  requireCustomer,
} from "../middleware/requireAuth.js";

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-12-18.acacia",
});

function badRequest(res, message) {
  return res.status(400).json({ success: false, message });
}

function getAppointmentId(value) {
  return typeof value === "string" && /^[a-f\d]{24}$/i.test(value)
    ? new ObjectId(value)
    : null;
}

// --------------------------------------------------
// POST /api/payments/checkout (auth + customer)
// --------------------------------------------------

router.post("/checkout", requireAuth, requireCustomer, async (req, res) => {
  try {
    const { appointmentId } = req.body ?? {};

    const parsedAppointmentId = getAppointmentId(appointmentId);
    if (!parsedAppointmentId) {
      return badRequest(res, "A valid appointment ID is required.");
    }

    const db = getDb();
    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected.",
      });
    }

    const appointment = await db
      .collection("appointments")
      .findOne({ _id: parsedAppointmentId, customerId: req.user.id });

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found.",
      });
    }

    if (appointment.status !== "Confirmed") {
      return res.status(409).json({
        success: false,
        message: "Only confirmed appointments can be paid.",
      });
    }

    if (appointment.paymentStatus !== "Unpaid") {
      return res.status(409).json({
        success: false,
        message: "This appointment has already been paid.",
      });
    }

    let price = appointment.servicePrice;
    if (!price) {
      const service = await db
        .collection("services")
        .findOne({ _id: appointment.serviceId }, { projection: { price: 1 } });
      price = service ? service.price : 0;
    }

    const unitAmount = Math.round(Number(price) * 100);
    if (!Number.isFinite(unitAmount) || unitAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "This appointment has no valid price.",
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: appointment.serviceName || "Salon Service",
            },
            unit_amount: unitAmount,
          },
          quantity: 1,
        },
      ],
      metadata: {
        appointmentId: String(appointment._id),
      },
      success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
    });

    return res.status(200).json({
      success: true,
      data: { url: session.url },
    });
  } catch (error) {
    console.error("Checkout error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error while creating checkout session.",
    });
  }
});

// --------------------------------------------------
// POST /api/payments/webhook (no auth, signature verified)
// --------------------------------------------------

router.post("/", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = Stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (error) {
    console.error("Webhook signature verification failed:", error.message);
    return res.status(400).json({ success: false, message: "Invalid signature." });
  }

  const db = getDb();
  if (!db) {
    return res.status(503).json({
      success: false,
      message: "Database is not connected.",
    });
  }

  const session = event.data.object;
  const sessionId = session.id;
  const appointmentIdStr = session.metadata?.appointmentId;
  const parsedAppointmentId = appointmentIdStr ? getAppointmentId(appointmentIdStr) : null;

  // Resolve customerId from the appointment record.
  let customerId = "";
  if (parsedAppointmentId) {
    const appointment = await db
      .collection("appointments")
      .findOne({ _id: parsedAppointmentId }, { projection: { customerId: 1 } });
    if (appointment) {
      customerId = appointment.customerId;
    }
  }

  async function insertTransaction(status, amount, currency) {
    if (!parsedAppointmentId) return;
    try {
      await db.collection("transactions").insertOne({
        appointmentId: parsedAppointmentId,
        customerId,
        amount,
        currency: currency || "usd",
        stripeSessionId: sessionId,
        status,
        createdAt: new Date(),
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      // Idempotent: duplicate session, ignore.
    }
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        if (session.payment_status === "paid") {
          await insertTransaction(
            "paid",
            session.amount_total / 100,
            session.currency,
          );
          if (parsedAppointmentId) {
            await db
              .collection("appointments")
              .updateOne(
                { _id: parsedAppointmentId },
                {
                  $set: {
                    paymentStatus: "Paid",
                    updatedAt: new Date(),
                  },
                },
              );
          }
        }
        break;

      case "checkout.session.async_payment_failed":
      case "checkout.session.expired":
        await insertTransaction("failed", session.amount_total / 100, session.currency);
        break;

      default:
        // Ignore other event types.
        break;
    }

    return res.json({ received: true });
  } catch (error) {
    console.error("Webhook handling error:", error);
    return res.status(500).json({
      success: false,
      message: "Webhook handler failed.",
    });
  }
});

// --------------------------------------------------
// GET /api/payments/session/:sessionId (read-only verification)
// --------------------------------------------------

router.get("/session/:sessionId", requireAuth, requireCustomer, async (req, res) => {
  try {
    const db = getDb();
    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected.",
      });
    }

    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    const appointmentIdStr = session.metadata?.appointmentId;
    const parsedAppointmentId = appointmentIdStr ? getAppointmentId(appointmentIdStr) : null;

    let appointmentPaymentStatus = null;
    if (parsedAppointmentId) {
      const appointment = await db
        .collection("appointments")
        .findOne({ _id: parsedAppointmentId, customerId: req.user.id });
      if (appointment) {
        appointmentPaymentStatus = appointment.paymentStatus;
      }
    }

    return res.json({
      success: true,
      data: {
        paymentStatus: session.payment_status,
        appointmentPaymentStatus,
      },
    });
  } catch (error) {
    console.error("Session verify error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to verify payment session.",
    });
  }
});

// --------------------------------------------------
// Indexes
// --------------------------------------------------

export async function ensurePaymentIndexes() {
  const db = getDb();
  if (!db) return;

  await db.collection("transactions").createIndex(
    { stripeSessionId: 1 },
    { name: "unique_stripe_session", unique: true },
  );
}

export default router;
