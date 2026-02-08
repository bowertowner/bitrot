import dotenv from "dotenv";
dotenv.config(); // loads backend/.env when you run `npm start` from backend/

// Print a safe “loaded/not loaded” indicator (no full token in logs)
const token = process.env.DISCOGS_TOKEN;
console.log(
  `[ENV] DISCOGS_TOKEN: ${token ? "LOADED (" + token.slice(0, 6) + "…)" : "MISSING"}`
);

import app from "./app.js";

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Bitrot backend running on port ${PORT}`);
});
