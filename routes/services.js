import { Router } from "express";
import { getDb } from "../db.js";

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
          isActive: true,
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
            $first: {
              $ifNull: ["$shortDescription", "$description"],
            },
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
          isActive: true,
        },
        {
          projection: {
            name: 1,
            slug: 1,
            category: 1,
            image: 1,
            shortDescription: 1,
            price: 1,
            duration: 1,
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

export default router;
