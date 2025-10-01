const express = require("express");
const auth = require("../middleware/auth");
const Message = require("../models/Message");
const path = require("path");
const axios = require("axios");
const router = express.Router();

// Get all messages for user
router.get("/", auth, async (req, res) => {
  try {
    const messages = await Message.find({ 
      type: "media"
    })
    .sort({ date: -1 })
    .populate("userId", "name email");

    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// Download media
router.get("/download/:id", auth, async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);
    if (!message || message.type !== "media") {
      return res.status(404).json({ msg: "Media not found" });
    }

    res.download(path.resolve(message.path), message.fileName);
  } catch (err) {
    res.status(500).send("Server error");
  }
});

router.post("/analyze", auth, async (req, res) => {
  try {
    const messages = await Message.find({ userId: req.user.id, type: "text" }).sort({ date: -1 });

    if (!messages.length) {
      return res.status(404).json({ msg: "No text messages found" });
    }

    const analyzed = [];
    for (let msg of messages) {
      // Skip if already analyzed
      if (msg.analysis && msg.analysis.summary) {
        analyzed.push(msg);
        continue;
      }

      // Call KMRL API
      const response = await axios.post(
        "https://sripriya16-kmrl-document-analyzer.hf.space/api/predict",
        { data: [msg.body] }
      );

      // Example: extract relevant fields
      const apiData = response.data;
      msg.analysis = {
        isRelevant: apiData?.data?.includes("Relevant") || false,
        summary: apiData?.data?.[1] || "",
        raw: apiData
      };

      await msg.save();
      analyzed.push(msg);
    }

    res.json(analyzed);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

router.get("/search", auth, async (req, res) => {
  try {
    const { q, type, date } = req.query;
    
    let query = { type: "media" };

    if (q) {
      query.$text = { $search: q };
    }

    if (type && type !== 'all') {
      query.mimeType = { $regex: type, $options: 'i' };
    }
    
    if (date && date !== 'alltime') {
      const startDate = new Date();
      if (date === 'today') startDate.setHours(0, 0, 0, 0);
      else if (date === 'thisweek') startDate.setDate(startDate.getDate() - 7);
      else if (date === 'thismonth') startDate.setMonth(startDate.getMonth() - 1);
      else if (date === 'thisyear') startDate.setFullYear(startDate.getFullYear() - 1);
      query.date = { $gte: startDate };
    }

    // --- START OF THE FIX ---
    // First, create the base query
    let findQuery = Message.find(query);

    // Conditionally add the sort
    if (q) {
      // If a search term exists, sort by relevance
      findQuery = findQuery.sort({ score: { $meta: "textScore" } });
    } else {
      // Otherwise, sort by the most recent date
      findQuery = findQuery.sort({ date: -1 });
    }
    
    // Finally, add populate and execute the fully built query
    const messages = await findQuery.populate("userId", "name");
    // --- END OF THE FIX ---

    res.json(messages);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});
module.exports = router;
