import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

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

    const services = await db
      .collection("services")
      .find(
        {
          status: "active",
        },
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
      .sort({
        featuredOrder: 1,
        createdAt: -1,
      })
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
    return res.status(400).json({ success: false, message: "The service ID is not valid." });
  }

  try {
    const db = getDb();
    if (!db) {
      return res.status(503).json({ success: false, message: "Service temporarily unavailable: database is not connected." });
    }
    const service = await db.collection("services").findOne(
      { _id: new ObjectId(id) },
      { projection: { serviceName: 1, slug: 1, category: 1, description: 1, image: 1, price: 1, duration: 1, status: 1, createdAt: 1, featuredOrder: 1 } },
    );
    if (!service) {
      return res.status(404).json({ success: false, message: "This service doesn't exist or was removed." });
    }
    return res.json({ success: true, message: "Service retrieved successfully.", data: service });
  } catch (error) {
    console.error("Service details fetch error:", error);
    return res.status(500).json({ success: false, message: "Internal server error while retrieving service." });
  }
});

export default router;
