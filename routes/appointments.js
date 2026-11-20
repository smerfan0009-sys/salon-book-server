import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import {
  requireAdmin,
  requireAuth,
  requireCustomer,
} from "../middleware/requireAuth.js";

const router = Router();
const ACTIVE_APPOINTMENT_STATUSES = ["Pending", "Confirmed"];
const TIME_SLOTS = new Set([
  "10:00",
  "10:30",
  "11:00",
  "11:30",
  "12:00",
  "12:30",
  "13:00",
  "13:30",
  "14:00",
  "14:30",
  "15:00",
  "15:30",
  "16:00",
  "16:30",
  "17:00",
  "17:30",
  "18:00",
  "18:30",
  "19:00",
  "19:30",
]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

function badRequest(res, message) {
  return res.status(400).json({ success: false, message });
}

function getAppointmentId(value) {
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value)
    ? new ObjectId(value)
    : null;
}

function isFutureOrToday(date) {
  if (!DATE_PATTERN.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === date &&
    date >= new Date().toISOString().slice(0, 10)
  );
}

export async function ensureAppointmentIndexes() {
  const db = getDb();
  if (!db) return;

  await db.collection("appointments").createIndex(
    { serviceId: 1, appointmentDate: 1, timeSlot: 1 },
    {
      name: "unique_active_service_slot",
      unique: true,
      partialFilterExpression: { status: { $in: ACTIVE_APPOINTMENT_STATUSES } },
    },
  );
  await db
    .collection("appointments")
    .createIndex(
      { customerId: 1, createdAt: -1 },
      { name: "customer_appointments" },
    );
}

// Get logged-in customer's appointments
router.get("/", requireAuth, requireCustomer, async (req, res) => {
  try {
    const db = getDb();

    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected.",
      });
    }

    const appointments = await db
      .collection("appointments")
      .find({
        customerId: req.user.id,
      })
      .sort({
        appointmentDate: 1,
        timeSlot: 1,
        createdAt: -1,
      })
      .toArray();

    return res.status(200).json({
      success: true,
      count: appointments.length,
      data: appointments.map((appointment) => ({
        ...appointment,
        _id: appointment._id.toString(),
        serviceId: appointment.serviceId.toString(),
      })),
    });
  } catch (error) {
    console.error("Fetch customer appointments error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error while fetching appointments.",
    });
  }
});

// Customer appointment request. Defaults are intentionally set server-side.
router.post("/", requireAuth, requireCustomer, async (req, res) => {
  try {
    const {
      serviceId,
      appointmentDate,
      timeSlot,
      additionalMessage,
      date,
      time,
      notes,
    } = req.body ?? {};
    const requestedDate = appointmentDate ?? date;
    const requestedTime = timeSlot ?? time;
    const message = additionalMessage ?? notes;
    const parsedServiceId = getAppointmentId(serviceId);

    if (!parsedServiceId)
      return badRequest(res, "A valid service ID is required.");
    if (typeof requestedDate !== "string" || !isFutureOrToday(requestedDate)) {
      return badRequest(
        res,
        "Choose a valid appointment date that is not in the past.",
      );
    }
    if (typeof requestedTime !== "string" || !TIME_SLOTS.has(requestedTime)) {
      return badRequest(res, "Choose an available time slot.");
    }
    if (
      message !== undefined &&
      (typeof message !== "string" || message.trim().length > 300)
    ) {
      return badRequest(
        res,
        "Additional message must be 300 characters or fewer.",
      );
    }

    const db = getDb();
    if (!db)
      return res
        .status(503)
        .json({
          success: false,
          message:
            "Service temporarily unavailable: database is not connected.",
        });

    const service = await db
      .collection("services")
      .findOne(
        { _id: parsedServiceId, status: "active" },
        { projection: { serviceName: 1, price: 1, duration: 1 } },
      );
    if (!service) {
      return res
        .status(409)
        .json({
          success: false,
          message:
            "This service is inactive or no longer available for booking.",
        });
    }

    const now = new Date();
    const appointment = {
      customerId: req.user.id,
      serviceId: parsedServiceId,
      serviceName: service.serviceName ?? "Salon Service",
      appointmentDate: requestedDate,
      timeSlot: requestedTime,
      additionalMessage: typeof message === "string" ? message.trim() : "",
      status: "Pending",
      paymentStatus: "Unpaid",
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection("appointments").insertOne(appointment);
    return res.status(201).json({
      success: true,
      message: "Appointment request submitted successfully.",
      data: { ...appointment, _id: result.insertedId },
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res
        .status(409)
        .json({
          success: false,
          message:
            "That time slot is already booked for this service. Please choose another slot.",
        });
    }
    console.error("Appointment creation error:", error);
    return res
      .status(500)
      .json({
        success: false,
        message: "Internal server error while creating appointment.",
      });
  }
});

// Customers may only cancel their own pending requests.
router.patch("/:id/cancel", requireAuth, requireCustomer, async (req, res) => {
  try {
    const appointmentId = getAppointmentId(req.params.id);
    if (!appointmentId) return badRequest(res, "Invalid appointment ID.");
    const result = await getDb()
      .collection("appointments")
      .findOneAndUpdate(
        { _id: appointmentId, customerId: req.user.id, status: "Pending" },
        {
          $set: {
            status: "Cancelled",
            updatedAt: new Date(),
            cancelledAt: new Date(),
            cancelledBy: req.user.id,
          },
        },
        { returnDocument: "after" },
      );
    if (!result)
      return res
        .status(403)
        .json({
          success: false,
          message:
            "Only your own pending appointment requests can be cancelled.",
        });
    return res.json({
      success: true,
      message: "Appointment request cancelled.",
      data: result,
    });
  } catch (error) {
    console.error("Customer appointment cancellation error:", error);
    return res
      .status(500)
      .json({
        success: false,
        message: "Internal server error while cancelling appointment.",
      });
  }
});

// Admins can confirm or cancel requests; customer ownership is never accepted from the client.
router.patch("/:id/status", requireAuth, requireAdmin, async (req, res) => {
  try {
    const appointmentId = getAppointmentId(req.params.id);
    const { status } = req.body ?? {};
    if (!appointmentId) return badRequest(res, "Invalid appointment ID.");
    if (!["Confirmed", "Cancelled"].includes(status)) {
      return badRequest(
        res,
        "Appointment status must be Confirmed or Cancelled.",
      );
    }
    const result = await getDb()
      .collection("appointments")
      .findOneAndUpdate(
        { _id: appointmentId, status: "Pending" },
        {
          $set: {
            status,
            updatedAt: new Date(),
            [status === "Cancelled" ? "cancelledAt" : "confirmedAt"]:
              new Date(),
            [status === "Cancelled" ? "cancelledBy" : "confirmedBy"]:
              req.user.id,
          },
        },
        { returnDocument: "after" },
      );
    if (!result)
      return res
        .status(409)
        .json({
          success: false,
          message: "Only pending appointment requests can be updated.",
        });
    return res.json({
      success: true,
      message: `Appointment ${status.toLowerCase()}.`,
      data: result,
    });
  } catch (error) {
    console.error("Admin appointment status error:", error);
    return res
      .status(500)
      .json({
        success: false,
        message: "Internal server error while updating appointment.",
      });
  }
});

export default router;
