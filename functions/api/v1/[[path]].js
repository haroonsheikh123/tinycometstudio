/* /api/v1/* — the Control API (see docs/API.md and /api/v1/openapi.json). */
import { handleApi } from "../../../lib/admin/api.js";

export const onRequest = (context) => handleApi(context);
