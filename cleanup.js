const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Message = require("./models/Message"); // Adjust path if needed

// Connect to your MongoDB
mongoose.connect("mongodb+srv://vidushiagg:vidushi%40123@atlascluster.metohzo.mongodb.net/kmrl?retryWrites=true&w=majority", {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

async function cleanupIrrelevantMessages() {
  try {
    // Find messages where analysis.isRelevant is false, null, or missing
    const messages = await Message.find({
  $or: [
    { "analysis.isRelevant": false },       // explicitly marked irrelevant
    { "analysis.isRelevant": null },        // null
    { analysis: { $exists: false } },       // text messages or missing analysis
  ],
});

    console.log(`Found ${messages.length} irrelevant messages.`);

    for (const msg of messages) {
      // Delete file if it's media
      if (msg.type === "media" && msg.path && fs.existsSync(msg.path)) {
        fs.unlinkSync(msg.path);
        console.log(`Deleted file: ${msg.fileName}`);
      }

      // Delete message from DB
      await Message.findByIdAndDelete(msg._id);
      console.log(`Deleted message ID: ${msg._id}`);
    }

    console.log("✅ Cleanup complete.");
    process.exit(0);
  } catch (err) {
    console.error("Cleanup failed:", err);
    process.exit(1);
  }
}

cleanupIrrelevantMessages();
