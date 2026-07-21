// Minimal validator for the flat {type, required, properties: {key: {type}}} shape every
// seeded object_type uses (see db/seed/001_object_types.sql). Closes the gap flagged in
// PHASE0_REVIEW.md: property_schema was stored but nothing validated writes against it. Not a
// general JSON Schema implementation — deliberately just enough for this ontology's shapes.
export type PropertySchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, { type?: string; format?: string }>;
};

export function validateProperties(schema: PropertySchema, properties: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const key of schema.required ?? []) {
    const value = properties[key];
    if (value === undefined || value === null || value === "") {
      errors.push(`missing required property "${key}"`);
    }
  }
  const propDefs = schema.properties ?? {};
  for (const [key, value] of Object.entries(properties)) {
    const def = propDefs[key];
    if (!def || value === undefined || value === null || value === "") continue;
    if (def.type === "string" && typeof value !== "string") {
      errors.push(`property "${key}" must be a string`);
    }
  }
  return errors;
}
