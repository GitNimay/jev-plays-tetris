// Vercel serverless function: GET /api/models -> TypeSafe /v1/models (key check)
import { forwardToTypeSafe, keyFromAuthorization, writeResult } from "../lib/typesafe.mjs";

export default async function handler(req, res) {
  const result = await forwardToTypeSafe({
    path: "/v1/models",
    method: "GET",
    key: keyFromAuthorization(req.headers.authorization),
  });
  writeResult(res, result);
}
