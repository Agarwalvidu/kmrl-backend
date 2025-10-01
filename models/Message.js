const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  from: String,            // sender ID
  type: String,            // text | media
  body: String,            // text content (if text message)
  fileName: String,        // for media
  mimeType: String,        // for media
  path: String,            // file storage path
  fileSize: { type: Number, default: 0 }, // ADDED: To store the file size
  tags: [{ type: String }], 
  date: { type: Date, default: Date.now },
  analysis: {
    isRelevant: { type: Boolean, default: null },
    summary: { type: String, default: "" },
    raw: mongoose.Schema.Types.Mixed   // store full API response
  },
  
});

messageSchema.index({ 
  fileName: 'text', 
  'analysis.summary': 'text' 
});

module.exports = mongoose.model("Message", messageSchema);
