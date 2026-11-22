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

// Stores one transaction per Stripe Checkout session. The unique session index
// and upsert make retries idempotent while allowing a later verified success
// event to replace an earlier failed/pending state for the same session.
async function recordTransaction(db, session, appointment, status) {
  const appointmentId = appointment._id;
  const now = new Date();
  try {
    await db.collection("transactions").updateOne(
      { stripeSessionId: session.id },
      {
        $set: {
          appointmentId,
          customerId: appointment.customerId,
          amount: (session.amount_total ?? 0) / 100,
          currency: session.currency || "usd",
          transactionId:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : session.id,
          paymentMethod: "card",
          status,
          paymentStatus: status,
          transactionDate: now,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  } catch (error) {
    // Concurrent delivery can race an upsert against the unique session
    // index. The other verified delivery already owns the record.
    if (error?.code !== 11000) throw error;
  }
}

async function getVerifiedAppointment(db, session) {
  const appointmentId = getAppointmentId(session.metadata?.appointmentId);
  const expectedCustomerId = session.metadata?.customerId;
  if (!appointmentId || typeof expectedCustomerId !== "string") return null;

  const appointment = await db.collection("appointments").findOne({
    _id: appointmentId,
    customerId: expectedCustomerId,
  });
  return appointment ?? null;
}

// Marks the appointment as Paid only after a verified webhook event. The
// filter protects the transition against concurrent events and stale sessions.
async function fulfillPaidSession(db, session) {
  if (session.payment_status !== "paid") return false;

  const appointment = await getVerifiedAppointment(db, session);
  if (!appointment || appointment.status !== "Confirmed") return false;

  if (
    appointment.paymentStatus === "Paid" &&
    appointment.stripeSessionId === session.id
  ) {
    await recordTransaction(db, session, appointment, "paid");
    return true;
  }
  if (appointment.paymentStatus === "Paid") return false;

  const now = new Date();
  const updated = await db.collection("appointments").findOneAndUpdate(
    {
      _id: appointment._id,
      customerId: appointment.customerId,
      status: "Confirmed",
      paymentStatus: "Unpaid",
    },
    {
      $set: {
        paymentStatus: "Paid",
        stripeSessionId: session.id,
        paidAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  if (!updated) return false;

  await recordTransaction(db, session, updated, "paid");
  return true;
}

async function recordFailedSession(db, session) {
  const appointment = await getVerifiedAppointment(db, session);
  if (!appointment || appointment.paymentStatus === "Paid") return false;
  await recordTransaction(db, session, appointment, "failed");
  return true;
}

export function verifyStripeWebhookEvent(payload, signature, endpointSecret) {
  return stripe.webhooks.constructEvent(payload, signature, endpointSecret);
}

/*
 * Checkout sessions are created from server-owned appointment data. Metadata
 * repeats the trusted owner ID so webhook and status reads can validate the
 * relationship without trusting any browser input.
 */

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
        customerId: req.user.id,
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
    event = verifyStripeWebhookEvent(req.body, signature, endpointSecret);
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
        await recordFailedSession(db, event.data.object);
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
// Called by the payment success page. This endpoint is read-only: Stripe's
// webhook is the sole authority that may mark an appointment as paid.
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
      if (
        !appointmentId ||
        session.metadata?.customerId !== req.user.id
      ) {
        return res.status(404).json({
          success: false,
          message: "Payment session not found.",
        });
      }
      const appointment = await db.collection("appointments").findOne({
        _id: appointmentId,
        customerId: req.user.id,
      });
      if (!appointment) {
        return res.status(404).json({
          success: false,
          message: "Payment session not found.",
        });
      }

      return res.json({
        success: true,
        data: {
          paymentStatus: session.payment_status,
          appointmentPaymentStatus: appointment.paymentStatus,
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
