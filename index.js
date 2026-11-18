import express from "express";
import "dotenv/config";

const PORT = process.env.PORT || 5000;


async function startServer() {
  try {
    await connectToMongoDB();
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    console.error("Starting the server without a database connection.");
  }

  app.listen(PORT, () => {
    console.log(`Salon Book server is running at http://localhost:${PORT}`);
  });
}

startServer();

export default app;
