import fs from "node:fs";
import path from "node:path";
import multer from "multer";

import { config } from "./config.js";

const tmpDir = path.join(process.cwd(), "uploads", "tmp");
fs.mkdirSync(tmpDir, { recursive: true });

export const packUpload = multer({
  dest: tmpDir,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    if (!/\.mrpack$/i.test(file.originalname)) {
      cb(new Error("Only a .mrpack file can be imported."));
      return;
    }
    cb(null, true);
  },
}).single("pack");

export function receivePackUpload(req, res) {
  return new Promise((resolve, reject) => {
    packUpload(req, res, (err) => (err ? reject(err) : resolve()));
  });
}
