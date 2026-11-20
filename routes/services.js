import { Router } from "express";
import { getDb } from "../db.js";

const router = Router();

const FEATURED_SERVICES_LIMIT = 6;

// --------------------------------------------------
// GET FEATURED SERVICES (PUBLIC)
// --------------------------------------------------
// Returns up to six active services ordered by their featured position.
// No authentication is required because the Home Page is public.

router.get("/featured", async (req, res) => {
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
        { isActive: true },
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
        }
      )
      .sort({ featuredOrder: 1, createdAt: -1 })
      .limit(FEATURED_SERVICES_LIMIT)
      .toArray();

    return res.status(200).json({
      success: true,
      message: "Featured services retrieved successfully.",
      count: services.length,
      data: services,
    });
  } catch (error) {
    console.error("Featured services fetch error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error while retrieving featured services.",
    });
  }
});

export default router;
