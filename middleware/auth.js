const jwt = require("jsonwebtoken");

module.exports = function (req, res, next) {
  // Get the full header value
  const authHeader = req.header("Authorization");

  // Check if header exists and starts with "Bearer "
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ msg: "No token or malformed token, authorization denied" });
  }

  try {
    const token = authHeader.split(' ')[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded.user;
    next();
  } catch (err) {
    res.status(401).json({ msg: "Token is not valid" });
  }
};