import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/requireAuth.js";

// --------------------------------------------------
// PROFILE IMAGE UPLOAD (authenticated) -> ImgBB
// --------------------------------------------------
// Uploads are proxied server-side to ImgBB so the API key never reaches
// the browser. Returns the hosted image URL to store in user.image.

const router = Router();

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(
        new Error("Only JPG, PNG, WEBP or GIF images are allowed."),
        false
      );
    }
    cb(null, true);
  },
});

router.post("/", requireAuth, upload.single("image"), async (req, res) => {
  try {
    if (!process.env.IMGBB_API_KEY) {
      return res.status(503).json({
        success: false,
        message: "Image hosting is not configured on the server (IMGBB_API_KEY).",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No image file provided. Use the 'image' form field.",
      });
    }

    const base64 = req.file.buffer.toString("base64");

    const form = new FormData();
    form.append("key", process.env.IMGBB_API_KEY);
    form.append("image", base64);

    const response = await fetch("https://api.imgbb.com/1/upload", {
      method: "POST",
      body: form,
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.data?.url) {
      console.error("ImgBB upload failed:", response.status, data);
      return res.status(502).json({
        success: false,
        message: "Image upload failed. Please try again later.",
      });
    }

    return res.status(200).json({
      success: true,
      url: data.data.url,
    });
  } catch (error) {
    console.error("Upload error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error while uploading the image.",
    });
  }
});

// Multer / file-filter error handler for this route only.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "Image is too large. Maximum size is 5 MB."
        : `Upload failed: ${err.message}`;
    return res.status(400).json({ success: false, message });
  }
  if (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
  next();
});

export default router;
