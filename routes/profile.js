import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

function userFilter(id) {
  return /^[a-f\d]{24}$/i.test(id) ? { _id: new ObjectId(id) } : { _id: id };
}

function publicProfile(user) {
  return {
    _id: String(user._id),
    name: user.name ?? "",
    email: user.email ?? "",
    image: user.image ?? null,
    role: user.role ?? "customer",
    createdAt: user.createdAt ?? null,
  };
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ success: false, message: "Database is not connected." });
    const user = await db.collection("users").findOne(userFilter(req.user.id));
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    return res.json({ success: true, data: publicProfile(user) });
  } catch (error) {
    console.error("Profile fetch error:", error);
    return res.status(500).json({ success: false, message: "Failed to load profile." });
  }
});

router.patch("/", requireAuth, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const image = typeof req.body?.image === "string" ? req.body.image.trim() : "";
  if (!name || name.length > 100) return res.status(400).json({ success: false, message: "Name is required and must be 100 characters or fewer." });
  if (image && !/^https?:\/\//i.test(image)) return res.status(400).json({ success: false, message: "Profile image must be a valid URL." });
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ success: false, message: "Database is not connected." });
    const user = await db.collection("users").findOneAndUpdate(userFilter(req.user.id), { $set: { name, image: image || null, updatedAt: new Date() } }, { returnDocument: "after" });
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    return res.json({ success: true, message: "Profile updated.", data: publicProfile(user) });
  } catch (error) {
    console.error("Profile update error:", error);
    return res.status(500).json({ success: false, message: "Failed to update profile." });
  }
});

export default router;
