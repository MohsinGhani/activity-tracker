import { auth } from "./firebase.js";
import { firebaseConfig, s3Config } from "./config.js";

// Uploads { thumb, std, full } WebP blobs to S3 through the main process and
// returns the fields saved on the Firestore screenshot record.
export async function uploadScreenshot(versions) {
  const user = auth.currentUser;
  if (!user) throw new Error("Upload failed: not signed in");

  const idToken = await user.getIdToken();
  const files = await Promise.all(
    Object.entries(versions).map(async ([version, blob]) => ({
      version,
      bytes: new Uint8Array(await blob.arrayBuffer()),
    })),
  );

  const { s3Path } = await window.tracker.uploadScreenshot({
    ...s3Config,
    projectId: firebaseConfig.projectId,
    idToken,
    files,
  });
  return { storage: "s3", s3Path };
}
