import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";

process.env.STRIPE_SECRET_KEY = "sk_test_dummy";

const { allowedAdminCurrentStatuses } = await import(
  "../routes/appointments.js"
);
const { verifyStripeWebhookEvent } = await import("../routes/payments.js");

test("admin appointment transitions allow only the required current states", () => {
  assert.deepEqual(allowedAdminCurrentStatuses("Confirmed"), ["Pending"]);
  assert.deepEqual(allowedAdminCurrentStatuses("Cancelled"), [
    "Pending",
    "Confirmed",
  ]);
  assert.equal(allowedAdminCurrentStatuses("Completed"), null);
  assert.equal(allowedAdminCurrentStatuses("Paid"), null);
});

test("webhook verification accepts a valid dummy Stripe signature", () => {
  const secret = "whsec_dummy_test_secret";
  const payload = JSON.stringify({
    id: "evt_test",
    type: "checkout.session.completed",
    data: { object: { id: "cs_test", payment_status: "paid" } },
  });
  const stripe = new Stripe("sk_test_dummy", { apiVersion: "2024-12-18.acacia" });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
  });

  const event = verifyStripeWebhookEvent(Buffer.from(payload), signature, secret);
  assert.equal(event.id, "evt_test");
  assert.equal(event.type, "checkout.session.completed");
  assert.throws(
    () => verifyStripeWebhookEvent(Buffer.from(payload), "bad-signature", secret),
  );
});
