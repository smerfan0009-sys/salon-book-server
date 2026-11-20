import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import { requireAdmin, requireAuth } from "../middleware/requireAuth.js";

const router = Router();

// Every route in this file requires an authenticated admin.
router.use(requireAuth, requireAdmin);

function getUserFilter(id) {
  if (typeof id !== "string" || !id.trim()) return null;

  const filters = [{ _id: id }];

  if (/^[a-f\d]{24}$/i.test(id)) {
    filters.push({ _id: new ObjectId(id) });
  }

  return { $or: filters };
}

// --------------------------------------------------
// ADMIN DASHBOARD OVERVIEW
// GET /api/admin/overview
// --------------------------------------------------

router.get("/overview", async (req, res) => {
  try {
    const db = getDb();

    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected.",
      });
    }

    const users = db.collection("users");
    const appointments = db.collection("appointments");

    const [
      totalUsers,
      totalAppointments,
      pendingAppointments,
      confirmedAppointments,
      cancelledAppointments,
      blockedUsers,
    ] = await Promise.all([
      users.countDocuments({}),
      appointments.countDocuments({}),
      appointments.countDocuments({ status: "Pending" }),
      appointments.countDocuments({ status: "Confirmed" }),
      appointments.countDocuments({ status: "Cancelled" }),
      users.countDocuments({ isBlocked: true }),
    ]);

    return res.json({
      success: true,
      data: {
        totalUsers,
        totalAppointments,
        pendingAppointments,
        confirmedAppointments,
        cancelledAppointments,
        blockedUsers,
      },
    });
  } catch (error) {
    console.error("Admin overview error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load admin overview.",
    });
  }
});

// Existing, provider-created transaction documents only. This endpoint never
// changes payment state and intentionally returns an empty list when no
// payment integration has written records yet.
router.get("/transactions", async (_req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ success: false, message: "Database is not connected." });
    const transactions = await db.collection("transactions").find({}).sort({ createdAt: -1, transactionDate: -1 }).limit(500).toArray();
    return res.json({ success: true, count: transactions.length, data: transactions.map((transaction) => ({ ...transaction, _id: String(transaction._id), appointmentId: transaction.appointmentId ? String(transaction.appointmentId) : null, customerId: transaction.customerId ? String(transaction.customerId) : null })) });
  } catch (error) {
    console.error("Admin transactions error:", error);
    return res.status(500).json({ success: false, message: "Failed to load transactions." });
  }
});

// --------------------------------------------------
// GET ALL USERS
// GET /api/admin/users
// --------------------------------------------------

router.get("/users", async (req, res) => {
  try {
    const db = getDb();

    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected.",
      });
    }

    const users = await db
      .collection("users")
      .find(
        {},
        {
          projection: {
            name: 1,
            email: 1,
            image: 1,
            role: 1,
            isBlocked: 1,
            createdAt: 1,
          },
        },
      )
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();

    return res.json({
      success: true,
      count: users.length,
      data: users.map((user) => ({
        _id: String(user._id),
        name: user.name ?? "Unknown User",
        email: user.email ?? "",
        image: user.image ?? null,
        role: user.role ?? "customer",
        isBlocked: user.isBlocked === true,
        createdAt: user.createdAt ?? null,
      })),
    });
  } catch (error) {
    console.error("Admin users error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load users.",
    });
  }
});

// --------------------------------------------------
// GET ALL APPOINTMENTS
// GET /api/admin/appointments
// --------------------------------------------------

router.get("/appointments", async (req, res) => {
  try {
    const db = getDb();

    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected.",
      });
    }

    const [appointments, users] = await Promise.all([
      db
        .collection("appointments")
        .find({})
        .sort({
          appointmentDate: 1,
          timeSlot: 1,
          createdAt: -1,
        })
        .limit(200)
        .toArray(),

      db
        .collection("users")
        .find(
          {},
          {
            projection: {
              name: 1,
              email: 1,
              image: 1,
            },
          },
        )
        .toArray(),
    ]);

    // Match appointment.customerId with the user's MongoDB _id.
    const userMap = new Map(
      users.map((user) => [
        String(user._id),
        {
          name: user.name ?? "Unknown User",
          email: user.email ?? "",
          image: user.image ?? null,
        },
      ]),
    );

    const data = appointments.map((appointment) => ({
      ...appointment,
      _id: String(appointment._id),
      serviceId: appointment.serviceId ? String(appointment.serviceId) : "",
      customer: userMap.get(String(appointment.customerId)) ?? {
        name: "Unknown User",
        email: "",
        image: null,
      },
    }));

    return res.json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("Admin appointments error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load appointments.",
    });
  }
});

// --------------------------------------------------
// BLOCK / UNBLOCK USER
// PATCH /api/admin/users/:id/block
// PATCH /api/admin/users/:id/unblock
// --------------------------------------------------

async function updateUserBlockStatus(req, res, shouldBlock) {
  try {
    const db = getDb();

    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected.",
      });
    }

    const filter = getUserFilter(req.params.id);

    if (!filter) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID.",
      });
    }

    const users = db.collection("users");
    const targetUser = await users.findOne(filter);

    if (!targetUser) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    // Never allow an admin to block another admin.
    if (targetUser.role === "admin") {
      return res.status(403).json({
        success: false,
        message: "Admin accounts cannot be blocked.",
      });
    }

    // Prevent an admin from blocking their own account.
    if (String(targetUser._id) === String(req.user.id)) {
      return res.status(403).json({
        success: false,
        message: "You cannot block your own account.",
      });
    }

    if (shouldBlock) {
      const reason =
        typeof req.body?.reason === "string" &&
        req.body.reason.trim().length > 0
          ? req.body.reason.trim().slice(0, 500)
          : "Blocked by admin";

      await users.updateOne(
        { _id: targetUser._id },
        {
          $set: {
            isBlocked: true,
            banReason: reason,
            updatedAt: new Date(),
          },
          $unset: {
            banExpires: "",
          },
        },
      );
    } else {
      await users.updateOne(
        { _id: targetUser._id },
        {
          $set: {
            isBlocked: false,
            updatedAt: new Date(),
          },
          $unset: {
            banReason: "",
            banExpires: "",
          },
        },
      );
    }

    return res.json({
      success: true,
      message: shouldBlock
        ? "User blocked successfully."
        : "User unblocked successfully.",
      data: {
        _id: String(targetUser._id),
        isBlocked: shouldBlock,
      },
    });
  } catch (error) {
    console.error("Admin user block status error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update user status.",
    });
  }
}

router.patch("/users/:id/block", (req, res) =>
  updateUserBlockStatus(req, res, true),
);

router.patch("/users/:id/unblock", (req, res) =>
  updateUserBlockStatus(req, res, false),
);

export default router;
