// Vercel serverless function: POST /api/systemone -> TypeSafe /v1/systemone
import { forwardToTypeSafe, keyFromAuthorization, readJsonBody, validateJson, writeResult, jsonResult } from "../lib/typesafe.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    writeResult(res, jsonResult(405, { detail: { error_type: "method_not_allowed", message: "Use POST." } }));
    return;
  }
  const body = await readJsonBody(req);
  const invalid = validateJson(body);
  if (invalid) {
    writeResult(res, invalid);
    return;
  }
  const result = await forwardToTypeSafe({
    path: "/v1/systemone",
    method: "POST",
    key: keyFromAuthorization(req.headers.authorization),
    body,
  });
  writeResult(res, result);
}
