import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/requireAuth.js";

const router = Router();

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function createSlug(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseFinitePositiveNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (
    typeof value !== "string" ||
    !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --------------------------------------------------
// GET SERVICE CATEGORIES (PUBLIC)
// --------------------------------------------------

router.get("/categories", async (req, res) => {
  try {
    const db = getDb();

    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Service temporarily unavailable: database is not connected.",
      });
    }

    const pipeline = [
      {
        $match: {
          status: "active",
          category: {
            $type: "string",
            $ne: "",
          },
        },
      },
      {
        $addFields: {
          normalizedCategory: {
            $trim: {
              input: "$category",
            },
          },
        },
      },
      {
        $match: {
          normalizedCategory: {
            $ne: "",
          },
        },
      },
      {
        $sort: {
          normalizedCategory: 1,
          featuredOrder: 1,
          createdAt: -1,
          _id: 1,
        },
      },
      {
        $group: {
          _id: "$normalizedCategory",
          serviceCount: {
            $sum: 1,
          },
          image: {
            $first: "$image",
          },
          description: {
            $first: "$description",
          },
        },
      },
      {
        $project: {
          _id: 0,
          name: "$_id",
          image: 1,
          description: 1,
          serviceCount: 1,
        },
      },
      {
        $sort: {
          name: 1,
        },
      },
    ];

    const categories = await db
      .collection("services")
      .aggregate(pipeline)
      .toArray();

    const data = categories.map((category) => ({
      ...category,
      slug: createSlug(category.name),
    }));

    return res.status(200).json({
      success: true,
      message: "Service categories retrieved successfully.",
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("Service categories fetch error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error while retrieving service categories.",
    });
  }
});

// --------------------------------------------------
// GET ALL ACTIVE SERVICES (PUBLIC)
// --------------------------------------------------

router.get("/", async (req, res) => {
  try {
    const db = getDb();

    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Service temporarily unavailable: database is not connected.",
      });
    }

    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const category =
      typeof req.query.category === "string" ? req.query.category.trim() : "";
    const sort = typeof req.query.sort === "string" ? req.query.sort : "";
    const filter = { status: "active" };
    if (query) filter.serviceName = { $regex: escapeRegExp(query), $options: "i" };
    if (category) filter.category = { $regex: `^${escapeRegExp(category)}$`, $options: "i" };
    const order =
      sort === "price_asc"
        ? { price: 1, serviceName: 1 }
        : sort === "price_desc"
          ? { price: -1, serviceName: 1 }
          : { featuredOrder: 1, createdAt: -1 };

    const services = await db
      .collection("services")
      .find(
        filter,
        {
          projection: {
            serviceName: 1,
            slug: 1,
            category: 1,
            description: 1,
            image: 1,
            price: 1,
            duration: 1,
            status: 1,
            createdAt: 1,
            featuredOrder: 1,
          },
        },
      )
      .sort(order)
      .toArray();

    return res.status(200).json({
      success: true,
      message: "Services retrieved successfully.",
      count: services.length,
      data: services,
    });
  } catch (error) {
    console.error("Services fetch error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error while retrieving services.",
    });
  }
});

// Protected details endpoint. Inactive services remain visible to signed-in
// users, but appointment creation separately requires an active service.
router.get("/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!/^[a-f\d]{24}$/i.test(id)) {
    return res
      .status(400)
      .json({ success: false, message: "The service ID is not valid." });
  }

  try {
    const db = getDb();
    if (!db) {
      return res
        .status(503)
        .json({
          success: false,
          message:
            "Service temporarily unavailable: database is not connected.",
        });
    }
    const service = await db
      .collection("services")
      .findOne(
        { _id: new ObjectId(id) },
        {
          projection: {
            serviceName: 1,
            slug: 1,
            category: 1,
            description: 1,
            image: 1,
            price: 1,
            duration: 1,
            status: 1,
            createdAt: 1,
            featuredOrder: 1,
          },
        },
      );
    if (!service) {
      return res
        .status(404)
        .json({
          success: false,
          message: "This service doesn't exist or was removed.",
        });
    }
    return res.json({
      success: true,
      message: "Service retrieved successfully.",
      data: service,
    });
  } catch (error) {
    console.error("Service details fetch error:", error);
    return res
      .status(500)
      .json({
        success: false,
        message: "Internal server error while retrieving service.",
      });
  }
});

// Service administration is kept alongside the public catalogue so service
// validation has a single source of truth. These routes are deliberately
// registered after the public detail route and use an explicit /manage path.
function normalizeServiceInput(body = {}) {
  const serviceName =
    typeof body.serviceName === "string" ? body.serviceName.trim() : "";
  const category =
    typeof body.category === "string" ? body.category.trim() : "";
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  const image = typeof body.image === "string" ? body.image.trim() : "";
  const price = parseFinitePositiveNumber(body.price);
  const duration = parseFinitePositiveNumber(body.duration);
  const status =
    body.status === "inactive"
      ? "inactive"
      : body.status === "active"
        ? "active"
        : null;
  const slugSource =
    typeof body.slug === "string" && body.slug.trim() ? body.slug : serviceName;
  const slug = createSlug(slugSource);
  if (!serviceName || serviceName.length > 120)
    return {
      error: "Service name is required and must be 120 characters or fewer.",
    };
  if (!category || category.length > 80)
    return {
      error: "Category is required and must be 80 characters or fewer.",
    };
  if (!description || description.length > 2000)
    return {
      error: "Description is required and must be 2,000 characters or fewer.",
    };
  if (price === null)
    return { error: "Price must be a finite number greater than zero." };
  if (!Number.isInteger(duration) || duration < 5 || duration > 1440)
    return { error: "Duration must be between 5 and 1,440 minutes." };
  if (!slug) return { error: "A valid slug is required." };
  if (image && !/^https?:\/\//i.test(image))
    return { error: "Service image must be a valid URL." };
  return {
    value: {
      serviceName,
      slug,
      category,
      description,
      image: image || null,
      price,
      duration,
      ...(status ? { status } : {}),
    },
  };
}

router.get("/manage/all", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const db = getDb();
    if (!db)
      return res
        .status(503)
        .json({ success: false, message: "Database is not connected." });
    const data = await db
      .collection("services")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    return res.json({
      success: true,
      count: data.length,
      data: data.map((service) => ({ ...service, _id: String(service._id) })),
    });
  } catch (error) {
    console.error("Admin services error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load services." });
  }
});

router.post("/manage", requireAuth, requireAdmin, async (req, res) => {
  try {
    const parsed = normalizeServiceInput(req.body);
    if (parsed.error)
      return res.status(400).json({ success: false, message: parsed.error });
    const db = getDb();
    if (!db)
      return res
        .status(503)
        .json({ success: false, message: "Database is not connected." });
    const duplicate = await db
      .collection("services")
      .findOne({ slug: parsed.value.slug });
    if (duplicate)
      return res
        .status(409)
        .json({
          success: false,
          message: "A service with this slug already exists.",
        });
    const now = new Date();
    const service = {
      ...parsed.value,
      status: parsed.value.status ?? "active",
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("services").insertOne(service);
    return res
      .status(201)
      .json({
        success: true,
        message: "Service created.",
        data: { ...service, _id: String(result.insertedId) },
      });
  } catch (error) {
    console.error("Create service error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to create service." });
  }
});

router.patch("/manage/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid service ID." });
    const parsed = normalizeServiceInput(req.body);
    if (parsed.error)
      return res.status(400).json({ success: false, message: parsed.error });
    const db = getDb();
    if (!db)
      return res
        .status(503)
        .json({ success: false, message: "Database is not connected." });
    const id = new ObjectId(req.params.id);
    const duplicate = await db
      .collection("services")
      .findOne({ slug: parsed.value.slug, _id: { $ne: id } });
    if (duplicate)
      return res
        .status(409)
        .json({
          success: false,
          message: "A service with this slug already exists.",
        });
    const result = await db
      .collection("services")
      .findOneAndUpdate(
        { _id: id },
        { $set: { ...parsed.value, updatedAt: new Date() } },
        { returnDocument: "after" },
      );
    if (!result)
      return res
        .status(404)
        .json({ success: false, message: "Service not found." });
    return res.json({
      success: true,
      message: "Service updated.",
      data: { ...result, _id: String(result._id) },
    });
  } catch (error) {
    console.error("Update service error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update service." });
  }
});

router.patch(
  "/manage/:id/status",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    if (
      !/^[a-f\d]{24}$/i.test(req.params.id) ||
      !["active", "inactive"].includes(req.body?.status)
    )
      return res
        .status(400)
        .json({
          success: false,
          message: "Provide a valid service ID and status.",
        });
    try {
      const db = getDb();
      if (!db)
        return res
          .status(503)
          .json({ success: false, message: "Database is not connected." });
      const result = await db
        .collection("services")
        .findOneAndUpdate(
          { _id: new ObjectId(req.params.id) },
          { $set: { status: req.body.status, updatedAt: new Date() } },
          { returnDocument: "after" },
        );
      if (!result)
        return res
          .status(404)
          .json({ success: false, message: "Service not found." });
      return res.json({
        success: true,
        message: `Service ${req.body.status === "active" ? "activated" : "deactivated"}.`,
        data: { ...result, _id: String(result._id) },
      });
    } catch (error) {
      console.error("Service status error:", error);
      return res
        .status(500)
        .json({ success: false, message: "Failed to update service status." });
    }
  },
);

router.delete("/manage/:id", requireAuth, requireAdmin, async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid service ID.",
    });
  }

  try {
    const db = getDb();

    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected.",
      });
    }

    const id = new ObjectId(req.params.id);

    // Check whether service exists
    const service = await db.collection("services").findOne({
      _id: id,
    });

    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Service not found.",
      });
    }

    // Never erase appointment history as a side effect of service management.
    // Services with history can be deactivated through the status endpoint.
    const appointmentCount = await db.collection("appointments").countDocuments({
      serviceId: id,
    });
    if (appointmentCount > 0) {
      return res.status(409).json({
        success: false,
        message:
          "This service has appointment history and cannot be deleted. Deactivate it instead.",
      });
    }

    // Delete the service
    const serviceResult = await db.collection("services").deleteOne({
      _id: id,
    });

    if (!serviceResult.deletedCount) {
      return res.status(500).json({
        success: false,
        message: "Failed to delete service.",
      });
    }

    return res.json({
      success: true,
      message: "Service deleted successfully.",
    });
  } catch (error) {
    console.error("Delete service error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete service and related appointments.",
    });
  }
});

export default router;
