import express from "express";
import { listReleases } from "../controllers/listReleases.js";

const router = express.Router();

router.get("/", listReleases);

export default router;
