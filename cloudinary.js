import { cloudinaryConfig } from "./config.js";

const CLOUD_NAME = cloudinaryConfig.cloudName;
const UPLOAD_PRESET = cloudinaryConfig.uploadPreset;

export async function uploadScreenshot(base64DataUrl) {
  const endpoint = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`;

  const body = new FormData();
  body.append("file", base64DataUrl);
  body.append("upload_preset", UPLOAD_PRESET);

  const response = await fetch(endpoint, { method: "POST", body });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Cloudinary upload failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return data.secure_url;
}
