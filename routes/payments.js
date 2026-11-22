import { Router } from "express";
import { ObjectId } from "mongodb";
import Stripe from "stripe";
import { getDb } from "../db.js";
import { requireAuth, requireCustomer } from "../middleware/requireAuth.js";

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-12-18.acacia",
});
const CLIENT_URL = (process.env.CLIENT_URL || "http://localhost:3000")
  .trim()
  .replace(/\/+$/, "");

function badRequest(res, message) {
  return res.status(400).json({ success: false, message });
}

function getAppointmentId(value) {
  return typeof value === "string" && /^[a-f\d]{24}$/i.test(value)
    ? new ObjectId(value)
    : null;
}

// --------------------------------------------------
// SHARED HELPERS (used by the webhook AND the verify route)
// --------------------------------------------------

// Saves one transaction record per Stripe session. Safe to call many times:
// the unique index on stripeSessionId turns duplicates into a no-op.
async function recordTransaction(db, session, status) {
  const appointmentId = getAppointmentId(session.metadata?.appointmentId);
  if (!appointmentId) return;

  const appointment = await db
    .collection("appointments")
    .findOne({ _id: appointmentId }, { projection: { customerId: 1 } });

  const now = new Date();

  try {
    await db.collection("transactions").insertOne({
      appointmentId,
      customerId: appointment?.customerId ?? "",
      amount: (session.amount_total ?? 0) / 100,
      currency: session.currency || "usd",
      stripeSessionId: session.id,
      transactionId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.id,
      paymentMethod: "card",
      status,
      paymentStatus: status,
      transactionDate: now,
      createdAt: now,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    // Duplicate session: already recorded, ignore.
  }
}

// Marks the appointment as Paid + records the transaction.
// Idempotent: running it twice changes nothing the second time.
async function fulfillPaidSession(db, session) {
  const appointmentId = getAppointmentId(session.metadata?.appointmentId);

  if (!appointmentId || session.payment_status !== "paid") return false;

  await recordTransaction(db, session, "paid");

  await db.collection("appointments").updateOne(
    { _id: appointmentId, paymentStatus: { $ne: "Paid" } },
    {
      $set: {
        paymentStatus: "Paid",
        paidAt: new Date(),
        updatedAt: new Date(),
      },
    },
  );

  return true;
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
      success_url: `${CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CLIENT_URL}/payment/cancel`,
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
// STRIPE WEBHOOK HANDLER
// Mounted in index.js as POST /api/payments/webhook with express.raw(),
// BEFORE express.json(), so the signature can be verified.
// --------------------------------------------------

export async function handleStripeWebhook(req, res) {
  const signature = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!endpointSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set in .env");
    return res.status(500).json({
      success: false,
      message: "Webhook secret is not configured.",
    });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, endpointSecret);
  } catch (error) {
    console.error("Webhook signature verification failed:", error.message);
    return res
      .status(400)
      .json({ success: false, message: "Invalid signature." });
  }

  console.log(`Stripe webhook received: ${event.type} (${event.id})`);

  const db = getDb();
  if (!db) {
    return res.status(503).json({
      success: false,
      message: "Database is not connected.",
    });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object;
        const done = await fulfillPaidSession(db, session);
        console.log(
          done
            ? `Appointment ${session.metadata?.appointmentId} marked as Paid.`
            : `Session ${session.id} is not paid yet (payment_status: ${session.payment_status}).`,
        );
        break;
      }

      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        await recordTransaction(db, event.data.object, "failed");
        break;
      }

      default:
        // Ignore other event types.
        break;
    }

    return res.json({ received: true });
  } catch (error) {
    console.error("Webhook handling error:", error);
    // 500 makes Stripe retry the webhook later.
    return res.status(500).json({
      success: false,
      message: "Webhook handler failed.",
    });
  }
}

// --------------------------------------------------
// GET /api/payments/session/:sessionId
// Called by the payment success page. Verifies the session directly with
// Stripe and marks the appointment Paid if it was paid, so payments still
// work even when the webhook is not running (e.g. local development).
// --------------------------------------------------

router.get(
  "/session/:sessionId",
  requireAuth,
  requireCustomer,
  async (req, res) => {
    try {
      const db = getDb();
      if (!db) {
        return res.status(503).json({
          success: false,
          message: "Database is not connected.",
        });
      }

      const session = await stripe.checkout.sessions.retrieve(
        req.params.sessionId,
      );

      const appointmentId = getAppointmentId(session.metadata?.appointmentId);

      let appointmentPaymentStatus = null;

      if (appointmentId) {
        // Only the owner of the appointment can verify / fulfil it.
        const appointment = await db
          .collection("appointments")
          .findOne({ _id: appointmentId, customerId: req.user.id });

        if (appointment) {
          if (
            session.payment_status === "paid" &&
            appointment.paymentStatus !== "Paid"
          ) {
            await fulfillPaidSession(db, session);
            appointmentPaymentStatus = "Paid";
          } else {
            appointmentPaymentStatus = appointment.paymentStatus;
          }
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
      if (error?.code === "resource_missing") {
        return res.status(404).json({
          success: false,
          message: "Payment session not found.",
        });
      }

      console.error("Session verify error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to verify payment session.",
      });
    }
  },
);

// --------------------------------------------------
// Indexes
// --------------------------------------------------

export async function ensurePaymentIndexes() {
  const db = getDb();
  if (!db) return;

  await db.collection("transactions").createIndex(
    { stripeSessionId: 1 },
    {
      name: "unique_stripe_session",
      unique: true,
      partialFilterExpression: { stripeSessionId: { $type: "string" } },
    },
  );
}

export default router;
