import SwaggerParser from "@apidevtools/swagger-parser";
import { resolve } from "node:path";

const file = resolve("openapi/cubus-collab-actions.yaml");
await SwaggerParser.validate(file);
console.log(`OpenAPI document is valid: ${file}`);

